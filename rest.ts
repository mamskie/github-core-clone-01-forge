// REST v3 module for the make.fun forge.
// Node 22 TypeScript, stdlib only. Deterministic: no Date.now(), no Math.random();
// timestamps come from FIXED_ISO and commit epochs from the store.
import { FIXED_ISO } from './scenario.ts';
import type { Repo, Issue, Pull } from './store.ts';

export interface RestResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

type Ctx = any;

const JSON_CT = 'application/json';

function requestId(ctx: Ctx): string {
  if (ctx.requestId !== undefined && ctx.requestId !== null && String(ctx.requestId) !== '') {
    return String(ctx.requestId);
  }
  const n = ctx.store && typeof ctx.store.nextRequestId === 'number' ? ctx.store.nextRequestId++ : 1;
  return `req-${n}`;
}

function json(ctx: Ctx, status: number, data: unknown, extra: Record<string, string> = {}): RestResponse {
  return {
    status,
    headers: { 'content-type': JSON_CT, 'x-github-request-id': requestId(ctx), ...extra },
    body: Buffer.from(JSON.stringify(data), 'utf8'),
  };
}

function noContent(ctx: Ctx): RestResponse {
  return { status: 204, headers: { 'x-github-request-id': requestId(ctx) }, body: Buffer.alloc(0) };
}

function err(ctx: Ctx, status: number, message: string): RestResponse {
  return json(ctx, status, { message });
}

function parseBody(body: Buffer): { ok: true; value: Record<string, any> } | { ok: false } {
  if (!body || body.length === 0) return { ok: true, value: {} };
  try {
    const v = JSON.parse(body.toString('utf8'));
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) return { ok: true, value: v };
    return { ok: true, value: {} };
  } catch {
    return { ok: false };
  }
}

function baseUrl(ctx: Ctx): string {
  return String(ctx.baseUrl ?? '').replace(/\/+$/, '');
}

function viewerLogin(ctx: Ctx): string {
  return ctx.viewer?.login ?? '';
}

function isAuthed(ctx: Ctx, headers: Record<string, string>): boolean {
  if (typeof ctx.authed === 'function') return ctx.authed(headers) === true;
  return true;
}

// ---- serializers ----

