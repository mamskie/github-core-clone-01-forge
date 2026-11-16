// GraphQL v4 executor for the make.fun forge (POST /api/graphql).
// Node 22 TypeScript, stdlib only, no deps, no clock, no randomness.
// Pragmatic executor: a small recursive-descent parser for the documents
// the suite sends (variables, aliases, inline fragments, enums, input
// objects, lists, batched arrays) plus schema validation and resolvers
// over the shared store (ctx.store), so mutations are visible over REST.
import { Buffer } from 'node:buffer';

const FIXED_ISO = '2025-01-01T00:00:00Z';

export async function handleGraphQL(
  method: string,
  path: string,
  _query: URLSearchParameters,
  headers: Record<string, string>,
  body: Buffer,
  ctx: any,
): Promise<{ status: number; headers: Record<string, string>; body: Buffer } | null> {
  if (path !== '/api/graphql') return null;
  if (method !== 'POST') return json(405, { message: 'Method Not Allowed' });
  if (!ctx || typeof ctx.authed !== 'function' || !ctx.authed(headers)) {
    return json(401, { message: 'Requires authentication' });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return json(400, { message: 'Request body must be valid JSON' });
  }
  if (Array.isArray(parsed)) {
    const out: unknown[] = [];
    for (const op of parsed) out.push(executeOperation(op, ctx));
    return json(200, out);
  }
  return json(200, executeOperation(parsed, ctx));
}

function json(status: number, value: unknown): { status: number; headers: Record<string, string>; body: Buffer } {
  return { status, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(value), 'utf8') };
}

// ---------------------------------------------------------------------------
// Global (Relay) ids: opaque base64, stable across reads, never the plain
// databaseId / number. Format: base64("<Type>:<identity>").
//   Repository: "Repository:<owner>/<name>"
//   Issue / PullRequest: "<Type>:<repo databaseId>:<number>"
//   IssueComment: "IssueComment:<repo databaseId>:<issue number>:<comment id>"
// ---------------------------------------------------------------------------

