// MCP module for the make.fun forge: Streamable HTTP JSON-RPC 2.0 at POST /mcp.
//
// Both protocol eras are served from this one handler:
//   modern 2026-07-28 — server/discover (no handshake, no session), and
//   legacy 2025-11-25 / 2025-06-18 / 2025-03-26 / 2024-11-05 — initialize +
//   notifications/initialized (no session id is ever issued).
// Plain-JSON answers only (no SSE); every answer is application/json.
//
// Auth: enforced per request, before any dispatch or body parsing, on every
// POST /mcp (all methods, including server/discover and initialize — the
// suite always authenticates connect(), and only tools/call is ever sent
// without a token, which must be 401). DELETE /mcp (session teardown) is
// the sole exception: it always answers 204, best-effort per spec B.5.
// Auth itself is delegated to ctx.authed(headers); if ctx provides no
// authed function, any non-empty Bearer token is accepted as a fallback.
//
// All six tools operate directly on ctx.store (the same Store REST and
// GraphQL use), so objects created here read back over REST with stable ids.
// Deterministic: no Date.now(), no Math.random(), no per-call ids in
// tools/list (one frozen literal, returned in a fixed order every time).
//
// Stable cross-surface ids: the store's Issue/Pull records carry no `id`
// field, so MCP (and, by this convention, REST/GraphQL authors) derive it
// deterministically as repo.id * 100000 + number. Issues and PRs share one
// per-repo counter (store.nextNumber), so the two can never collide inside
// one repo, and repo ids are unique across repos. Documented here so the
// REST module can adopt the same formula.

import { FIXED_ISO, VIEWER } from './scenario.ts';

const SERVER_NAME = 'makefun-github-core-clone-forge';
const SERVER_VERSION = '1.0.0';
const MODERN_VERSION = '2026-07-28';
const LEGACY_DEFAULT_VERSION = '2025-11-25';
const SUPPORTED_VERSIONS: readonly string[] = Object.freeze([
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);

const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;
const JSON_RPC_UNSUPPORTED_VERSION = -32022;

type Headers = Record<string, string>;
type RpcId = string | number | null;
type HandlerResult = { status: number; headers: Headers; body: Buffer } | null;

// ---------------------------------------------------------------- tools

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

// One frozen literal: tools/list is byte-identical across calls by
// construction (fixed order, no timestamps, no per-call values).
// `required` lists ONLY properties the suite can fill (spec B.4).
const TOOLS: readonly ToolDef[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        name: Object.freeze({ type: 'string', description: 'Name of the repository to create.' }),
        description: Object.freeze({ type: 'string', description: 'A short description of the repository.' }),
        private: Object.freeze({ type: 'boolean', description: 'Whether the repository is private.' }),
      }),
      required: Object.freeze(['name']),
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Owner login of the repository.' }),
        repo: Object.freeze({ type: 'string', description: 'Name of the repository.' }),
        full_name: Object.freeze({ type: 'string', description: 'Full name of the repository as "owner/repo".' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Owner login of the repository.' }),
        repo: Object.freeze({ type: 'string', description: 'Name of the repository.' }),
        full_name: Object.freeze({ type: 'string', description: 'Full name of the repository as "owner/repo".' }),
        title: Object.freeze({ type: 'string', description: 'Title of the issue.' }),
        body: Object.freeze({ type: 'string', description: 'Body of the issue.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Owner login of the repository.' }),
        repo: Object.freeze({ type: 'string', description: 'Name of the repository.' }),
        full_name: Object.freeze({ type: 'string', description: 'Full name of the repository as "owner/repo".' }),
        state: Object.freeze({ type: 'string', description: 'Issue state filter: open, closed, or all.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Owner login of the repository.' }),
        repo: Object.freeze({ type: 'string', description: 'Name of the repository.' }),
        full_name: Object.freeze({ type: 'string', description: 'Full name of the repository as "owner/repo".' }),
        title: Object.freeze({ type: 'string', description: 'Title of the pull request.' }),
        body: Object.freeze({ type: 'string', description: 'Body of the pull request.' }),
        head: Object.freeze({ type: 'string', description: 'Name of the head branch.' }),
        base: Object.freeze({ type: 'string', description: 'Name of the base branch.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Owner login of the repository.' }),
        repo: Object.freeze({ type: 'string', description: 'Name of the repository.' }),
        full_name: Object.freeze({ type: 'string', description: 'Full name of the repository as "owner/repo".' }),
        pull_number: Object.freeze({ type: 'integer', description: 'Number of the pull request to merge.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
    }),
  }),
]);

