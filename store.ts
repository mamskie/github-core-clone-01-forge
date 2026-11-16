// Shared in-memory store for the forge: git objects + repos + issues + PRs.
// All four surfaces (git smart HTTP, REST v3, GraphQL, MCP) read/write this one store.
// Deterministic: no Date.now(), no Math.random() — created order uses a monotonic
// sequence counter, timestamps are FIXED_ISO, commit epochs are FIXED_EPOCH.
import { createHash } from 'node:crypto';
import { VIEWER, FIXED_EPOCH, FIXED_ISO, DEFAULT_BRANCH } from './scenario.ts';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject { type: ObjType; data: Buffer; }
export interface TreeEntry { mode: string; name: string; sha: string; }
export interface CommitInfo {
  tree: string; parents: string[]; authorName: string; authorEmail: string;
  authorEpoch: number; committerName: string; committerEmail: string;
  committerEpoch: number; message: string;
}
export interface Label { name: string; color: string; description: string; }
export interface Comment { id: number; body: string; user: typeof VIEWER; created_at: string; updated_at: string; }
export interface Issue {
  number: number; title: string; body: string; state: 'open' | 'closed';
  labels: Label[]; comments: Comment[]; user: typeof VIEWER;
  created_at: string; updated_at: string; seq: number;
}
export interface Pull {
  number: number; title: string; body: string; state: 'open' | 'closed';
  headRef: string; baseRef: string; headSha: string; baseSha: string;
  merged: boolean; merged_at: string | null; merge_commit_sha: string | null;
  mergeable: boolean; user: typeof VIEWER; created_at: string; updated_at: string; seq: number;
}
export interface Repo {
  id: number; name: string; owner: string; description: string; private: boolean;
  default_branch: string;
  refs: Map<string, string>; // full ref name -> commit sha. Absent = unborn / no refs.
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextNumber: number; // shared issues+PRs counter, starts at 1
  nextCommentId: number;
  seq: number;
}

export function sha1Of(type: ObjType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(`${type} ${data.length}\0`);
  h.update(data);
  return h.digest('hex');
}

export class Store {
  objects = new Map<string, GitObject>();
  repos = new Map<string, Repo>(); // key `${owner}/${name}`
  nextRepoId = 5000;
  seq = 0;
  nextRequestId = 1;

  nextSeq(): number { return ++this.seq; }

  putObject(type: ObjType, data: Buffer): string {
    const sha = sha1Of(type, data);
    if (!this.objects.has(sha)) this.objects.set(sha, { type, data });
    return sha;
  }
  getObject(sha: string): GitObject | undefined { return this.objects.get(sha); }
  hasObject(sha: string): boolean { return this.objects.has(sha); }

  createRepo(name: string, description: string, priv: boolean): Repo {
    const repo: Repo = {
      id: this.nextRepoId++, name, owner: VIEWER.login, description, private: priv,
      default_branch: DEFAULT_BRANCH, refs: new Map(), labels: new Map(),
      issues: new Map(), pulls: new Map(), nextNumber: 1, nextCommentId: 1, seq: this.nextSeq(),
    };
    this.repos.set(`${VIEWER.login}/${name}`, repo);
    return repo;
  }
  getRepo(owner: string, name: string): Repo | undefined { return this.repos.get(`${owner}/${name}`); }
  deleteRepo(owner: string, name: string): boolean { return this.repos.delete(`${owner}/${name}`); }
  listRepos(): Repo[] { return [...this.repos.values()].sort((a, b) => a.seq - b.seq); }