function b64e(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}
function b64d(text: string): string | null {
  try {
    const out = Buffer.from(text, 'base64').toString('utf8');
    return out === '' ? null : out;
  } catch {
    return null;
  }
}
function repoGlobalId(repo: any): string {
  return b64e(`Repository:${repo.owner}/${repo.name}`);
}
function issueGlobalId(repo: any, issue: any): string {
  return b64e(`Issue:${repo.id}:${issue.number}`);
}
function prGlobalId(repo: any, pr: any): string {
  return b64e(`PullRequest:${repo.id}:${pr.number}`);
}
function commentGlobalId(repo: any, issue: any, comment: any): string {
  return b64e(`IssueComment:${repo.id}:${issue.number}:${comment.id}`);
}
function decodeGlobalId(id: unknown): { type: string; rest: string } | null {
  if (typeof id !== 'string' || id === '') return null;
  const text = b64d(id);
  if (text === null) return null;
  const idx = text.indexOf(':');
  if (idx < 0) return null;
  return { type: text.slice(0, idx), rest: text.slice(idx + 1) };
}
function findRepoByDbId(store: any, dbId: string): any | null {
  for (const repo of store.repos.values()) {
    if (String(repo.id) === dbId) return repo;
  }
  return null;
}
/** Decode a cursor produced by this module: base64 of the last seen number. */
function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  const decoded = b64d(cursor);
  if (decoded !== null) {
    const n = parseInt(decoded, 10);
    if (Number.isFinite(n)) return n;
  }
  const n = parseInt(cursor, 10);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Lexer + parser (subset of GraphQL sufficient for the suite's documents)
// ---------------------------------------------------------------------------

interface Token {
  kind: 'name' | 'string' | 'int' | 'float' | 'punct';
  value: string;
  line: number;
  column: number;
}

function lex(src: string): Token[] {
  const toks: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const advance = (n = 1): void => {
    for (let k = 0; k < n && i < src.length; k += 1) {
      if (src[i] === '\n') {
        line += 1;
        col = 1;
      } else {
        col += 1;
      }
      i += 1;
    }
  };
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === ',') {
      advance();
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') advance();
      continue;
    }
    const startLine = line;
    const startCol = col;
    if (ch === '"') {
      if (src.startsWith('"""', i)) {
        const end = src.indexOf('"""', i + 3);
        const raw = end === -1 ? src.slice(i + 3) : src.slice(i + 3, end);
        const value = raw.replace(/^\r?\n/, '');
        advance(end === -1 ? src.length - i : end + 3 - i);
        toks.push({ kind: 'string', value, line: startLine, column: startCol });
        continue;
      }
      let j = i + 1;
      let value = '';
      let closed = false;
      while (j < src.length) {
        const c = src[j];
        if (c === '"') {
          closed = true;
          break;
        }
        if (c === '\\' && j + 1 < src.length) {
          const e = src[j + 1];
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };
          if (e === 'u' && j + 5 < src.length) {
            value += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            value += map[e] ?? e;
            j += 2;
          }
          continue;
        }
        value += c;
        j += 1;
      }
      if (!closed) throw new Error(`Unterminated string at line ${startLine}`);
      advance(j + 1 - i);
      toks.push({ kind: 'string', value, line: startLine, column: startCol });
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) throw new Error(`Bad number at line ${startLine}`);
      const text = m[0];
      advance(text.length);
      toks.push({ kind: text.includes('.') || /[eE]/.test(text) ? 'float' : 'int', value: text, line: startLine, column: startCol });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      const text = m![0];
      advance(text.length);
      toks.push({ kind: 'name', value: text, line: startLine, column: startCol });
      continue;
    }
    if (src.startsWith('...', i)) {
      advance(3);
      toks.push({ kind: 'punct', value: '...', line: startLine, column: startCol });
      continue;
    }
    if ('{}()[]:!=$@=|&'.includes(ch)) {
      advance();
      toks.push({ kind: 'punct', value: ch, line: startLine, column: startCol });
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(ch)} at line ${startLine}`);
  }
  return toks;
}

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: Record<string, ValueNode>;
  selections?: SelectionNode[];
  line: number;
  column: number;
}
interface FragmentNode {
  kind: 'fragment';
  typeCondition?: string;
  selections: SelectionNode[];
}
interface SpreadNode {
  kind: 'spread';
  name: string;
}
type SelectionNode = FieldNode | FragmentNode | SpreadNode;
interface Operation {
  kind: 'query' | 'mutation' | 'subscription';
  name?: string;
  selections: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly toks: Token[];
  readonly fragments = new Map<string, SelectionNode[]>();

  constructor(toks: Token[]) {
    this.toks = toks;
  }

  private peek(): Token | undefined {
    return this.toks[this.pos];
  }
  private next(): Token {
    const t = this.toks[this.pos];
    if (!t) throw new Error('Unexpected end of query');
    this.pos += 1;
    return t;
  }
  private isPunct(value: string): boolean {
    const t = this.peek();
    return t !== undefined && t.kind === 'punct' && t.value === value;
  }
  private expectPunct(value: string): Token {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) throw new Error(`Expected "${value}" at line ${t.line}, got ${JSON.stringify(t.value)}`);
    return t;
  }
  private isName(value: string): boolean {
    const t = this.peek();
    return t !== undefined && t.kind === 'name' && t.value === value;
  }
  private expectName(what = 'a name'): Token {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`Expected ${what} at line ${t.line}, got ${JSON.stringify(t.value)}`);
    return t;
  }

  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.peek() !== undefined) {
      const op = this.parseDefinition();
      if (op) ops.push(op);
    }
    if (ops.length === 0) throw new Error('Query document is empty');
    return ops;
  }

  private parseDefinition(): Operation | null {
    const t = this.peek()!;
    if (t.kind === 'punct' && t.value === '{') {
      return { kind: 'query', selections: this.parseSelectionSet() };
    }
    if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation' || t.value === 'subscription')) {
      const kind = this.next().value as Operation['kind'];
      let name: string | undefined;
      const n = this.peek();
      if (n && n.kind === 'name') name = this.next().value;
      if (this.isPunct('(')) this.parseVariableDefinitions();
      this.parseDirectives();
      return { kind, name, selections: this.parseSelectionSet() };
    }
    if (t.kind === 'name' && t.value === 'fragment') {
      this.next();
      const fragName = this.expectName('a fragment name').value;
      if (!this.isName('on')) throw new Error(`Expected "on" in fragment at line ${t.line}`);
      this.next();
      this.expectName('a type name');
      this.parseDirectives();
      this.fragments.set(fragName, this.parseSelectionSet());
      return null;
    }
    throw new Error(`Unexpected token ${JSON.stringify(t.value)} at line ${t.line}`);
  }

  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!this.isPunct(')')) {
      if (this.peek() === undefined) throw new Error('Unterminated variable definitions');
      this.expectPunct('$');
      this.expectName('a variable name');
      this.expectPunct(':');
      this.parseType();
      if (this.isPunct('=')) {
        this.next();
        this.parseValue();
      }
    }
    this.expectPunct(')');
  }

  private parseType(): void {
    if (this.isPunct('[')) {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName('a type name');
    }
    if (this.isPunct('!')) this.next();
  }

  private parseDirectives(): void {
    while (this.isPunct('@')) {
      this.next();
      this.expectName('a directive name');
      if (this.isPunct('(')) this.parseArguments();
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const sels: SelectionNode[] = [];
    while (!this.isPunct('}')) {
      if (this.peek() === undefined) throw new Error('Unterminated selection set');
      sels.push(this.parseSelection());
    }
    this.expectPunct('}');
    return sels;
  }

  private parseSelection(): SelectionNode {
    const t = this.peek()!;
    if (t.kind === 'punct' && t.value === '...') {
      this.next();
      const n = this.peek();
      if (n && n.kind === 'name' && n.value === 'on') {
        this.next();
        const typeCondition = this.expectName('a type name').value;
        this.parseDirectives();
        return { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (n && n.kind === 'name') {
        const name = this.next().value;
        this.parseDirectives();
        return { kind: 'spread', name };
      }
      this.parseDirectives();
      return { kind: 'fragment', selections: this.parseSelectionSet() };
    }
    const first = this.expectName('a field name');
    let alias: string | undefined;
    let name = first.value;
    if (this.isPunct(':')) {
      this.next();
      alias = name;
      name = this.expectName('a field name').value;
    }
    let args: Record<string, ValueNode> = {};
    if (this.isPunct('(')) args = this.parseArguments();
    this.parseDirectives();
    let selections: SelectionNode[] | undefined;
    if (this.isPunct('{')) selections = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selections, line: first.line, column: first.column };
  }

  private parseArguments(): Record<string, ValueNode> {
    const args: Record<string, ValueNode> = {};
    this.expectPunct('(');
    while (!this.isPunct(')')) {
      if (this.peek() === undefined) throw new Error('Unterminated arguments');
      const name = this.expectName('an argument name').value;
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') return { kind: 'variable', name: this.expectName('a variable name').value };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: parseInt(t.value, 10) };
    if (t.kind === 'float') return { kind: 'float', value: parseFloat(t.value) };
    if (t.kind === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (!this.isPunct(']')) {
        if (this.peek() === undefined) throw new Error('Unterminated list value');
        values.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.isPunct('}')) {
        if (this.peek() === undefined) throw new Error('Unterminated object value');
        const name = this.expectName('an object field name').value;
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`Unexpected value token ${JSON.stringify(t.value)} at line ${t.line}`);
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] === undefined ? null : variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = resolveValue(f.value, variables);
      return out;
    }
  }
}

function resolveArgs(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, node] of Object.entries(field.args)) out[name] = resolveValue(node, variables);
  return out;
}

// ---------------------------------------------------------------------------
// Schema surface (exactly the fields the spec lists) + validation
// ---------------------------------------------------------------------------

const SCHEMA: Record<string, Set<string>> = {
  Query: new Set(['viewer', 'repository', 'node', '__type']),
  Mutation: new Set(['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment']),
  User: new Set(['login']),
  Repository: new Set(['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest']),
  Issue: new Set(['id', 'number', 'title', 'state', 'body']),
  IssueConnection: new Set(['nodes', 'totalCount', 'pageInfo']),
  PullRequestConnection: new Set(['nodes', 'totalCount', 'pageInfo']),
  PullRequest: new Set(['id', 'number', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'title', 'body']),
  PullRequestChangedFileConnection: new Set(['nodes', 'totalCount', 'pageInfo']),
  PullRequestChangedFile: new Set(['path']),
  PageInfo: new Set(['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor']),
  Ref: new Set(['name']),
  __Type: new Set(['name', 'kind', 'fields', 'enumValues', 'description']),
  __Field: new Set(['name', 'description']),
  __EnumValue: new Set(['name', 'description']),
  Node: new Set(['id']),
  CommentEdge: new Set(['node', 'cursor']),
  Comment: new Set(['id', 'body']),
  CreateIssuePayload: new Set(['issue', 'clientMutationId']),
  CloseIssuePayload: new Set(['issue', 'clientMutationId']),
  CreatePullRequestPayload: new Set(['pullRequest', 'clientMutationId']),
  MergePullRequestPayload: new Set(['pullRequest', 'clientMutationId']),
  AddCommentPayload: new Set(['commentEdge', 'clientMutationId']),
};

/** Field -> object return type; absent means scalar (no sub-selections). */
const FIELD_TYPE: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type' },
  Mutation: { createIssue: 'CreateIssuePayload', closeIssue: 'CloseIssuePayload', createPullRequest: 'CreatePullRequestPayload', mergePullRequest: 'MergePullRequestPayload', addComment: 'AddCommentPayload' },
  Repository: { owner: 'User', defaultBranchRef: 'Ref', issue: 'Issue', issues: 'IssueConnection', pullRequests: 'PullRequestConnection', pullRequest: 'PullRequest' },
  IssueConnection: { nodes: 'Issue', pageInfo: 'PageInfo' },
  PullRequestConnection: { nodes: 'PullRequest', pageInfo: 'PageInfo' },
  PullRequest: { files: 'PullRequestChangedFileConnection' },
  PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile', pageInfo: 'PageInfo' },
  __Type: { fields: '__Field', enumValues: '__EnumValue' },
  CommentEdge: { node: 'Comment' },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'CommentEdge' },
};

/** Introspection field lists — exactly the fields the spec lists per type. */
const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  User: ['login'],
  Node: ['id'],
  IssueConnection: ['nodes', 'totalCount', 'pageInfo'],
  PullRequestConnection: ['nodes', 'totalCount', 'pageInfo'],
  PageInfo: ['hasNextPage', 'endCursor'],
  Ref: ['name'],
};
const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

interface GqlErrorEntry {
  message: string;
  path?: (string | number)[];
  locations?: { line: number; column: number }[];
}

function validateSelections(
  sels: SelectionNode[],
  typeName: string,
  path: (string | number)[],
  errors: GqlErrorEntry[],
  fragments: Map<string, SelectionNode[]>,
): void {
  for (const sel of sels) {
    if (sel.kind === 'field') {
      const key = sel.alias ?? sel.name;
      const allowed = SCHEMA[typeName];
      if (!allowed || !allowed.has(sel.name)) {
        errors.push({
          message: `Cannot query field "${sel.name}" on type "${typeName}".`,
          path: [...path, key],
          locations: [{ line: sel.line, column: sel.column }],
        });
        continue;
      }
      const ret = FIELD_TYPE[typeName]?.[sel.name];
      if (ret) {
        if (sel.selections) validateSelections(sel.selections, ret, [...path, key], errors, fragments);
      } else if (sel.selections) {
        errors.push({
          message: `Field "${sel.name}" must not have a selection since type "${typeName}" has no subfields.`,
          path: [...path, key],
          locations: [{ line: sel.line, column: sel.column }],
        });
      }
    } else if (sel.kind === 'fragment') {
      validateSelections(sel.selections, sel.typeCondition ?? typeName, path, errors, fragments);
    } else {
      const def = fragments.get(sel.name);
      if (def) validateSelections(def, typeName, path, errors, fragments);
    }
  }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

class GqlError extends Error {}

interface ExecCtx {
  ctx: any;
  variables: Record<string, unknown>;
  fragments: Map<string, SelectionNode[]>;
}

function executeOperation(op: unknown, ctx: any): Record<string, unknown> {
  if (!op || typeof op !== 'object' || Array.isArray(op)) {
    return { data: null, errors: [{ message: 'Request body must be a JSON object with a "query" string' }] };
  }
  const record = op as Record<string, unknown>;
  if (typeof record.query !== 'string' || record.query.trim() === '') {
    return { data: null, errors: [{ message: 'Request body must include a "query" string' }] };
  }
  const variables: Record<string, unknown> =
    record.variables && typeof record.variables === 'object' && !Array.isArray(record.variables)
      ? (record.variables as Record<string, unknown>)
      : {};
  let operations: Operation[];
  let parser: Parser;
  try {
    parser = new Parser(lex(record.query));
    operations = parser.parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  let operation: Operation | undefined;
  if (typeof record.operationName === 'string' && record.operationName !== '') {
    operation = operations.find((o) => o.name === record.operationName);
    if (!operation) return { data: null, errors: [{ message: `Unknown operation named "${record.operationName}"` }] };
  } else {
    operation = operations[0];
  }
  const xc: ExecCtx = { ctx, variables, fragments: parser.fragments };
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const errors: GqlErrorEntry[] = [];
  validateSelections(operation.selections, rootType, [], errors, xc.fragments);
  if (errors.length > 0) return { data: null, errors };
  try {
    const source = { __typename: rootType };
    const data = execSelections(operation.selections, rootType, source, xc);
    return { data };
  } catch (err) {
    if (err instanceof GqlError) return { data: null, errors: [{ message: err.message }] };
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}

function execSelections(sels: SelectionNode[], typeName: string, source: any, xc: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of sels) {
    if (sel.kind === 'field') {
      out[sel.alias ?? sel.name] = execField(typeName, sel, source, xc);
    } else if (sel.kind === 'fragment') {
      if (!sel.typeCondition || sel.typeCondition === source.__typename || sel.typeCondition === typeName) {
        Object.assign(out, execSelections(sel.selections, sel.typeCondition ?? typeName, source, xc));
      }
    } else {
      const def = xc.fragments.get(sel.name);
      if (def) Object.assign(out, execSelections(def, typeName, source, xc));
    }
  }
  return out;
}

function nested(field: FieldNode, typeName: string, source: any, xc: ExecCtx): Record<string, unknown> {
  if (!field.selections) return {};
  return execSelections(field.selections, typeName, source, xc);
}

function repoSource(repo: any): any {
  return { __typename: 'Repository', repo };
}
function issueSource(repo: any, issue: any): any {
  return { __typename: 'Issue', repo, issue };
}
function prSource(repo: any, pr: any): any {
  return { __typename: 'PullRequest', repo, pr };
}
function userSource(login: string): any {
  return { __typename: 'User', login };
}

function issueState(issue: any): string {
  return issue.state === 'closed' ? 'CLOSED' : 'OPEN';
}
function prState(pr: any): string {
  if (pr.merged) return 'MERGED';
  return pr.state === 'closed' ? 'CLOSED' : 'OPEN';
}

function execField(typeName: string, field: FieldNode, source: any, xc: ExecCtx): unknown {
  const store = xc.ctx.store;
  const args = resolveArgs(field, xc.variables);
  switch (typeName) {
    case 'Query': {
      if (field.name === 'viewer') {
        const login = typeof xc.ctx.viewer?.login === 'string' ? xc.ctx.viewer.login : '';
        return field.selections ? nested(field, 'User', userSource(login), xc) : { login };
      }
      if (field.name === 'repository') {
        const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        if (!repo) return null;
        return nested(field, 'Repository', repoSource(repo), xc);
      }
      if (field.name === 'node') {
        const node = nodeSource(store, args.id);
        if (!node) return null;
        return nested(field, 'Node', node, xc);
      }
      if (field.name === '__type') {
        const name = String(args.name ?? '');
        if (!(name in TYPE_FIELDS) && !(name in TYPE_ENUMS)) return null;
        return nested(field, '__Type', { __typename: '__Type', name }, xc);
      }
      return null;
    }
    case 'Mutation': {
      if (field.name === 'createIssue') return nested(field, 'CreateIssuePayload', doCreateIssue(xc, args), xc);
      if (field.name === 'closeIssue') return nested(field, 'CloseIssuePayload', doCloseIssue(xc, args), xc);
      if (field.name === 'createPullRequest') return nested(field, 'CreatePullRequestPayload', doCreatePullRequest(xc, args), xc);
      if (field.name === 'mergePullRequest') return nested(field, 'MergePullRequestPayload', doMergePullRequest(xc, args), xc);
      if (field.name === 'addComment') return nested(field, 'AddCommentPayload', doAddComment(xc, args), xc);
      return null;
    }
    case 'Node': {
      if (field.name === 'id') {
        if (source.__typename === 'Repository') return repoGlobalId(source.repo);
        if (source.__typename === 'Issue') return issueGlobalId(source.repo, source.issue);
        if (source.__typename === 'PullRequest') return prGlobalId(source.repo, source.pr);
        return null;
      }
      return null;
    }
    case 'Repository': {
      const repo = source.repo;
      switch (field.name) {
        case 'id': return repoGlobalId(repo);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
        case 'owner': return nested(field, 'User', userSource(repo.owner), xc);
        case 'defaultBranchRef': {
          const ref = `refs/heads/${repo.default_branch}`;
          if (!repo.refs.has(ref)) return null;
          return nested(field, 'Ref', { __typename: 'Ref', name: repo.default_branch }, xc);
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          if (!issue) return null;
          return nested(field, 'Issue', issueSource(repo, issue), xc);
        }
        case 'issues': return nested(field, 'IssueConnection', issuesConnection(store, repo, args), xc);
        case 'pullRequests': return nested(field, 'PullRequestConnection', prsConnection(store, repo, args), xc);
        case 'pullRequest': {
          const pr = repo.pulls.get(Number(args.number));
          if (!pr) return null;
          return nested(field, 'PullRequest', prSource(repo, pr), xc);
        }
        default: return null;
      }
    }
    case 'Issue': {
      const { repo, issue } = source;
      switch (field.name) {
        case 'id': return issueGlobalId(repo, issue);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'state': return issueState(issue);
        case 'body': return typeof issue.body === 'string' ? issue.body : null;
        default: return null;
      }
    }
    case 'PullRequest': {
      const { repo, pr } = source;
      switch (field.name) {
        case 'id': return prGlobalId(repo, pr);
        case 'number': return pr.number;
        case 'state': return prState(pr);
        case 'merged': return pr.merged === true;
        case 'headRefName': return pr.headRef;
        case 'baseRefName': return pr.baseRef;
        case 'mergeable': return prMergeable(store, repo, pr);
        case 'title': return typeof pr.title === 'string' ? pr.title : null;
        case 'body': return typeof pr.body === 'string' ? pr.body : null;
        case 'files': return nested(field, 'PullRequestChangedFileConnection', prFilesConnection(store, repo, pr, args), xc);
        default: return null;
      }
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection': {
      if (field.name === 'nodes') {
        const nodes: any[] = source.nodes as any[];
        const itemType = typeName === 'IssueConnection' ? 'Issue' : typeName === 'PullRequestConnection' ? 'PullRequest' : 'PullRequestChangedFile';
        return nodes.map((node) => (field.selections ? execSelections(field.selections, itemType, node, xc) : node));
      }
      if (field.name === 'totalCount') return source.totalCount;
      if (field.name === 'pageInfo') return nested(field, 'PageInfo', source.pageInfo, xc);
      return null;
    }
    case 'PullRequestChangedFile': {
      return field.name === 'path' ? source.path : null;
    }
    case 'PageInfo': {
      switch (field.name) {
        case 'hasNextPage': return source.hasNextPage === true;
        case 'endCursor': return source.endCursor ?? null;
        case 'hasPreviousPage': return source.hasPreviousPage === true;
        case 'startCursor': return source.startCursor ?? null;
        default: return null;
      }
    }
    case 'Ref': {
      return field.name === 'name' ? source.name : null;
    }
    case 'User': {
      return field.name === 'login' ? source.login : null;
    }
    case '__Type': {
      const name: string = source.name;
      if (field.name === 'name') return name;
      if (field.name === 'kind') return name in TYPE_ENUMS ? 'ENUM' : 'OBJECT';
      if (field.name === 'description') return null;
      if (field.name === 'fields') {
        const names = TYPE_FIELDS[name] ?? [];
        return names.map((n) => (field.selections ? execSelections(field.selections, '__Field', { __typename: '__Field', name: n }, xc) : { name: n }));
      }
      if (field.name === 'enumValues') {
        const names = TYPE_ENUMS[name] ?? [];
        return names.map((n) => (field.selections ? execSelections(field.selections, '__EnumValue', { __typename: '__EnumValue', name: n }, xc) : { name: n }));
      }
      return null;
    }
    case '__Field':
    case '__EnumValue': {
      return field.name === 'name' ? source.name : null;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (field.name === 'issue') return nested(field, 'Issue', source.issue, xc);
      return null;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (field.name === 'pullRequest') return nested(field, 'PullRequest', source.pullRequest, xc);
      return null;
    }
    case 'AddCommentPayload': {
      if (field.name === 'commentEdge') return nested(field, 'CommentEdge', source.commentEdge, xc);
      return null;
    }
    case 'CommentEdge': {
      if (field.name === 'node') return nested(field, 'Comment', source.node, xc);
      if (field.name === 'cursor') return source.cursor ?? null;
      return null;
    }
    case 'Comment': {
      if (field.name === 'id') return source.id;
      if (field.name === 'body') return source.body;
      return null;
    }
    default:
      return null;
  }
}

function nodeSource(store: any, id: unknown): any | null {
  const dec = decodeGlobalId(id);
  if (!dec) return null;
  if (dec.type === 'Repository') {
    const slash = dec.rest.indexOf('/');
    if (slash < 0) return null;
    const repo = store.getRepo(dec.rest.slice(0, slash), dec.rest.slice(slash + 1));
    return repo ? repoSource(repo) : null;
  }
  if (dec.type === 'Issue' || dec.type === 'PullRequest') {
    const parts = dec.rest.split(':');
    const repo = findRepoByDbId(store, parts[0] ?? '');
    if (!repo) return null;
    const number = Number(parts[1]);
    if (dec.type === 'Issue') {
      const issue = repo.issues.get(number);
      return issue ? issueSource(repo, issue) : null;
    }
    const pr = repo.pulls.get(number);
    return pr ? prSource(repo, pr) : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

function issuesConnection(_store: any, repo: any, args: Record<string, unknown>): any {
  let list: any[] = [...repo.issues.values()];
  if (Array.isArray(args.states) && args.states.length > 0) {
    const wanted = new Set(args.states as string[]);
    list = list.filter((issue) => wanted.has(issueState(issue)));
  }
  const orderBy = (args.orderBy && typeof args.orderBy === 'object' ? args.orderBy : {}) as Record<string, unknown>;
  const dir = orderBy.direction === 'ASC' ? 1 : -1;
  const orderField = typeof orderBy.field === 'string' ? orderBy.field : 'CREATED_AT';
  list.sort((a, b) => {
    let cmp = 0;
    if (orderField === 'COMMENTS') cmp = (a.comments?.length ?? 0) - (b.comments?.length ?? 0);
    else cmp = (a.seq ?? a.number) - (b.seq ?? b.number);
    if (cmp !== 0) return cmp * dir;
    return (a.number - b.number) * dir;
  });
  let startIdx = 0;
  const afterNum = decodeCursor(args.after);
  if (afterNum !== null) {
    const idx = list.findIndex((issue) => issue.number === afterNum);
    if (idx >= 0) startIdx = idx + 1;
  }
  const totalCount = list.length;
  const first = typeof args.first === 'number' ? args.first : undefined;
  const page = first !== undefined ? list.slice(startIdx, startIdx + first) : list.slice(startIdx);
  const hasNextPage = startIdx + page.length < list.length;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue) => issueSource(repo, issue)),
    totalCount,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      endCursor: page.length > 0 ? b64e(String(page[page.length - 1].number)) : null,
      hasPreviousPage: startIdx > 0,
      startCursor: page.length > 0 ? b64e(String(page[0].number)) : null,
    },
  };
}

function prsConnection(_store: any, repo: any, args: Record<string, unknown>): any {
  const list: any[] = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
  const totalCount = list.length;
  const first = typeof args.first === 'number' ? args.first : undefined;
  const page = first !== undefined ? list.slice(0, first) : list;
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((pr) => prSource(repo, pr)),
    totalCount,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: page.length < list.length,
      endCursor: page.length > 0 ? b64e(String(page[page.length - 1].number)) : null,
      hasPreviousPage: false,
      startCursor: page.length > 0 ? b64e(String(page[0].number)) : null,
    },
  };
}

/** Changed paths between a PR's base and head commits, via the store's diff. */
function prChangedPaths(store: any, repo: any, pr: any): string[] {
  const headSha: string | undefined = pr.headSha || repo.refs.get(`refs/heads/${pr.headRef}`);
  const baseSha: string | undefined = pr.baseSha || repo.refs.get(`refs/heads/${pr.baseRef}`);
  if (!headSha || !baseSha) return [];
  const headObj = store.getObject(headSha);
  const baseObj = store.getObject(baseSha);
  if (!headObj || !baseObj) return [];
  const headTree = store.parseCommit(headObj.data).tree;
  const baseTree = store.parseCommit(baseObj.data).tree;
  const diff = store.diffTrees(baseTree, headTree) as Map<string, unknown>;
  return [...diff.keys()].sort();
}

function prFilesConnection(store: any, repo: any, pr: any, args: Record<string, unknown>): any {
  const paths = prChangedPaths(store, repo, pr);
  const first = typeof args.first === 'number' ? args.first : undefined;
  const page = first !== undefined ? paths.slice(0, first) : paths;
  return {
    __typename: 'PullRequestChangedFileConnection',
    nodes: page.map((p) => ({ __typename: 'PullRequestChangedFile', path: p })),
    totalCount: paths.length,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: page.length < paths.length,
      endCursor: null,
      hasPreviousPage: false,
      startCursor: null,
    },
  };
}

/** MERGEABLE unless the store says otherwise or the head conflicts with base. */
function prMergeable(store: any, repo: any, pr: any): string {
  if (pr.mergeable === false) return 'CONFLICTING';
  try {
    if (prConflict(store, repo, pr)) return 'CONFLICTING';
  } catch {
    return 'UNKNOWN';
  }
  return 'MERGEABLE';
}

/** True when a path changed on the head was also changed on base since the PR branched. */
function prConflict(store: any, repo: any, pr: any): boolean {
  const headSha: string | undefined = pr.headSha || repo.refs.get(`refs/heads/${pr.headRef}`);
  const baseTip: string | undefined = repo.refs.get(`refs/heads/${pr.baseRef}`);
  const prBaseSha: string | undefined = pr.baseSha;
  if (!headSha || !baseTip || !prBaseSha) return false;
  const headObj = store.getObject(headSha);
  const baseObj = store.getObject(baseTip);
  const prBaseObj = store.getObject(prBaseSha);
  if (!headObj || !baseObj || !prBaseObj) return false;
  const headTree = store.parseCommit(headObj.data).tree;
  const baseTree = store.parseCommit(baseObj.data).tree;
  const prBaseTree = store.parseCommit(prBaseObj.data).tree;
  const headDiff = store.diffTrees(prBaseTree, headTree) as Map<string, { headSha: string | null }>;
  const baseDiff = store.diffTrees(prBaseTree, baseTree) as Map<string, { headSha: string | null }>;
  for (const [p, h] of headDiff) {
    const b = baseDiff.get(p);
    if (b && b.headSha !== h.headSha) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Mutations (same store as REST, so results are visible over /api/v3)
// ---------------------------------------------------------------------------

function decodeRepoId(xc: ExecCtx, id: unknown): any {
  const dec = decodeGlobalId(id);
  if (!dec || dec.type !== 'Repository') throw new GqlError('Repository not found');
  const slash = dec.rest.indexOf('/');
  if (slash < 0) throw new GqlError('Repository not found');
  const repo = xc.ctx.store.getRepo(dec.rest.slice(0, slash), dec.rest.slice(slash + 1));
  if (!repo) throw new GqlError('Repository not found');
  return repo;
}

function decodeIssueId(xc: ExecCtx, id: unknown): { repo: any; issue: any } {
  const dec = decodeGlobalId(id);
  if (!dec || dec.type !== 'Issue') throw new GqlError('Issue not found');
  const parts = dec.rest.split(':');
  const repo = findRepoByDbId(xc.ctx.store, parts[0] ?? '');
  const issue = repo ? repo.issues.get(Number(parts[1])) : undefined;
  if (!repo || !issue) throw new GqlError('Issue not found');
  return { repo, issue };
}

function decodePrId(xc: ExecCtx, id: unknown): { repo: any; pr: any } {
  const dec = decodeGlobalId(id);
  if (!dec || dec.type !== 'PullRequest') throw new GqlError('Pull request not found');
  const parts = dec.rest.split(':');
  const repo = findRepoByDbId(xc.ctx.store, parts[0] ?? '');
  const pr = repo ? repo.pulls.get(Number(parts[1])) : undefined;
  if (!repo || !pr) throw new GqlError('Pull request not found');
  return { repo, pr };
}

function inputOf(args: Record<string, unknown>, what: string): Record<string, unknown> {
  const input = args.input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new GqlError(`${what} requires an input object`);
  return input as Record<string, unknown>;
}

function doCreateIssue(xc: ExecCtx, args: Record<string, unknown>): any {
  const input = inputOf(args, 'createIssue');
  const repo = decodeRepoId(xc, input.repositoryId);
  if (typeof input.title !== 'string' || input.title === '') throw new GqlError('createIssue requires a title');
  const number = repo.nextNumber++;
  const issue = {
    number,
    title: input.title,
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    labels: [],
    comments: [],
    user: xc.ctx.viewer,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    seq: xc.ctx.store.nextSeq(),
  };
  repo.issues.set(number, issue);
  return { __typename: 'CreateIssuePayload', issue: issueSource(repo, issue) };
}

function doCloseIssue(xc: ExecCtx, args: Record<string, unknown>): any {
  const input = inputOf(args, 'closeIssue');
  const { repo, issue } = decodeIssueId(xc, input.issueId);
  issue.state = 'closed';
  issue.updated_at = FIXED_ISO;
  return { __typename: 'CloseIssuePayload', issue: issueSource(repo, issue) };
}

function doCreatePullRequest(xc: ExecCtx, args: Record<string, unknown>): any {
  const input = inputOf(args, 'createPullRequest');
  const repo = decodeRepoId(xc, input.repositoryId);
  const headRef = String(input.headRefName ?? '');
  const baseRef = String(input.baseRefName ?? '');
  if (headRef === '' || baseRef === '') throw new GqlError('createPullRequest requires headRefName and baseRefName');
  if (typeof input.title !== 'string' || input.title === '') throw new GqlError('createPullRequest requires a title');
  const number = repo.nextNumber++;
  const pr = {
    number,
    title: input.title,
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    headRef,
    baseRef,
    headSha: repo.refs.get(`refs/heads/${headRef}`) ?? '',
    baseSha: repo.refs.get(`refs/heads/${baseRef}`) ?? '',
    merged: false,
    merged_at: null,
    merge_commit_sha: null,
    mergeable: true,
    user: xc.ctx.viewer,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    seq: xc.ctx.store.nextSeq(),
  };
  repo.pulls.set(number, pr);
  return { __typename: 'CreatePullRequestPayload', pullRequest: prSource(repo, pr) };
}

/**
 * Squash-merge like REST PUT .../pulls/{n}/merge: one new commit on the
 * default/base branch whose tree is the base tip with the head's diff
 * applied, then the PR is closed and merged.
 */
function doMergePullRequest(xc: ExecCtx, args: Record<string, unknown>): any {
  const input = inputOf(args, 'mergePullRequest');
  const { repo, pr } = decodePrId(xc, input.pullRequestId);
  const store = xc.ctx.store;
  if (pr.merged) return { __typename: 'MergePullRequestPayload', pullRequest: prSource(repo, pr) };
  if (pr.state === 'closed') throw new GqlError('Pull request is closed');
  const baseRefName = `refs/heads/${pr.baseRef}`;
  const headRefName = `refs/heads/${pr.headRef}`;
  const baseTip: string | undefined = repo.refs.get(baseRefName);
  const headTip: string | undefined = repo.refs.get(headRefName);
  if (!baseTip || !headTip) throw new GqlError('Pull request branches are missing');
  if (prConflict(store, repo, pr)) throw new GqlError('Pull request is not mergeable: the head branch conflicts with the base branch');
  const baseObj = store.getObject(baseTip);
  const headObj = store.getObject(headTip);
  const prBaseObj = pr.baseSha ? store.getObject(pr.baseSha) : null;
  if (!baseObj || !headObj) throw new GqlError('Pull request commits are missing');
  const baseTree = store.parseCommit(baseObj.data).tree;
  const headTree = store.parseCommit(headObj.data).tree;
  const prBaseTree = prBaseObj ? store.parseCommit(prBaseObj.data).tree : baseTree;
  const headDiff = store.diffTrees(prBaseTree, headTree) as Map<string, { status: string; headSha: string | null }>;
  const headFiles = store.flattenTree(headTree) as Map<string, { mode: string; sha: string }>;
  const files = store.flattenTree(baseTree) as Map<string, { mode: string; sha: string }>;
  for (const [p, change] of headDiff) {
    if (change.status === 'deleted') {
      files.delete(p);
    } else if (change.headSha) {
      const headEntry = headFiles.get(p);
      files.set(p, { mode: headEntry ? headEntry.mode : '100644', sha: change.headSha });
    }
  }
  const treeSha = store.buildTree(files);
  const mergeSha = store.createCommit(treeSha, [baseTip], `Merge pull request #${pr.number} from ${pr.headRef}`);
  repo.refs.set(baseRefName, mergeSha);
  pr.state = 'closed';
  pr.merged = true;
  pr.merged_at = FIXED_ISO;
  pr.merge_commit_sha = mergeSha;
  pr.updated_at = FIXED_ISO;
  return { __typename: 'MergePullRequestPayload', pullRequest: prSource(repo, pr) };
}

function doAddComment(xc: ExecCtx, args: Record<string, unknown>): any {
  const input = inputOf(args, 'addComment');
  if (typeof input.body !== 'string') throw new GqlError('addComment requires a body');
  const { repo, issue } = decodeIssueId(xc, input.subjectId);
  const comment = {
    id: repo.nextCommentId++,
    body: input.body,
    user: xc.ctx.viewer,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  };
  issue.comments.push(comment);
  return {
    __typename: 'AddCommentPayload',
    commentEdge: {
      __typename: 'CommentEdge',
      node: { __typename: 'Comment', id: commentGlobalId(repo, issue, comment), body: comment.body },
      cursor: null,
    },
  };
}