// Canonical names plus the aliases the suite accepts, all normalized
// (lowercase, non-alphanumerics removed) for suffix matching, so a
// `github__` prefix is matched too.
const TOOL_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  create_repo: Object.freeze(['create_repo', 'create_repository', 'repo_create', 'repos_create', 'repository_create']),
  get_repo: Object.freeze(['get_repo', 'get_repository', 'repo_get', 'repos_get', 'repository_get']),
  create_issue: Object.freeze(['create_issue', 'issue_create', 'issues_create']),
  list_issues: Object.freeze(['list_issues', 'issues_list', 'issue_list']),
  create_pull_request: Object.freeze(['create_pull_request', 'pull_request_create', 'pulls_create', 'create_pr', 'pr_create']),
  merge_pull_request: Object.freeze(['merge_pull_request', 'pull_request_merge', 'pulls_merge', 'merge_pr', 'pr_merge']),
});

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function canonicalToolName(name: unknown): string | null {
  if (typeof name !== 'string' || name === '') return null;
  const wanted = normalizeName(name);
  for (const [canonical, aliases] of Object.entries(TOOL_ALIASES)) {
    for (const alias of aliases) {
      const norm = normalizeName(alias);
      if (wanted === norm) return canonical;
    }
  }
  for (const [canonical, aliases] of Object.entries(TOOL_ALIASES)) {
    for (const alias of aliases) {
      const norm = normalizeName(alias);
      if (wanted.length > norm.length && wanted.endsWith(norm)) return canonical;
    }
  }
  return null;
}

// ---------------------------------------------------------------- helpers

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonReply(status: number, value: unknown, extraHeaders: Headers = {}): HandlerResult {
  return {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: Buffer.from(JSON.stringify(value), 'utf8'),
  };
}

function rpcResult(id: RpcId, result: unknown): HandlerResult {
  return jsonReply(200, { jsonrpc: '2.0', id, result });
}

function rpcError(id: RpcId, code: number, message: string, data?: unknown): HandlerResult {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return jsonReply(200, { jsonrpc: '2.0', id, error });
}

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function toolErrorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Lowercase a headers map (Node request headers are already lowercase, but be safe). */
function lowerHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) out[key.toLowerCase()] = value;
  return out;
}

function isAuthed(ctx: any, headers: Record<string, string>): boolean {
  if (ctx && typeof ctx.authed === 'function') {
    try {
      return ctx.authed(headers) === true;
    } catch {
      return false;
    }
  }
  // Fallback when ctx carries no authed function: any non-empty Bearer token.
  const auth = headers['authorization'] ?? '';
  return auth.startsWith('Bearer ') && auth.slice(7).trim() !== '';
}

/** Protocol version declared by the request: header first, then _meta (either spelling). */
function declaredVersion(headers: Record<string, string>, params: Record<string, unknown>): string | null {
  const header = headers['mcp-protocol-version'];
  if (typeof header === 'string' && header.trim() !== '') return header.trim();
  const meta = params['_meta'];
  if (isRecord(meta)) {
    for (const key of ['io.modelcontextprotocol/protocolVersion', 'protocolVersion']) {
      const value = meta[key];
      if (typeof value === 'string' && value.trim() !== '') return value.trim();
    }
  }
  return null;
}

function isSupportedVersion(version: string): boolean {
  return (SUPPORTED_VERSIONS as readonly string[]).includes(version);
}

function baseUrlOf(ctx: any): string {
  const raw = typeof ctx?.baseUrl === 'string' ? ctx.baseUrl : '';
  return raw.replace(/\/+$/, '');
}

// ---------------------------------------------------------------- arguments