function repoJson(ctx: Ctx, repo: Repo): Record<string, any> {
  const owner = repo.owner;
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner, id: ctx.viewer?.id ?? 1000, type: 'User' },
    private: repo.private,
    html_url: `${baseUrl(ctx)}/${owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `${baseUrl(ctx)}/api/v3/repos/${owner}/${repo.name}`,
    default_branch: repo.default_branch,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    pushed_at: FIXED_ISO,
  };
}

function labelJson(label: { name: string; color: string; description?: string }): Record<string, any> {
  return { name: label.name, color: label.color ?? '', description: label.description ?? '' };
}

function issueJson(ctx: Ctx, issue: Issue): Record<string, any> {
  return {
    id: issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map(labelJson),
    user: { login: issue.user.login, id: issue.user.id, type: 'User' },
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
  };
}

function pullJson(ctx: Ctx, repo: Repo, pr: Pull): Record<string, any> {
  const user = { login: pr.user.login, id: pr.user.id, type: 'User' };
  return {
    id: pr.number,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    locked: false,
    user,
    head: { ref: pr.headRef, sha: pr.headSha, label: `${repo.owner}:${pr.headRef}`, user },
    base: { ref: pr.baseRef, sha: pr.baseSha, label: `${repo.owner}:${pr.baseRef}`, user },
    merged: pr.merged,
    merged_at: pr.merged_at,
    merge_commit_sha: pr.merge_commit_sha,
    mergeable: pr.mergeable,
    comments: 0,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    created_at: pr.created_at,
    updated_at: pr.updated_at,
  };
}

// ---- git helpers ----

/** Resolve a branch name or 40-hex commit sha to a commit sha, or null. */
function resolveRef(ctx: Ctx, repo: Repo, ref: string | null | undefined): string | null {
  if (!ref) return repo.refs.get(`refs/heads/${repo.default_branch}`) ?? null;
  const byBranch = repo.refs.get(`refs/heads/${ref}`);
  if (byBranch) return byBranch;
  if (/^[0-9a-f]{40}$/i.test(ref) && ctx.store.hasObject(ref.toLowerCase())) return ref.toLowerCase();
  return null;
}

/** Commits reachable from `tip`, tip first, depth-first through parents. */
function listCommits(ctx: Ctx, tip: string): { sha: string; message: string }[] {
  const out: { sha: string; message: string }[] = [];
  const seen = new Set<string>();
  const visit = (sha: string): void => {
    if (!sha || seen.has(sha)) return;
    seen.add(sha);
    const obj = ctx.store.getObject(sha);
    if (!obj || obj.type !== 'commit') return;
    const info = ctx.store.parseCommit(obj.data);
    out.push({ sha, message: info.message.replace(/\n+$/, '') });
    for (const p of info.parents) visit(p);
  };
  visit(tip);
  return out;
}

function countLines(content: Buffer): number {
  if (content.length === 0) return 0;
  const parts = content.toString('utf8').split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

/** Parse a positive int query param with a default. */
function intParam(query: URLSearchParameters, name: string, def: number): number {
  const raw = query.get(name);
  if (raw === null) return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

function paginate<T>(items: T[], query: URLSearchParameters): T[] {
  const perPage = intParam(query, 'per_page', 30);
  const page = intParam(query, 'page', 1);
  return items.slice((page - 1) * perPage, page * perPage);
}

// ---- main handler ----

export async function handleRest(
  method: string,
  path: string,
  query: URLSearchParameters,
  headers: Record<string, string>,
  body: Buffer,
  ctx: Ctx,
): Promise<RestResponse | null> {
  const store = ctx.store;
  if (path !== '/api/v3' && path !== '/api/v3/' && !path.startsWith('/api/v3/')) return null;

  const rest = path === '/api/v3' || path === '/api/v3/' ? '' : path.slice('/api/v3/'.length);
  const segments = rest === '' ? [] : rest.split('/').map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  });
  const m = method.toUpperCase();

  // ---- ungated root + meta ----
  if (segments.length === 0) {
    if (m === 'GET') {
      return json(ctx, 200, {
        current_user_url: '/api/v3/user',
        rate_limit_url: '/api/v3/rate_limit',
      }, { 'x-oauth-scopes': 'repo, read:org' });
    }
    return err(ctx, 404, 'Not Found');
  }
  if (segments.length === 1 && segments[0] === 'meta') {
    if (m === 'GET') return json(ctx, 200, { installed_version: '1.0.0' });
    return err(ctx, 404, 'Not Found');
  }

  // Everything below requires a token.
  const authed = isAuthed(ctx, headers);

  // ---- POST /user/repos, GET /user/repos ----
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (!authed) return err(ctx, 401, 'Requires authentication');
    if (m === 'POST') {
      const parsed = parseBody(body);
      if (!parsed.ok) return err(ctx, 400, 'Problems parsing JSON');
      const b = parsed.value;
      const name = typeof b.name === 'string' ? b.name : '';
      if (name === '') return err(ctx, 422, 'Validation Failed: name is required');
      if (store.getRepo(viewerLogin(ctx), name)) {
        return err(ctx, 422, 'Validation Failed: name already exists on this account');
      }
      const repo = store.createRepo(
        name,
        typeof b.description === 'string' ? b.description : '',
        b.private === true,
      );
      return json(ctx, 201, repoJson(ctx, repo));
    }
    if (m === 'GET') {
      const all = store.listRepos().filter((r: Repo) => r.owner === viewerLogin(ctx));
      const perPage = intParam(query, 'per_page', 30);
      const page = intParam(query, 'page', 1);
      const slice = all.slice((page - 1) * perPage, page * perPage);
      const extra: Record<string, string> = {};
      if (page * perPage < all.length) {
        extra.link = `<${baseUrl(ctx)}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}>; rel="next"`;
      }
      return json(ctx, 200, slice.map((r: Repo) => repoJson(ctx, r)), extra);
    }
    return err(ctx, 404, 'Not Found');
  }

  // ---- /repos/{o}/{r}[...] ----
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = segments[1];
    const name = segments[2];
    const tail = segments.slice(3);

    if (!authed) return err(ctx, 401, 'Requires authentication');
    // Foreign owner is 404, never 403 — checked before repo existence.
    if (owner !== viewerLogin(ctx)) return err(ctx, 404, 'Not Found');
    const repo: Repo | undefined = store.getRepo(owner, name);
    if (!repo) return err(ctx, 404, 'Not Found');

    // GET / PATCH / DELETE /repos/{o}/{r}
    if (tail.length === 0) {
      if (m === 'GET') return json(ctx, 200, repoJson(ctx, repo));
      if (m === 'PATCH') {
        const parsed = parseBody(body);
        if (!parsed.ok) return err(ctx, 400, 'Problems parsing JSON');
        if (typeof parsed.value.description === 'string') repo.description = parsed.value.description;
        if (typeof parsed.value.default_branch === 'string' && parsed.value.default_branch !== '') {
          repo.default_branch = parsed.value.default_branch;
        }
        return json(ctx, 200, repoJson(ctx, repo));
      }
      if (m === 'DELETE') {
        store.deleteRepo(owner, name);
        return noContent(ctx);
      }
      return err(ctx, 404, 'Not Found');
    }

    // POST /git/refs
    if (tail.length === 2 && tail[0] === 'git' && tail[1] === 'refs') {
      if (m !== 'POST') return err(ctx, 404, 'Not Found');
      const parsed = parseBody(body);
      if (!parsed.ok) return err(ctx, 400, 'Problems parsing JSON');
      const ref = typeof parsed.value.ref === 'string' ? parsed.value.ref : '';
      const sha = typeof parsed.value.sha === 'string' ? parsed.value.sha.toLowerCase() : '';
      if (!ref.startsWith('refs/heads/') || !/^[0-9a-f]{40}$/.test(sha)) {
        return err(ctx, 422, 'Validation Failed: ref and sha are required');
      }
      if (!store.hasObject(sha)) return err(ctx, 422, 'Validation Failed: sha does not exist');
      repo.refs.set(ref, sha);
      return json(ctx, 201, {
        ref,
        node_id: `REF_${repo.id}_${ref}`,
        url: `${baseUrl(ctx)}/api/v3/repos/${owner}/${name}/git/refs/${encodeURIComponent(ref)}`,
        object: { sha, type: 'commit', url: `${baseUrl(ctx)}/api/v3/repos/${owner}/${name}/git/commits/${sha}` },
      });
    }

    // GET /branches
    if (tail.length === 1 && tail[0] === 'branches') {
      if (m !== 'GET') return err(ctx, 404, 'Not Found');
      const branches: { name: string; commit: { sha: string } }[] = [];
      for (const [ref, sha] of repo.refs) {
        if (ref.startsWith('refs/heads/')) branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha } });
      }
      branches.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return json(ctx, 200, branches);
    }

    // GET /commits
    if (tail.length === 1 && tail[0] === 'commits') {
      if (m !== 'GET') return err(ctx, 404, 'Not Found');
      const tip = resolveRef(ctx, repo, query.get('sha'));
      if (!tip) return json(ctx, 200, []);
      const commits = listCommits(ctx, tip).map((c) => ({
        sha: c.sha,
        node_id: `C_${c.sha}`,
        commit: {
          message: c.message,
          author: { name: ctx.viewer?.name ?? '', email: ctx.viewer?.email ?? '', date: FIXED_ISO },
          committer: { name: ctx.viewer?.name ?? '', email: ctx.viewer?.email ?? '', date: FIXED_ISO },
        },
        author: { login: ctx.viewer?.login ?? '' },
        committer: { login: ctx.viewer?.login ?? '' },
      }));
      return json(ctx, 200, commits);
    }

    // /contents/{path...}
    if (tail.length >= 2 && tail[0] === 'contents') {
      const filePath = tail.slice(1).join('/');
      if (m === 'PUT') {
        const parsed = parseBody(body);
        if (!parsed.ok) return err(ctx, 400, 'Problems parsing JSON');
        const b = parsed.value;
        const branch = typeof b.branch === 'string' && b.branch !== '' ? b.branch : repo.default_branch;
        const message = typeof b.message === 'string' && b.message !== '' ? b.message : `Update ${filePath}`;
        const contentB64 = typeof b.content === 'string' ? b.content : '';
        const content = Buffer.from(contentB64.replace(/[\r\n\t ]/g, ''), 'base64');
        const tip = repo.refs.get(`refs/heads/${branch}`);
        const current = tip ? store.fileAtCommit(tip, filePath) : null;
        if (typeof b.sha === 'string' && b.sha !== '') {
          // Update path: the file must exist and the sha must be current.
          if (!current) return err(ctx, 404, 'Not Found');
          if (current.blobSha.toLowerCase() !== b.sha.toLowerCase()) {
            return err(ctx, 409, 'Conflict: sha does not match the current blob');
          }
        }
        const isCreate = current === null;
        const { commitSha, blobSha } = store.commitFile(repo, branch, filePath, content, message);
        return json(ctx, isCreate ? 201 : 200, {
          content: {
            name: filePath.split('/').pop() ?? filePath,
            path: filePath,
            sha: blobSha,
            size: content.length,
            type: 'file',
            encoding: 'base64',
            content: content.toString('base64'),
          },
          commit: { sha: commitSha, message },
        });
      }
      if (m === 'GET') {
        const tip = resolveRef(ctx, repo, query.get('ref'));
        if (!tip) return err(ctx, 404, 'Not Found');
        const file = store.fileAtCommit(tip, filePath);
        if (file) {
          return json(ctx, 200, {
            name: filePath.split('/').pop() ?? filePath,
            path: filePath,
            sha: file.blobSha,
            size: file.content.length,
            type: 'file',
            encoding: 'base64',
            content: file.content.toString('base64'),
          });
        }
        const dir = store.dirAtCommit(tip, filePath);
        if (dir && dir.length > 0) {
          return json(ctx, 200, dir.map((e: { name: string; path: string; sha: string; type: 'file' | 'dir' }) => ({
            name: e.name,
            path: e.path,
            sha: e.sha,
            type: e.type,
            size: 0,
          })));
        }
        return err(ctx, 404, 'Not Found');
      }
      if (m === 'DELETE') {
        const parsed = parseBody(body);
        if (!parsed.ok) return err(ctx, 400, 'Problems parsing JSON');
        const b = parsed.value;
        const branch = typeof b.branch === 'string' && b.branch !== '' ? b.branch : repo.default_branch;
        const message = typeof b.message === 'string' && b.message !== '' ? b.message : `Delete ${filePath}`;
        const commitSha = store.deleteFile(repo, branch, filePath, message);
        if (commitSha === null) return err(ctx, 404, 'Not Found');
        return json(ctx, 200, { content: null, commit: { sha: commitSha, message } });
      }
      return err(ctx, 404, 'Not Found');
    }

    // POST /labels
    if (tail.length === 1 && tail[0] === 'labels') {
      if (m !== 'POST') return err(ctx, 404, 'Not Found');
      const parsed = parseBody(body);
      if (!parsed.ok) return err(ctx, 400, 'Problems parsing JSON');
      const b = parsed.value;
      const labelName = typeof b.name === 'string' ? b.name : '';
      if (labelName === '') return err(ctx, 422, 'Validation Failed: name is required');
      const label = {
        name: labelName,
        color: typeof b.color === 'string' ? b.color : 'ededed',
        description: typeof b.description === 'string' ? b.description : '',
      };
      repo.labels.set(labelName, label);
      return json(ctx, 201, labelJson(label));
    }

    // /issues...
    if (tail.length >= 1 && tail[0] === 'issues') {
      if (tail.length === 1) {
        if (m === 'POST') {
          const parsed = parseBody(body);
          if (!parsed.ok) return err(ctx, 400, 'Problems parsing JSON');
          const b = parsed.value;
          const names: string[] = Array.isArray(b.labels) ? b.labels.filter((x: unknown) => typeof x === 'string') : [];
          const labels: { name: string; color: string; description: string }[] = [];
          for (const n of names) {
            const found = repo.labels.get(n);
            if (!found) return err(ctx, 422, `Validation Failed: label "${n}" does not exist`);
            labels.push(found);
          }
          const number = repo.nextNumber++;
          const issue: Issue = {
            number,
            title: typeof b.title === 'string' ? b.title : '',
            body: typeof b.body === 'string' ? b.body : '',
            state: 'open',
            labels,
            comments: [],
            user: ctx.viewer,
            created_at: FIXED_ISO,
            updated_at: FIXED_ISO,
            seq: store.nextSeq(),
          };
          repo.issues.set(number, issue);
          return json(ctx, 201, issueJson(ctx, issue));
        }
        if (m === 'GET') {
          let list = [...repo.issues.values()];
          const state = query.get('state') ?? 'open';
          if (state !== 'all') list = list.filter((i) => i.state === state);
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          if (sort === 'created') {
            list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          }
          return json(ctx, 200, paginate(list, query).map((i) => issueJson(ctx, i)));
        }
        return err(ctx, 404, 'Not Found');
      }
      const num = Number(tail[1]);
      if (!Number.isInteger(num) || num < 1) return err(ctx, 404, 'Not Found');
      const issue = repo.issues.get(num);
      if (tail.length === 2) {
        if (!issue) return err(ctx, 404, 'Not Found');
        if (m === 'GET') return json(ctx, 200, issueJson(ctx, issue));
        if (m === 'PATCH') {
          const parsed = parseBody(body);
          if (!parsed.ok) return err(ctx, 400, 'Problems parsing JSON');
          const b = parsed.value;
          if (b.state === 'open' || b.state === 'closed') issue.state = b.state;
          if (typeof b.title === 'string') issue.title = b.title;
          if (typeof b.body === 'string') issue.body = b.body;
          issue.updated_at = FIXED_ISO;
          return json(ctx, 200, issueJson(ctx, issue));
        }
        return err(ctx, 404, 'Not Found');
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (!issue) return err(ctx, 404, 'Not Found');
        if (m === 'POST') {
          const parsed = parseBody(body);
          if (!parsed.ok) return err(ctx, 400, 'Problems parsing JSON');
          const comment = {
            id: repo.nextCommentId++,
            body: typeof parsed.value.body === 'string' ? parsed.value.body : '',
            user: ctx.viewer,
            created_at: FIXED_ISO,
            updated_at: FIXED_ISO,
          };
          issue.comments.push(comment);
          return json(ctx, 201, {
            id: comment.id,
            body: comment.body,
            user: { login: ctx.viewer?.login ?? '' },
            created_at: comment.created_at,
            updated_at: comment.updated_at,
          });
        }
        if (m === 'GET') {
          return json(ctx, 200, issue.comments.map((c) => ({
            id: c.id,
            body: c.body,
            user: { login: c.user?.login ?? ctx.viewer?.login ?? '' },
            created_at: c.created_at,
            updated_at: c.updated_at,
          })));
        }
        return err(ctx, 404, 'Not Found');
      }
      return err(ctx, 404, 'Not Found');
    }

    // /pulls...
    if (tail.length >= 1 && tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (m === 'POST') {
          const parsed = parseBody(body);
          if (!parsed.ok) return err(ctx, 400, 'Problems parsing JSON');
          const b = parsed.value;
          const headRef = typeof b.head === 'string' ? b.head : '';
          const baseRef = typeof b.base === 'string' ? b.base : repo.default_branch;
          const headSha = repo.refs.get(`refs/heads/${headRef}`);
          const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
          if (!headSha || !baseSha) return err(ctx, 404, 'Not Found');
          const number = repo.nextNumber++;
          const pr: Pull = {
            number,
            title: typeof b.title === 'string' ? b.title : '',
            body: typeof b.body === 'string' ? b.body : '',
            state: 'open',
            headRef,
            baseRef,
            headSha,
            baseSha,
            merged: false,
            merged_at: null,
            merge_commit_sha: null,
            mergeable: true,
            user: ctx.viewer,
            created_at: FIXED_ISO,
            updated_at: FIXED_ISO,
            seq: store.nextSeq(),
          };
          repo.pulls.set(number, pr);
          return json(ctx, 201, pullJson(ctx, repo, pr));
        }
        if (m === 'GET') {
          let list = [...repo.pulls.values()];
          const state = query.get('state');
          if (state === 'all') {
            // keep all
          } else if (state === 'closed') {
            list = list.filter((p) => p.state === 'closed');
          } else {
            list = list.filter((p) => p.state === 'open');
          }
          list.sort((a, b) => b.seq - a.seq);
          return json(ctx, 200, paginate(list, query).map((p) => pullJson(ctx, repo, p)));
        }
        return err(ctx, 404, 'Not Found');
      }
      const num = Number(tail[1]);
      if (!Number.isInteger(num) || num < 1) return err(ctx, 404, 'Not Found');
      const pr = repo.pulls.get(num);
      if (tail.length === 2) {
        if (!pr) return err(ctx, 404, 'Not Found');
        if (m === 'GET') return json(ctx, 200, pullJson(ctx, repo, pr));
        return err(ctx, 404, 'Not Found');
      }
      if (tail.length === 3 && tail[2] === 'files') {
        if (!pr) return err(ctx, 404, 'Not Found');
        if (m !== 'GET') return err(ctx, 404, 'Not Found');
        const baseInfo = store.parseCommit(store.getObject(pr.baseSha)!.data);
        const headTip = repo.refs.get(`refs/heads/${pr.headRef}`) ?? pr.headSha;
        const headInfo = store.parseCommit(store.getObject(headTip)!.data);
        const diff = store.diffTrees(baseInfo.tree, headInfo.tree);
        const files = [...diff.entries()].map(([filename, d]) => {
          let additions = 0;
          let deletions = 0;
          if (d.headSha) {
            const blob = store.getObject(d.headSha);
            additions = blob ? countLines(blob.data) : 0;
          }
          if (d.baseSha) {
            const blob = store.getObject(d.baseSha);
            deletions = blob ? countLines(blob.data) : 0;
          }
          return {
            filename,
            status: d.status === 'deleted' ? 'removed' : d.status,
            additions,
            deletions,
            changes: additions + deletions,
            sha: d.headSha ?? d.baseSha,
          };
        });
        files.sort((a, b) => (a.filename < b.filename ? -1 : 1));
        return json(ctx, 200, files);
      }
      if (tail.length === 3 && tail[2] === 'merge') {
        if (!pr) return err(ctx, 404, 'Not Found');
        if (m !== 'PUT') return err(ctx, 404, 'Not Found');
        const parsed = parseBody(body);
        if (!parsed.ok) return err(ctx, 400, 'Problems parsing JSON');
        if (pr.state !== 'open' || pr.merged) {
          return err(ctx, 405, 'Pull request is already merged or closed');
        }
        const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
        const headTip = repo.refs.get(`refs/heads/${pr.headRef}`) ?? pr.headSha;
        if (!baseTip || !headTip) return err(ctx, 404, 'Not Found');
        const baseAtCreation = store.parseCommit(store.getObject(pr.baseSha)!.data);
        const headInfo = store.parseCommit(store.getObject(headTip)!.data);
        const currentBaseInfo = store.parseCommit(store.getObject(baseTip)!.data);
        const headDiff = store.diffTrees(baseAtCreation.tree, headInfo.tree);
        const baseDiff = store.diffTrees(baseAtCreation.tree, currentBaseInfo.tree);
        for (const [p] of headDiff) {
          if (baseDiff.has(p)) {
            return err(ctx, 405, 'Merge conflict: the head branch conflicts with the base branch');
          }
        }
        // Squash: one commit on the default/base branch with the head's content applied.
        const mergedFiles = store.flattenTree(currentBaseInfo.tree);
        for (const [p, d] of headDiff) {
          if (d.status === 'deleted') mergedFiles.delete(p);
          else if (d.headSha) mergedFiles.set(p, { mode: '100644', sha: d.headSha });
        }
        const treeSha = store.buildTree(mergedFiles);
        const mergeSha = store.createCommit(
          treeSha,
          [baseTip],
          `Merge pull request #${pr.number} from ${pr.headRef}`,
        );
        repo.refs.set(`refs/heads/${pr.baseRef}`, mergeSha);
        pr.state = 'closed';
        pr.merged = true;
        pr.merged_at = FIXED_ISO;
        pr.merge_commit_sha = mergeSha;
        pr.mergeable = false;
        pr.updated_at = FIXED_ISO;
        return json(ctx, 200, {
          merged: true,
          sha: mergeSha,
          message: 'Pull request successfully merged',
        });
      }
      return err(ctx, 404, 'Not Found');
    }

    return err(ctx, 404, 'Not Found');
  }

  // Any other unmatched route under /api/v3.
  return err(ctx, 404, 'Not Found');
}