  // ---- git object helpers ----
  parseTree(data: Buffer): TreeEntry[] {
    const out: TreeEntry[] = [];
    let i = 0;
    while (i < data.length) {
      const sp = data.indexOf(0x20, i);
      const mode = data.subarray(i, sp).toString('ascii');
      const nul = data.indexOf(0, sp + 1);
      const name = data.subarray(sp + 1, nul).toString('utf8');
      const sha = data.subarray(nul + 1, nul + 21).toString('hex');
      out.push({ mode, name, sha });
      i = nul + 21;
    }
    return out;
  }
  encodeTree(entries: TreeEntry[]): Buffer {
    const sorted = [...entries].sort((a, b) => {
      const an = a.mode === '40000' ? a.name + '/' : a.name;
      const bn = b.mode === '40000' ? b.name + '/' : b.name;
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
    const parts: Buffer[] = [];
    for (const e of sorted) {
      parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
      parts.push(Buffer.from(e.sha, 'hex'));
    }
    return Buffer.concat(parts);
  }
  /** Build a tree from a flat path -> {mode, sha} map. Returns root tree sha. */
  buildTree(files: Map<string, { mode: string; sha: string }>): string {
    // group by first path segment
    const build = (prefix: string): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Map<string, Map<string, { mode: string; sha: string }>>();
      for (const [path, v] of files) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash === -1) entries.push({ mode: v.mode, name: rest, sha: v.sha });
        else {
          const dir = rest.slice(0, slash);
          let sub = dirs.get(dir);
          if (!sub) { sub = new Map(); dirs.set(dir, sub); }
          sub.set(path, v);
        }
      }
      for (const dir of [...dirs.keys()].sort()) {
        entries.push({ mode: '40000', name: dir, sha: build(prefix + dir + '/') });
      }
      return this.putObject('tree', this.encodeTree(entries));
    };
    return build('');
  }
  /** Flatten a tree (by commit sha or tree sha) to path -> {mode, sha}. */
  flattenTree(treeSha: string): Map<string, { mode: string; sha: string }> {
    const out = new Map<string, { mode: string; sha: string }>();
    const walk = (sha: string, prefix: string) => {
      const obj = this.objects.get(sha);
      if (!obj || obj.type !== 'tree') return;
      for (const e of this.parseTree(obj.data)) {
        if (e.mode === '40000') walk(e.sha, prefix + e.name + '/');
        else out.set(prefix + e.name, { mode: e.mode, sha: e.sha });
      }
    };
    walk(treeSha, '');
    return out;
  }
  parseCommit(data: Buffer): CommitInfo {
    const text = data.toString('utf8');
    const idx = text.indexOf('\n\n');
    const head = idx === -1 ? text : text.slice(0, idx);
    const message = idx === -1 ? '' : text.slice(idx + 2);
    const info: CommitInfo = {
      tree: '', parents: [], authorName: '', authorEmail: '', authorEpoch: FIXED_EPOCH,
      committerName: '', committerEmail: '', committerEpoch: FIXED_EPOCH, message,
    };
    for (const line of head.split('\n')) {
      if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
      else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
      else if (line.startsWith('author ')) {
        const m = line.slice(7).match(/^(.*) <(.*)> (\d+) ([+-]\d+)$/);
        if (m) { info.authorName = m[1]; info.authorEmail = m[2]; info.authorEpoch = parseInt(m[3], 10); }
      } else if (line.startsWith('committer ')) {
        const m = line.slice(10).match(/^(.*) <(.*)> (\d+) ([+-]\d+)$/);
        if (m) { info.committerName = m[1]; info.committerEmail = m[2]; info.committerEpoch = parseInt(m[3], 10); }
      }
    }
    return info;
  }
  createCommit(treeSha: string, parents: string[], message: string,
    authorName = VIEWER.name, authorEmail = VIEWER.email, epoch = FIXED_EPOCH): string {
    const msg = message.endsWith('\n') ? message : message + '\n';
    let text = `tree ${treeSha}\n`;
    for (const p of parents) text += `parent ${p}\n`;
    text += `author ${authorName} <${authorEmail}> ${epoch} +0000\n`;
    text += `committer ${authorName} <${authorEmail}> ${epoch} +0000\n\n${msg}`;
    return this.putObject('commit', Buffer.from(text, 'utf8'));
  }
  /** All commit shas reachable from `tip` (inclusive), following parents. */
  reachableCommits(tip: string): Set<string> {
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length) {
      const sha = stack.pop()!;
      if (seen.has(sha)) continue;
      const obj = this.objects.get(sha);
      if (!obj || obj.type !== 'commit') continue;
      seen.add(sha);
      for (const p of this.parseCommit(obj.data).parents) stack.push(p);
    }
    return seen;
  }
  isAncestor(anc: string, desc: string): boolean {
    if (anc === desc) return true;
    return this.reachableCommits(desc).has(anc);
  }
  /** Diff base tree -> head tree: path -> {status, baseSha|null, headSha|null} */
  diffTrees(baseTree: string, headTree: string): Map<string, { status: 'added' | 'modified' | 'deleted'; baseSha: string | null; headSha: string | null }> {
    const b = baseTree ? this.flattenTree(baseTree) : new Map();
    const h = headTree ? this.flattenTree(headTree) : new Map();
    const out = new Map<string, { status: 'added' | 'modified' | 'deleted'; baseSha: string | null; headSha: string | null }>();
    for (const [p, v] of h) {
      const bv = b.get(p);
      if (!bv) out.set(p, { status: 'added', baseSha: null, headSha: v.sha });
      else if (bv.sha !== v.sha) out.set(p, { status: 'modified', baseSha: bv.sha, headSha: v.sha });
    }
    for (const [p, v] of b) if (!h.has(p)) out.set(p, { status: 'deleted', baseSha: v.sha, headSha: null });
    return out;
  }
  /** Commit a file change onto a branch: returns new commit sha. */
  commitFile(repo: Repo, branch: string, path: string, content: Buffer, message: string): { commitSha: string; blobSha: string } {
    const blobSha = this.putObject('blob', content);
    const tip = repo.refs.get(`refs/heads/${branch}`);
    const files = tip ? this.flattenTree(this.parseCommit(this.objects.get(tip)!.data).tree) : new Map<string, { mode: string; sha: string }>();
    files.set(path, { mode: '100644', sha: blobSha });
    const treeSha = this.buildTree(files);
    const commitSha = this.createCommit(treeSha, tip ? [tip] : [], message);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { commitSha, blobSha };
  }
  deleteFile(repo: Repo, branch: string, path: string, message: string): string | null {
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (!tip) return null;
    const files = this.flattenTree(this.parseCommit(this.objects.get(tip)!.data).tree);
    if (!files.has(path)) return null;
    files.delete(path);
    const treeSha = this.buildTree(files);
    const commitSha = this.createCommit(treeSha, [tip], message);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return commitSha;
  }
  fileAtCommit(commitSha: string, path: string): { blobSha: string; content: Buffer } | null {
    const obj = this.objects.get(commitSha);
    if (!obj || obj.type !== 'commit') return null;
    const files = this.flattenTree(this.parseCommit(obj.data).tree);
    const f = files.get(path);
    if (!f) return null;
    const blob = this.objects.get(f.sha);
    if (!blob) return null;
    return { blobSha: f.sha, content: blob.data };
  }
  dirAtCommit(commitSha: string, dirPath: string): { name: string; path: string; sha: string; type: 'file' | 'dir' }[] | null {
    const obj = this.objects.get(commitSha);
    if (!obj || obj.type !== 'commit') return null;
    const files = this.flattenTree(this.parseCommit(obj.data).tree);
    const prefix = dirPath === '' ? '' : dirPath.replace(/\/$/, '') + '/';
    const out = new Map<string, { name: string; path: string; sha: string; type: 'file' | 'dir' }>();
    for (const [p, v] of files) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) out.set(rest, { name: rest, path: p, sha: v.sha, type: 'file' });
      else {
        const dir = rest.slice(0, slash);
        if (!out.has(dir)) {
          // dir sha: find tree sha for this dir by walking
          out.set(dir, { name: dir, path: prefix + dir, sha: v.sha, type: 'dir' });
        }
      }
    }
    // fix dir shas: recompute tree shas for directories
    const treeSha = this.parseCommit(obj.data).tree;
    const walk = (sha: string, pref: string) => {
      const o = this.objects.get(sha);
      if (!o || o.type !== 'tree') return;
      for (const e of this.parseTree(o.data)) {
        const full = pref + e.name;
        if (e.mode === '40000') {
          if (full === prefix.slice(0, -1) || (prefix !== '' && full.startsWith(prefix))) {
            const rel = full.slice(prefix.length);
            if (rel && !rel.includes('/')) {
              const ex = out.get(rel);
              if (ex) ex.sha = e.sha;
            }
          }
          walk(e.sha, full + '/');
        }
      }
    };
    if (prefix !== '') walk(treeSha, '');
    return [...out.values()].sort((a, b) => a.name < b.name ? -1 : 1);
  }
}

export const store = new Store();
export { VIEWER, FIXED_ISO, DEFAULT_BRANCH };