// Synonym lists (normalized) for resolving tool arguments defensively: the
// suite maps onto our schema property names, but other callers may send a
// synonym directly. First synonym that exists wins.
const ARG_SYNONYMS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  owner: Object.freeze(['owner', 'ownerlogin', 'org', 'organization', 'organisation', 'user', 'userlogin', 'login', 'account', 'namespace', 'ownername']),
  repo: Object.freeze(['repo', 'repository', 'repositoryname', 'reponame', 'reposlug', 'project', 'projectname']),
  full_name: Object.freeze(['fullname', 'repofullname', 'repositoryfullname']),
  title: Object.freeze(['title', 'issuetitle', 'prtitle', 'pullrequesttitle', 'subject']),
  body: Object.freeze(['body', 'issuebody', 'description', 'content', 'text', 'comment']),
  head: Object.freeze(['head', 'headref', 'headbranch', 'pullrequesthead', 'prhead', 'source', 'sourceref', 'sourcebranch', 'from', 'frombranch', 'branch']),
  base: Object.freeze(['base', 'baseref', 'basebranch', 'pullrequestbase', 'prbase', 'target', 'targetref', 'targetbranch', 'into', 'intobranch']),
  pull_number: Object.freeze(['pullnumber', 'pullrequestnumber', 'prnumber', 'number', 'issuenumber', 'index']),
  name: Object.freeze(['name', 'repo', 'repository', 'repositoryname', 'reponame']),
  description: Object.freeze(['description', 'about', 'summary', 'body']),
  private: Object.freeze(['private', 'isprivate']),
  state: Object.freeze(['state', 'status']),
});

function pickArg(args: Record<string, unknown>, key: string): unknown {
  const byNormalized = new Map<string, unknown>();
  for (const [prop, value] of Object.entries(args)) byNormalized.set(normalizeName(prop), value);
  for (const synonym of ARG_SYNONYMS[key] ?? [key]) {
    const value = byNormalized.get(normalizeName(synonym));
    if (value !== undefined) return value;
  }
  return undefined;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function asInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

/** Resolve owner/repo from arguments, including a "owner/repo" full_name. */
function resolveOwnerRepo(args: Record<string, unknown>): { owner: string; repo: string } | null {
  let owner = asNonEmptyString(pickArg(args, 'owner'));
  let repo = asNonEmptyString(pickArg(args, 'repo'));
  if ((owner === null || repo === null) && typeof pickArg(args, 'full_name') === 'string') {
    const full = (pickArg(args, 'full_name') as string).trim();
    const slash = full.indexOf('/');
    if (slash > 0 && slash < full.length - 1) {
      if (owner === null) owner = full.slice(0, slash);
      if (repo === null) repo = full.slice(slash + 1);
    }
  }
  if (owner === null || repo === null) return null;
  return { owner, repo };
}

// ---------------------------------------------------------------- REST shapes

function userObject(): Record<string, unknown> {
  return { login: VIEWER.login, id: VIEWER.id, type: 'User', name: VIEWER.name };
}

function repoObject(ctx: any, repo: any): Record<string, unknown> {
  const baseUrl = baseUrlOf(ctx);
  const fullName = `${repo.owner}/${repo.name}`;
  return {
    id: repo.id,
    name: repo.name,
    full_name: fullName,
    owner: userObject(),
    private: repo.private,
    description: repo.description,
    default_branch: repo.default_branch,
    fork: false,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    has_issues: true,
    has_pull_requests: true,
    html_url: `${baseUrl}/${fullName}`,
    url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  };
}

/** Deterministic stable id for an issue/PR: repo.id * 100000 + number. */
function objectId(repo: any, number: number): number {
  return repo.id * 100000 + number;
}

function issueObject(ctx: any, repo: any, issue: any): Record<string, unknown> {
  const baseUrl = baseUrlOf(ctx);
  return {
    id: objectId(repo, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: (issue.labels ?? []).map((label: any) => ({
      name: label.name,
      color: label.color ?? 'ededed',
      description: label.description ?? '',
    })),
    user: userObject(),
    assignee: null,
    assignees: [],
    comments: (issue.comments ?? []).length,
    locked: false,
    html_url: `${baseUrl}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: issue.created_at ?? FIXED_ISO,
    updated_at: issue.updated_at ?? FIXED_ISO,
  };
}

function pullObject(ctx: any, repo: any, pull: any): Record<string, unknown> {
  const baseUrl = baseUrlOf(ctx);
  const ref = (branch: string, sha: string): Record<string, unknown> => ({
    label: `${repo.owner}:${branch}`,
    ref: branch,
    sha,
    user: userObject(),
    repo: { id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}` },
  });
  return {
    id: objectId(repo, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: ref(pull.headRef, pull.headSha ?? ''),
    base: ref(pull.baseRef, pull.baseSha ?? ''),
    merged: pull.merged,
    merged_at: pull.merged_at ?? null,
    merge_commit_sha: pull.merge_commit_sha ?? null,
    mergeable: pull.mergeable ?? true,
    user: userObject(),
    assignee: null,
    assignees: [],
    draft: false,
    locked: false,
    html_url: `${baseUrl}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    created_at: pull.created_at ?? FIXED_ISO,
    updated_at: pull.updated_at ?? FIXED_ISO,
  };
}

// ---------------------------------------------------------------- merge logic

/** Nearest common ancestor of two commits (first head-reachable commit also reachable from base). */
function mergeBase(store: any, headTip: string, baseTip: string): string | null {
  try {
    const headReach: Set<string> = store.reachableCommits(headTip);
    const baseReach: Set<string> = store.reachableCommits(baseTip);
    for (const sha of headReach) if (baseReach.has(sha)) return sha;
  } catch {
    return null;
  }
  return null;
}

function treeOf(store: any, commitSha: string): Map<string, { mode: string; sha: string }> {
  const obj = store.getObject(commitSha);
  if (!obj || obj.type !== 'commit') return new Map();
  const info = store.parseCommit(obj.data);
  if (!info.tree) return new Map();
  return store.flattenTree(info.tree);
}

/** True when the head and the base both changed the same path differently since the merge base. */
function hasMergeConflict(store: any, headTip: string, baseTip: string): boolean {
  const base = mergeBase(store, headTip, baseTip);
  if (base === null) return false;
  if (base === baseTip) return false; // base has not moved since the branch point
  const baseTree = treeOf(store, base);
  const headTree = treeOf(store, headTip);
  const newBaseTree = treeOf(store, baseTip);
  const changedOnBase = new Map<string, string | null>();
  for (const [path, entry] of newBaseTree) {
    const old = baseTree.get(path);
    if (!old || old.sha !== entry.sha) changedOnBase.set(path, entry.sha);
  }
  for (const path of baseTree.keys()) if (!newBaseTree.has(path)) changedOnBase.set(path, null);
  const changedOnHead = new Map<string, string | null>();
  for (const [path, entry] of headTree) {
    const old = baseTree.get(path);
    if (!old || old.sha !== entry.sha) changedOnHead.set(path, entry.sha);
  }
  for (const path of baseTree.keys()) if (!headTree.has(path)) changedOnHead.set(path, null);
  for (const [path, headSha] of changedOnHead) {
    if (changedOnBase.has(path) && changedOnBase.get(path) !== headSha) return true;
  }
  return false;
}

/** Squash-merge: one new commit on the base branch with the head's contents. */
function squashMerge(store: any, repo: any, pull: any): { ok: true; sha: string } | { ok: false; message: string } {
  const headTip: string | undefined = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip: string | undefined = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (typeof headTip !== 'string' || headTip === '') return { ok: false, message: `Head branch not found: ${pull.headRef}` };
  if (typeof baseTip !== 'string' || baseTip === '') return { ok: false, message: `Base branch not found: ${pull.baseRef}` };
  if (hasMergeConflict(store, headTip, baseTip)) {
    return { ok: false, message: `Merge conflict: ${pull.headRef} conflicts with ${pull.baseRef}` };
  }
  try {
    const baseFiles = treeOf(store, baseTip);
    const headFiles = treeOf(store, headTip);
    const merged = new Map<string, { mode: string; sha: string }>(baseFiles);
    // Apply the head's tree wholesale over the base tree, then drop paths
    // the head deleted: equivalent to diffing base->head and applying it.
    const baseTreeObj = store.getObject(baseTip);
    const headTreeObj = store.getObject(headTip);
    if (!baseTreeObj || !headTreeObj) return { ok: false, message: 'Could not read the branch tips' };
    const baseTreeSha = store.parseCommit(baseTreeObj.data).tree;
    const headTreeSha = store.parseCommit(headTreeObj.data).tree;
    const diff = store.diffTrees(baseTreeSha, headTreeSha);
    for (const [path, change] of diff) {
      if (change.status === 'deleted') merged.delete(path);
      else {
        const entry = headFiles.get(path);
        if (entry) merged.set(path, entry);
      }
    }
    const treeSha = store.buildTree(merged);
    const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}\n\n${pull.title}`;
    const mergeSha: string = store.createCommit(treeSha, [baseTip], message);
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    return { ok: true, sha: mergeSha };
  } catch (err) {
    return { ok: false, message: `Merge failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ---------------------------------------------------------------- tool implementations

// Each returns either a tool result object or a { toolError: message } marker.
type ToolOutcome = { result: Record<string, unknown> } | { toolError: string };

function doCreateRepo(ctx: any, args: Record<string, unknown>): ToolOutcome {
  const name = asNonEmptyString(pickArg(args, 'name'));
  if (name === null) return { toolError: 'Missing required argument: name' };
  const store = ctx.store;
  const existing = store.getRepo(VIEWER.login, name);
  if (existing) return { result: toolResult(repoObject(ctx, existing)) };
  const description = typeof pickArg(args, 'description') === 'string' ? (pickArg(args, 'description') as string) : '';
  const priv = pickArg(args, 'private');
  const repo = store.createRepo(name, description, priv === true);
  return { result: toolResult(repoObject(ctx, repo)) };
}

function doGetRepo(ctx: any, args: Record<string, unknown>): ToolOutcome {
  const resolved = resolveOwnerRepo(args);
  if (resolved === null) return { toolError: 'Missing required arguments: owner, repo' };
  const repo = ctx.store.getRepo(resolved.owner, resolved.repo);
  if (!repo) return { toolError: `Repository not found: ${resolved.owner}/${resolved.repo}` };
  return { result: toolResult(repoObject(ctx, repo)) };
}

function doCreateIssue(ctx: any, args: Record<string, unknown>): ToolOutcome {
  const resolved = resolveOwnerRepo(args);
  const title = asNonEmptyString(pickArg(args, 'title'));
  if (resolved === null || title === null) {
    return { toolError: 'Missing required arguments: owner, repo, title' };
  }
  const repo = ctx.store.getRepo(resolved.owner, resolved.repo);
  if (!repo) return { toolError: `Repository not found: ${resolved.owner}/${resolved.repo}` };
  const body = typeof pickArg(args, 'body') === 'string' ? (pickArg(args, 'body') as string) : '';
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const issue = {
    number,
    title,
    body,
    state: 'open' as const,
    labels: [],
    comments: [],
    user: VIEWER,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    seq: ctx.store.nextSeq(),
  };
  repo.issues.set(number, issue);
  return { result: toolResult(issueObject(ctx, repo, issue)) };
}

function doListIssues(ctx: any, args: Record<string, unknown>): ToolOutcome {
  const resolved = resolveOwnerRepo(args);
  if (resolved === null) return { toolError: 'Missing required arguments: owner, repo' };
  const repo = ctx.store.getRepo(resolved.owner, resolved.repo);
  if (!repo) return { toolError: `Repository not found: ${resolved.owner}/${resolved.repo}` };
  const stateRaw = pickArg(args, 'state');
  const state = typeof stateRaw === 'string' ? stateRaw.trim().toLowerCase() : 'all';
  const issues = [...repo.issues.values()]
    .filter((issue: any) => state === 'all' || issue.state === state)
    .sort((a: any, b: any) => a.number - b.number)
    .map((issue: any) => issueObject(ctx, repo, issue));
  return { result: toolResult({ issues }) };
}

function doCreatePullRequest(ctx: any, args: Record<string, unknown>): ToolOutcome {
  const resolved = resolveOwnerRepo(args);
  const title = asNonEmptyString(pickArg(args, 'title'));
  const head = asNonEmptyString(pickArg(args, 'head'));
  const base = asNonEmptyString(pickArg(args, 'base'));
  if (resolved === null || title === null || head === null || base === null) {
    return { toolError: 'Missing required arguments: owner, repo, title, head, base' };
  }
  const repo = ctx.store.getRepo(resolved.owner, resolved.repo);
  if (!repo) return { toolError: `Repository not found: ${resolved.owner}/${resolved.repo}` };
  const headSha: string | undefined = repo.refs.get(`refs/heads/${head}`);
  const baseSha: string | undefined = repo.refs.get(`refs/heads/${base}`);
  if (typeof headSha !== 'string' || headSha === '') return { toolError: `Head branch not found: ${head}` };
  if (typeof baseSha !== 'string' || baseSha === '') return { toolError: `Base branch not found: ${base}` };
  const body = typeof pickArg(args, 'body') === 'string' ? (pickArg(args, 'body') as string) : '';
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const pull = {
    number,
    title,
    body,
    state: 'open' as const,
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
    merged: false,
    merged_at: null,
    merge_commit_sha: null,
    mergeable: true,
    user: VIEWER,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    seq: ctx.store.nextSeq(),
  };
  repo.pulls.set(number, pull);
  return { result: toolResult(pullObject(ctx, repo, pull)) };
}

function doMergePullRequest(ctx: any, args: Record<string, unknown>): ToolOutcome {
  const resolved = resolveOwnerRepo(args);
  const pullNumber = asInteger(pickArg(args, 'pull_number'));
  if (resolved === null || pullNumber === null) {
    return { toolError: 'Missing required arguments: owner, repo, pull_number' };
  }
  const repo = ctx.store.getRepo(resolved.owner, resolved.repo);
  if (!repo) return { toolError: `Repository not found: ${resolved.owner}/${resolved.repo}` };
  const pull = repo.pulls.get(pullNumber);
  if (!pull) return { toolError: `Pull request not found: #${pullNumber}` };
  if (pull.merged || pull.state !== 'open') {
    return { toolError: `Pull request #${pullNumber} is already ${pull.merged ? 'merged' : pull.state}` };
  }
  const merged = squashMerge(ctx.store, repo, pull);
  if (!merged.ok) return { toolError: merged.message };
  pull.merged = true;
  pull.merged_at = FIXED_ISO;
  pull.merge_commit_sha = merged.sha;
  pull.state = 'closed';
  pull.updated_at = FIXED_ISO;
  return { result: toolResult(pullObject(ctx, repo, pull)) };
}

// Required arguments per tool (server-side validation; a call missing any
// of these is a JSON-RPC -32602, never a success).
const TOOL_REQUIRED: Readonly<Record<string, readonly string[]>> = Object.freeze({
  create_repo: Object.freeze(['name']),
  get_repo: Object.freeze(['owner', 'repo']),
  create_issue: Object.freeze(['owner', 'repo', 'title']),
  list_issues: Object.freeze(['owner', 'repo']),
  create_pull_request: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
  merge_pull_request: Object.freeze(['owner', 'repo', 'pull_number']),
});

function missingRequired(canonical: string, args: Record<string, unknown>): string[] {
  const missing: string[] = [];
  for (const key of TOOL_REQUIRED[canonical] ?? []) {
    if (key === 'owner' || key === 'repo') {
      // owner/repo may arrive jointly as full_name ("owner/repo").
      if (resolveOwnerRepo(args) === null) {
        if (!missing.includes('owner')) missing.push('owner');
        if (!missing.includes('repo')) missing.push('repo');
      }
      continue;
    }
    if (pickArg(args, key) === undefined || pickArg(args, key) === null) missing.push(key);
  }
  // Deduplicate while preserving order.
  return [...new Set(missing)];
}

function dispatchTool(ctx: any, canonical: string, args: Record<string, unknown>): ToolOutcome {
  switch (canonical) {
    case 'create_repo': return doCreateRepo(ctx, args);
    case 'get_repo': return doGetRepo(ctx, args);
    case 'create_issue': return doCreateIssue(ctx, args);
    case 'list_issues': return doListIssues(ctx, args);
    case 'create_pull_request': return doCreatePullRequest(ctx, args);
    case 'merge_pull_request': return doMergePullRequest(ctx, args);
    default: return { toolError: `Unknown tool: ${canonical}` };
  }
}

// ---------------------------------------------------------------- handler

export async function handleMcp(
  method: string,
  path: string,
  query: URLSearchParams,
  headers: Record<string, string>,
  body: Buffer,
  ctx: any,
): Promise<HandlerResult> {
  void query;
  if (path !== '/mcp') return null;

  const lowered = lowerHeaders(headers);

  // Session teardown: best-effort, always 204.
  if (method === 'DELETE') {
    return { status: 204, headers: {}, body: Buffer.alloc(0) };
  }
  if (method !== 'POST') {
    return jsonReply(405, { message: 'Method Not Allowed' });
  }

  // Auth first, before parsing or dispatch (spec B.6/B.8).
  if (!isAuthed(ctx, lowered)) {
    return jsonReply(401, { message: 'Unauthorized' });
  }

  // Non-JSON body -> HTTP 400 + JSON-RPC -32700 (modern transport).
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return {
      status: 400,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: JSON_RPC_PARSE_ERROR, message: 'Parse error' } }), 'utf8'),
    };
  }
  if (!isRecord(parsed)) {
    return rpcError(null, JSON_RPC_INVALID_REQUEST, 'Invalid Request');
  }

  const id: RpcId = typeof parsed.id === 'string' || typeof parsed.id === 'number' ? parsed.id : null;
  const hasId = parsed.id !== undefined && parsed.id !== null;
  const rpcMethod = parsed.method;
  if (typeof rpcMethod !== 'string' || rpcMethod === '') {
    return rpcError(id, JSON_RPC_INVALID_REQUEST, 'Invalid Request');
  }
  const params: Record<string, unknown> = isRecord(parsed.params) ? parsed.params : {};

  // Notifications (no id) get a 202 with an empty body and no JSON-RPC reply.
  if (!hasId) {
    if (rpcMethod.startsWith('notifications/')) {
      return { status: 202, headers: {}, body: Buffer.alloc(0) };
    }
    // Any other id-less message is still a notification: acknowledge it.
    return { status: 202, headers: {}, body: Buffer.alloc(0) };
  }

  // Protocol-version negotiation (except initialize, which negotiates
  // through params.protocolVersion below). An unsupported declared
  // revision is -32022 with data.supported; a missing declaration is
  // accepted (never a strict header failure).
  if (rpcMethod !== 'initialize') {
    const declared = declaredVersion(lowered, params);
    if (declared !== null && !isSupportedVersion(declared)) {
      return rpcError(id, JSON_RPC_UNSUPPORTED_VERSION, 'Unsupported protocol version', { supported: [...SUPPORTED_VERSIONS] });
    }
  }

  const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };

  switch (rpcMethod) {
    case 'server/discover': {
      const declared = declaredVersion(lowered, params);
      if (declared !== null && !isSupportedVersion(declared)) {
        return rpcError(id, JSON_RPC_UNSUPPORTED_VERSION, 'Unsupported protocol version', { supported: [...SUPPORTED_VERSIONS] });
      }
      return rpcResult(id, {
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: { ...serverInfo },
        _meta: { 'io.modelcontextprotocol/serverInfo': { ...serverInfo } },
      });
    }

    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
      const declared = declaredVersion(lowered, params);
      const chosen = offered !== null && isSupportedVersion(offered)
        ? offered
        : declared !== null && isSupportedVersion(declared)
          ? declared
          : LEGACY_DEFAULT_VERSION;
      if (offered !== null && !isSupportedVersion(offered)) {
        // The client retries the next legacy revision on -32602.
        return rpcError(id, JSON_RPC_INVALID_PARAMS, `Unsupported protocol version: ${offered}`);
      }
      return rpcResult(id, {
        protocolVersion: chosen,
        capabilities: { tools: {} },
        serverInfo: { ...serverInfo },
      });
    }

    case 'ping': {
      return rpcResult(id, {});
    }

    case 'tools/list': {
      // Single page, no nextCursor; the frozen literal is byte-identical
      // across calls. Return a fresh object wrapper each time (the tools
      // array itself is the same frozen value, so serialization is stable).
      return rpcResult(id, { tools: TOOLS });
    }

    case 'tools/call': {
      const name = params.name;
      if (typeof name !== 'string' || name === '') {
        return rpcError(id, JSON_RPC_INVALID_PARAMS, 'Missing required parameter: name');
      }
      const canonical = canonicalToolName(name);
      if (canonical === null) {
        return rpcError(id, JSON_RPC_INVALID_PARAMS, `Unknown tool: ${name}`);
      }
      const args: Record<string, unknown> = isRecord(params.arguments) ? params.arguments : {};
      const missing = missingRequired(canonical, args);
      if (missing.length > 0) {
        return rpcError(id, JSON_RPC_INVALID_PARAMS, `Missing required argument(s): ${missing.join(', ')}`);
      }
      try {
        const outcome = dispatchTool(ctx, canonical, args);
        if ('toolError' in outcome) {
          return rpcResult(id, toolErrorResult(outcome.toolError));
        }
        return rpcResult(id, outcome.result);
      } catch (err) {
        // Never HTTP 500 for a tools/call problem: report as a tool error.
        return rpcResult(id, toolErrorResult(err instanceof Error ? err.message : String(err)));
      }
    }

    default: {
      if (rpcMethod.startsWith('notifications/')) {
        return rpcResult(id, {});
      }
      return rpcError(id, JSON_RPC_METHOD_NOT_FOUND, `Method not found: ${rpcMethod}`);
    }
  }
}
