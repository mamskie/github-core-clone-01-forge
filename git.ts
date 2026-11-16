// Git smart-HTTP (protocol v0 / v2) for the make.fun forge.
//
// Serves `/{owner}/{repo}.git/info/refs`, `git-upload-pack` and
// `git-receive-pack` against the shared Store (see store.ts). Node 22
// TypeScript, stdlib only (node:crypto, node:zlib). No git binary, no
// wall clock, no randomness: every byte the server emits is a function
// of the store and the request.
//
// The single entry point is `handleGit` (see the bottom of this file).
// It returns `null` for paths that are not git routes; anything else is
// handled here, including auth (401), unknown repos (404) and malformed
// pkt-lines (400) — the server never crashes on bad input.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------------------------
// constants & tiny helpers
// ---------------------------------------------------------------------------------------------

export const ZERO_OID = '0'.repeat(40);
const HEAD_REF = 'refs/heads/main';
const PKT_LINE_MAX = 65520;
const PKT_PAYLOAD_MAX = PKT_LINE_MAX - 4;
/** Pack bytes per sideband data packet: 1 band byte + payload, framed as one pkt-line. */
const SIDEBAND_CHUNK = 65515;
const AGENT = 'makefun-git/1.0';
const HEX40 = /^[0-9a-f]{40}$/;
const HEX4 = /^[0-9a-fA-F]{4}$/;

type GitResponse = { status: number; headers: Record<string, string>; body: Buffer };

function okGit(contentType: string, body: Buffer): GitResponse {
  return { status: 200, headers: { 'content-type': contentType }, body };
}
function jsonResponse(status: number, obj: unknown): GitResponse {
  return { status, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(obj), 'utf8') };
}
function textResponse(status: number, text: string): GitResponse {
  return { status, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: Buffer.from(text, 'utf8') };
}
function badRequest(message: string): GitResponse {
  return jsonResponse(400, { message });
}

function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}
/** git object id: SHA-1 over `<type> <size>\0` + bytes. */
function hashObject(type: string, data: Buffer): string {
  const h = createHash('sha1');
  h.update(`${type} ${data.length}\0`, 'utf8');
  h.update(data);
  return h.digest('hex');
}

function headerLookup(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) out[k.toLowerCase()] = v;
  return out;
}

// ---------------------------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------------------------

type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_PAYLOAD_MAX) throw new Error('pkt-line payload too long');
  const head = Buffer.alloc(4);
  head.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, data]);
}
const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

function pktLines(items: Array<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(FLUSH);
    else if (item === 'delim') parts.push(DELIM);
    else parts.push(pkt(item));
  }
  return Buffer.concat(parts);
}

/** Strictly decode every pkt-line in `buf`; throws on any malformed framing. */
function decodePackets(buf: Buffer): Packet[] {
  const out: Packet[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line header');
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!HEX4.test(head)) throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    const len = parseInt(head, 16);
    if (len === 0) { out.push({ kind: 'flush' }); off += 4; continue; }
    if (len === 1) { out.push({ kind: 'delim' }); off += 4; continue; }
    if (len === 2) { out.push({ kind: 'response-end' }); off += 4; continue; }
    if (len === 3) throw new Error('invalid pkt-line length 0003');
    if (len > PKT_LINE_MAX) throw new Error(`pkt-line length ${len} exceeds ${PKT_LINE_MAX}`);
    if (off + len > buf.length) throw new Error('truncated pkt-line');
    out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return out;
}

/**
 * Decode pkt-lines up to and including the first flush packet; returns the
 * packets and the byte offset just past the flush. Used by receive-pack,
 * where raw pack bytes follow the command list. Throws when no flush exists.
 */
function decodePacketsUntilFlush(buf: Buffer): { packets: Packet[]; consumed: number } {
  const out: Packet[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line header');
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!HEX4.test(head)) throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    const len = parseInt(head, 16);
    if (len === 0) { out.push({ kind: 'flush' }); return { packets: out, consumed: off + 4 }; }
    if (len === 1) { out.push({ kind: 'delim' }); off += 4; continue; }
    if (len === 2) { out.push({ kind: 'response-end' }); off += 4; continue; }
    if (len === 3) throw new Error('invalid pkt-line length 0003');
    if (len > PKT_LINE_MAX) throw new Error(`pkt-line length ${len} exceeds ${PKT_LINE_MAX}`);
    if (off + len > buf.length) throw new Error('truncated pkt-line');
    out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  throw new Error('pkt-line stream has no flush packet');
}

/** The text of every data packet, control packets dropped. */
function packetLines(packets: readonly Packet[]): string[] {
  const lines: string[] = [];
  for (const p of packets) if (p.kind === 'data') lines.push(p.payload.toString('utf8'));
  return lines;
}

// ---------------------------------------------------------------------------------------------
// packfile write / read (v2/v3, zlib, OFS/REF deltas)
// ---------------------------------------------------------------------------------------------

const TYPE_CODE: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, string> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packObjectHeader(type: string, size: number): Buffer {
  const code = TYPE_CODE[type];
  if (code === undefined) throw new Error(`unknown object type ${type}`);
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile (version 2, plain objects, no deltas) from the given objects. */
function writePack(objects: ReadonlyArray<{ type: string; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarint(buf: Buffer, off: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let i = off;
  for (;;) {
    if (i >= buf.length) throw new Error('truncated varint');
    const byte = buf[i++];
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (!(byte & 0x80)) break;
    if (shift > 63) throw new Error('varint too long');
  }
  return { value, next: i };
}

/** Apply a git delta (copy/insert instruction stream) to a base object's bytes. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readSize = (): number => {
    const r = readVarint(delta, off);
    off = r.next;
    return r.value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit++) {
        if (op & (1 << bit)) {
          if (off >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[off++] * 2 ** (8 * bit);
        }
      }
      for (let bit = 4; bit < 7; bit++) {
        if (op & (1 << bit)) {
          if (off >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[off++] * 2 ** (8 * (bit - 4));
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (off + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, off, off + literal);
      off += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

/** Inflate one zlib stream starting at `offset` (bounded by `end`); returns its bytes and the offset just past the stream. */
function inflateAt(buf: Buffer, offset: number, end: number): { data: Buffer; next: number } {
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(buf.subarray(offset, end), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const consumed = result.engine.bytesWritten;
  if (!consumed || consumed <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + consumed };
}

interface PackObject {
  type: string;
  data: Buffer;
}

/**
 * Read a packfile (version 2 or 3) and resolve every object, including
 * OFS_DELTA and REF_DELTA. `resolveBase` supplies a base object a thin
 * pack leaves out (an object already in the store). Verifies the trailer
 * checksum, the declared count, entry sizes and that no stray bytes sit
 * before the trailer. Throws on any corruption.
 */
function readPack(
  buf: Buffer,
  resolveBase: (oid: string) => PackObject | undefined,
): Map<string, PackObject> {
  if (buf.length < 32) throw new Error(`pack is ${buf.length} bytes, too short`);
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailerStart = buf.length - 20;
  const trailer = buf.subarray(trailerStart).toString('hex');
  const computed = sha1Hex(buf.subarray(0, trailerStart));
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let off = 12;
  for (let index = 0; index < count; index++) {
    const entryOffset = off;
    if (off >= trailerStart) throw new Error('pack is truncated');
    let byte = buf[off];
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    off++;
    while (byte & 0x80) {
      if (off >= trailerStart) throw new Error('pack entry size varint is truncated');
      byte = buf[off++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (shift > 63) throw new Error('pack entry size varint is too long');
    }
    const entry: RawEntry = { offset: entryOffset, typeCode, size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      if (off >= trailerStart) throw new Error('ofs-delta has no base offset');
      byte = buf[off++];
      let value = byte & 0x7f;
      while (byte & 0x80) {
        if (off >= trailerStart) throw new Error('ofs-delta base offset is truncated');
        byte = buf[off++];
        value = ((value + 1) * 128) + (byte & 0x7f);
      }
      if (value <= 0 || value > entryOffset) throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${value}`);
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      if (off + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(buf, off, trailerStart);
    if (inflated.data.length !== size) {
      throw new Error(`pack entry at ${entryOffset} declares ${size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    off = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (off !== trailerStart) throw new Error(`pack has ${trailerStart - off} stray bytes before its trailer`);

  const resolvedByOid = new Map<string, RawEntry>();
  const resolved = new Map<number, { type: string; data: Buffer; oid: string }>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): { type: string; data: Buffer; oid: string } => {
    const cached = resolved.get(entry.offset);
    if (cached) return cached;
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: string;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const baseEntry = resolvedByOid.get(entry.baseOid as string);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase(entry.baseOid as string);
        if (!external) throw new Error(`ref-delta base ${entry.baseOid} is neither in the pack nor in the store`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    const out = { type, data, oid };
    resolved.set(entry.offset, out);
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return out;
  };

  const objects = new Map<string, PackObject>();
  for (const entry of raw) {
    const r = resolve(entry);
    if (!objects.has(r.oid)) objects.set(r.oid, { type: r.type, data: r.data });
  }
  return objects;
}

// ---------------------------------------------------------------------------------------------
// object-graph helpers (all reads go through ctx.store; objects are never re-encoded)
// ---------------------------------------------------------------------------------------------

/** The `object` header of an annotated tag, or null. */
function tagTarget(data: Buffer): string | null {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank === -1 ? text : text.slice(0, blank);
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) {
      const oid = line.slice(7).trim();
      return HEX40.test(oid) ? oid : null;
    }
  }
  return null;
}

/** Follow tag objects to the commit they point at; a commit oid returns itself. Null when the chain leaves the commit type or an object is missing. */
function peelToCommit(store: any, oid: string): string | null {
  let cur: string | null = oid;
  const seen = new Set<string>();
  while (cur) {
    if (seen.has(cur)) return null;
    seen.add(cur);
    const obj = store.getObject(cur);
    if (!obj) return null;
    if (obj.type === 'commit') return cur;
    if (obj.type === 'tag') {
      cur = tagTarget(obj.data);
      continue;
    }
    return null;
  }
  return null;
}

/** Add a tree and everything under it (subtrees + blobs, never gitlinks) to `out`. */
function addTreeClosure(store: any, treeSha: string, out: Set<string>): void {
  const stack = [treeSha];
  while (stack.length) {
    const sha = stack.pop() as string;
    if (out.has(sha)) continue;
    const obj = store.getObject(sha);
    if (!obj || obj.type !== 'tree') continue;
    out.add(sha);
    for (const e of store.parseTree(obj.data)) {
      if (e.mode === '160000') continue;
      if (e.mode === '40000') stack.push(e.sha);
      else out.add(e.sha);
    }
  }
}

/**
 * The first object id reachable from `roots` that is missing from the store,
 * or null when the whole closure is present. Used to validate a pushed tip.
 */
function closureMissing(store: any, roots: readonly string[]): string | null {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = store.getObject(oid);
    if (!obj) return oid;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = store.parseCommit(obj.data);
      stack.push(c.tree);
      for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tag') {
      const t = tagTarget(obj.data);
      if (t) stack.push(t);
    } else if (obj.type === 'tree') {
      for (const e of store.parseTree(obj.data)) if (e.mode !== '160000') stack.push(e.sha);
    }
  }
  return null;
}

interface WalkOptions {
  depth?: number;
  since?: number;
  exclude?: Set<string>;
}

/**
 * Walk commits from `starts`. With `depth`, only commits fewer than `depth`
 * generations from a start are included; with `since`, only commits whose
 * author epoch is >= `since`. `exclude` (deepen-not) commits are never
 * included or traversed. `boundary` holds the included commits whose
 * parents were cut off — the new shallow boundary.
 */
function walkCommits(
  store: any,
  starts: readonly string[],
  opts: WalkOptions,
): { included: Set<string>; boundary: Set<string> } {
  const included = new Set<string>();
  const boundary = new Set<string>();
  const seen = new Set<string>();
  const enqueued = new Set<string>(starts);
  const queue: Array<{ oid: string; d: number }> = starts.map((oid) => ({ oid, d: 0 }));
  let head = 0;
  while (head < queue.length) {
    const { oid, d } = queue[head++] as { oid: string; d: number };
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (opts.exclude && opts.exclude.has(oid)) continue;
    const obj = store.getObject(oid);
    if (!obj || obj.type !== 'commit') continue;
    const c = store.parseCommit(obj.data);
    if (opts.since !== undefined && c.authorEpoch < opts.since) continue;
    included.add(oid);
    const maxed = opts.depth !== undefined && d >= opts.depth - 1;
    let cut = false;
    for (const p of c.parents) {
      if (opts.exclude && opts.exclude.has(p)) { cut = true; continue; }
      const po = store.getObject(p);
      if (!po || po.type !== 'commit') { cut = true; continue; }
      if (opts.since !== undefined && store.parseCommit(po.data).authorEpoch < opts.since) { cut = true; continue; }
      if (maxed) { cut = true; continue; }
      if (!enqueued.has(p)) {
        enqueued.add(p);
        queue.push({ oid: p, d: d + 1 });
      }
    }
    if (cut && c.parents.length > 0) boundary.add(oid);
  }
  return { included, boundary };
}

/**
 * Everything the client already holds, given its `have` tips and its current
 * shallow boundaries. The walk descends into a have's history but stops at
 * the parents of a shallow boundary commit: a shallow clone holds the
 * boundary commit, its tree and blobs — not its ancestors.
 */
function heldClosure(store: any, roots: readonly string[], stopParents: Set<string>): Set<string> {
  const held = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (held.has(oid)) continue;
    const obj = store.getObject(oid);
    if (!obj) continue;
    held.add(oid);
    if (obj.type === 'commit') {
      const c = store.parseCommit(obj.data);
      addTreeClosure(store, c.tree, held);
      if (!stopParents.has(oid)) for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tag') {
      const t = tagTarget(obj.data);
      if (t) stack.push(t);
    } else if (obj.type === 'tree') {
      addTreeClosure(store, oid, held);
    }
  }
  return held;
}

// ---------------------------------------------------------------------------------------------
// fetch computation
// ---------------------------------------------------------------------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  deepenSince?: number;
  deepenNot: string[];
}

interface FetchResult {
  objects: PackObject[];
  shallow: string[];
  unshallow: string[];
}

/**
 * Decide exactly which objects a fetch must send. Rules, per the wire spec:
 * - never re-send an object the client holds (reachable from a `have`,
 *   stopping at the client's shallow boundaries);
 * - `deepen N` sends only N generations from each want; the cut commits
 *   become the new shallow boundary;
 * - a boundary that is now fully included stops being shallow (`unshallow`).
 * Objects are returned sorted by oid, so pack bytes are deterministic.
 */
function computeFetch(store: any, repo: any, req: FetchRequest): FetchResult {
  const tagObjs: string[] = [];
  const directObjs: string[] = [];
  const starts: string[] = [];
  for (const want of req.wants) {
    const obj = store.getObject(want);
    if (!obj) throw new Error(`fetch wants unknown object ${want}`);
    if (obj.type === 'tag') {
      tagObjs.push(want);
      const commit = peelToCommit(store, want);
      if (commit) starts.push(commit);
      else {
        const t = tagTarget(obj.data);
        if (t) directObjs.push(t);
      }
    } else if (obj.type === 'commit') {
      starts.push(want);
    } else {
      directObjs.push(want);
    }
  }

  const exclude = new Set<string>();
  for (const ref of req.deepenNot) {
    const tip = repo.refs.get(ref);
    if (!tip) continue;
    try {
      for (const c of store.reachableCommits(tip)) exclude.add(c);
    } catch {
      // A non-commit tip simply excludes nothing.
    }
  }

  const { included, boundary } = walkCommits(store, starts, {
    depth: req.depth,
    since: req.deepenSince,
    exclude: exclude.size ? exclude : undefined,
  });

  const stopSet = new Set(req.shallow);
  const held = heldClosure(store, [...req.haves, ...req.shallow], stopSet);

  const send = new Set<string>();
  for (const oid of tagObjs) send.add(oid);
  for (const oid of directObjs) send.add(oid);
  for (const oid of directObjs) {
    const o = store.getObject(oid);
    if (o && o.type === 'tree') addTreeClosure(store, oid, send);
  }
  for (const commit of included) {
    send.add(commit);
    const obj = store.getObject(commit);
    if (obj && obj.type === 'commit') addTreeClosure(store, store.parseCommit(obj.data).tree, send);
  }
  for (const oid of [...send]) if (held.has(oid)) send.delete(oid);

  const objects: PackObject[] = [];
  for (const oid of [...send].sort()) {
    const o = store.getObject(oid);
    if (o) objects.push({ type: o.type, data: o.data });
  }
  const unshallow = req.shallow.filter((b) => included.has(b) && !boundary.has(b));
  return { objects, shallow: [...boundary].sort(), unshallow };
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

function sortedRefs(repo: any): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()]
    .map(([name, oid]: [string, string]) => ({ name, oid }))
    .sort((a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

const UPLOAD_CAPS =
  `side-band-64k thin-pack ofs-delta shallow multi_ack_detailed symref=HEAD:${HEAD_REF} agent=${AGENT}`;
const RECEIVE_CAPS =
  `report-status side-band-64k delete-refs ofs-delta symref=HEAD:${HEAD_REF} agent=${AGENT}`;

/** v0 advertisement: `# service=...` preamble, flush, one line per ref (caps on the first), peeled tag lines, trailing flush. */
function v0Advertisement(store: any, repo: any, service: string): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS : RECEIVE_CAPS;
  const refs = sortedRefs(repo);
  const lines: string[] = [];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const mainTip = repo.refs.get(HEAD_REF);
    const all: Array<{ oid: string; name: string }> = [{ oid: mainTip ?? ZERO_OID, name: 'HEAD' }, ...refs];
    all.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    all.forEach((r, index) => {
      lines.push(index === 0 ? `${r.oid} ${r.name}\0${caps}\n` : `${r.oid} ${r.name}\n`);
      if (r.name !== 'HEAD') {
        const obj = store.getObject(r.oid);
        if (obj && obj.type === 'tag') {
          const peeled = peelToCommit(store, r.oid);
          if (peeled) lines.push(`${peeled} ${r.name}^{}\n`);
        }
      }
    });
  }
  const parts: Buffer[] = [pkt(`# service=${service}\n`), FLUSH];
  for (const line of lines) parts.push(pkt(line));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** v2 advertisement for upload-pack: `version 2` + one capability per line, no refs. */
function v2Advertisement(): Buffer {
  return pktLines(['version 2\n', 'fetch=shallow\n', 'ls-refs=unborn\n', 'object-format=sha1\n', `agent=${AGENT}\n`, 'flush']);
}

interface LsRefsOptions {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

/**
 * v2 ls-refs lines. HEAD carries `symref-target:refs/heads/main`; annotated
 * tags carry `peeled:<commit>`; unborn refs are `unborn` lines. Prefixes are
 * filtered server-side (HEAD never matches a `refs/...` prefix). A repo with
 * no refs at all reports only the unborn HEAD line, never a `refs/*` line.
 */
function lsRefsLines(store: any, repo: any, opts: LsRefsOptions): string[] {
  const lines: string[] = [];
  const mainTip = repo.refs.get(HEAD_REF) as string | undefined;
  const keep = (name: string): boolean =>
    opts.prefixes.length === 0 || opts.prefixes.some((p) => name.startsWith(p));
  const symref = opts.symrefs ? ` symref-target:${HEAD_REF}` : '';
  if (keep('HEAD')) {
    if (mainTip) lines.push(`${mainTip} HEAD${symref}\n`);
    else if (opts.unborn) lines.push(`unborn HEAD${symref}\n`);
  }
  for (const r of sortedRefs(repo)) {
    if (!keep(r.name)) continue;
    let line = `${r.oid} ${r.name}`;
    if (opts.peel) {
      const obj = store.getObject(r.oid);
      if (obj && obj.type === 'tag') {
        const peeled = peelToCommit(store, r.oid);
        if (peeled) line += ` peeled:${peeled}`;
      }
    }
    lines.push(`${line}\n`);
  }
  // An unborn default branch alongside other refs is reported as an unborn
  // ref; a repo with no refs at all reports only HEAD (see above).
  if (!mainTip && opts.unborn && sortedRefs(repo).length > 0 && keep(HEAD_REF)) {
    lines.push(`unborn ${HEAD_REF}${symref}\n`);
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// request parsing (upload-pack)
// ---------------------------------------------------------------------------------------------

function stripLf(line: string): string {
  return line.endsWith('\n') ? line.slice(0, -1) : line;
}

function parseOidToken(token: string | undefined, what: string): string {
  if (!token || !HEX40.test(token)) throw new Error(`bad ${what} object id ${JSON.stringify(token ?? '')}`);
  return token;
}

/** Parse the argument lines of a fetch (v2 after the delim, or a whole v0 body). */
function parseFetchArgs(args: readonly string[]): FetchRequest {
  const req: FetchRequest = { wants: [], haves: [], shallow: [], deepenNot: [] };
  for (const raw of args) {
    const line = stripLf(raw);
    if (
      line.startsWith('agent=') ||
      line.startsWith('object-format=') ||
      line === 'thin-pack' ||
      line === 'no-progress' ||
      line === 'ofs-delta' ||
      line === 'side-band-64k' ||
      line === 'done' ||
      line.startsWith('filter ')
    ) {
      continue;
    }
    if (line.startsWith('want ')) req.wants.push(parseOidToken(line.slice(5).split(' ')[0], 'want'));
    else if (line.startsWith('have ')) req.haves.push(parseOidToken(line.slice(5).split(' ')[0], 'have'));
    else if (line.startsWith('shallow ')) req.shallow.push(parseOidToken(line.slice(8).trim(), 'shallow'));
    else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7).trim(), 10);
      if (!Number.isFinite(n) || n < 0) throw new Error(`bad deepen value ${JSON.stringify(line)}`);
      req.depth = n;
    } else if (line.startsWith('deepen-since ')) {
      const n = parseInt(line.slice(13).trim(), 10);
      if (!Number.isFinite(n) || n < 0) throw new Error(`bad deepen-since value ${JSON.stringify(line)}`);
      req.deepenSince = n;
    } else if (line.startsWith('deepen-not ')) {
      req.deepenNot.push(line.slice(11).trim());
    }
    // Any other well-formed line is ignored; only malformed framing is a 400.
  }
  return req;
}

function parseLsRefsArgs(args: readonly string[]): LsRefsOptions {
  const opts: LsRefsOptions = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const raw of args) {
    const line = stripLf(raw);
    if (line === 'peel') opts.peel = true;
    else if (line === 'symrefs') opts.symrefs = true;
    else if (line === 'unborn') opts.unborn = true;
    else if (line.startsWith('ref-prefix ')) opts.prefixes.push(line.slice(11));
  }
  return opts;
}

// ---------------------------------------------------------------------------------------------
// sideband framing
// ---------------------------------------------------------------------------------------------

/** Split pack bytes into sideband band-1 pkt-lines (1 band byte + <=65515 pack bytes each). */
function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let off = 0; off < pack.length; off += SIDEBAND_CHUNK) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + SIDEBAND_CHUNK));
    out.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return out;
}

function buildFetchV2Response(result: FetchResult): Buffer {
  const parts: Buffer[] = [pkt('acknowledgments\n'), pkt('NAK\n'), pkt('ready\n'), FLUSH];
  if (result.shallow.length || result.unshallow.length) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of result.shallow) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of result.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(FLUSH);
  }
  if (result.objects.length) {
    parts.push(pkt('packfile\n'), ...sidebandPackets(writePack(result.objects)), FLUSH);
  }
  return Buffer.concat(parts);
}

function buildFetchV0Response(result: FetchResult): Buffer {
  const parts: Buffer[] = [pkt('NAK\n')];
  for (const oid of result.shallow) parts.push(pkt(`shallow ${oid}\n`));
  for (const oid of result.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
  if (result.objects.length) parts.push(...sidebandPackets(writePack(result.objects)));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------------------------

function handleInfoRefs(store: any, repo: any, query: URLSearchParameters, hdrs: Record<string, string>): GitResponse {
  const service = typeof query.get === 'function' ? query.get('service') : null;
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return badRequest('unknown service');
  }
  const wantsV2 = service === 'git-upload-pack' && (hdrs['git-protocol'] ?? '').includes('version=2');
  if (wantsV2) return okGit('application/x-git-upload-pack-advertisement', v2Advertisement());
  return okGit(`application/x-${service}-advertisement`, v0Advertisement(store, repo, service));
}

function handleUploadPack(store: any, repo: any, hdrs: Record<string, string>, body: Buffer): GitResponse {
  const isV2 = (hdrs['git-protocol'] ?? '').includes('version=2');
  if (isV2) {
    let packets: Packet[];
    try {
      packets = decodePackets(body);
    } catch (err) {
      return badRequest(`malformed pkt-line: ${(err as Error).message}`);
    }
    const lines = packetLines(packets);
    if (lines.length === 0) return badRequest('empty upload-pack request');
    const first = stripLf(lines[0] as string);
    const command = first === 'command=ls-refs' ? 'ls-refs' : first === 'command=fetch' ? 'fetch' : null;
    if (!command) return badRequest(`unknown upload-pack command ${JSON.stringify(first.slice(0, 40))}`);
    const args = lines.slice(1);
    if (command === 'ls-refs') {
      const opts = parseLsRefsArgs(args);
      const out = lsRefsLines(store, repo, opts).map((line) => pkt(line));
      out.push(FLUSH);
      return okGit('application/x-git-upload-pack-result', Buffer.concat(out));
    }
    let req: FetchRequest;
    try {
      req = parseFetchArgs(args);
    } catch (err) {
      return badRequest((err as Error).message);
    }
    let result: FetchResult;
    try {
      result = computeFetch(store, repo, req);
    } catch (err) {
      return badRequest((err as Error).message);
    }
    return okGit('application/x-git-upload-pack-result', buildFetchV2Response(result));
  }

  // v0 fetch: the whole body is want/have/shallow/deepen lines across two
  // flush-separated sections; parse leniently across the sections.
  let packets: Packet[];
  try {
    packets = decodePackets(body);
  } catch (err) {
    return badRequest(`malformed pkt-line: ${(err as Error).message}`);
  }
  let req: FetchRequest;
  try {
    req = parseFetchArgs(packetLines(packets));
  } catch (err) {
    return badRequest((err as Error).message);
  }
  let result: FetchResult;
  try {
    result = computeFetch(store, repo, req);
  } catch (err) {
    return badRequest((err as Error).message);
  }
  return okGit('application/x-git-upload-pack-result', buildFetchV0Response(result));
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Fast-forward rules, per ref, in command order. Never moves a refused ref. */
function evalPushCommand(store: any, repo: any, cmd: PushCommand): { ref: string; ok: boolean; reason: string } {
  const cur = repo.refs.get(cmd.ref) as string | undefined;
  if (cmd.newOid === ZERO_OID) {
    // Delete.
    if (cur === undefined) return { ref: cmd.ref, ok: false, reason: 'does not exist' };
    if (cur !== cmd.oldOid) return { ref: cmd.ref, ok: false, reason: 'non-fast-forward' };
    repo.refs.delete(cmd.ref);
    return { ref: cmd.ref, ok: true, reason: '' };
  }
  if (cmd.oldOid === ZERO_OID) {
    // Create.
    if (cur !== undefined) return { ref: cmd.ref, ok: false, reason: 'already exists' };
    if (cmd.ref.startsWith('refs/heads/') && !peelToCommit(store, cmd.newOid)) {
      return { ref: cmd.ref, ok: false, reason: 'not a commit' };
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    return { ref: cmd.ref, ok: true, reason: '' };
  }
  // Update: the ref must still be at `old`, and `old` must be an ancestor of `new`.
  if (cur === undefined) return { ref: cmd.ref, ok: false, reason: 'does not exist' };
  if (cur !== cmd.oldOid) return { ref: cmd.ref, ok: false, reason: 'non-fast-forward' };
  const oldCommit = peelToCommit(store, cmd.oldOid);
  const newCommit = peelToCommit(store, cmd.newOid);
  if (!oldCommit || !newCommit) return { ref: cmd.ref, ok: false, reason: 'non-fast-forward' };
  let fastForward = false;
  try {
    fastForward = store.isAncestor(oldCommit, newCommit) as boolean;
  } catch {
    fastForward = false;
  }
  if (!fastForward) return { ref: cmd.ref, ok: false, reason: 'non-fast-forward' };
  repo.refs.set(cmd.ref, cmd.newOid);
  return { ref: cmd.ref, ok: true, reason: '' };
}

function handleReceivePack(store: any, repo: any, body: Buffer): GitResponse {
  let prefix: { packets: Packet[]; consumed: number };
  try {
    prefix = decodePacketsUntilFlush(body);
  } catch (err) {
    return badRequest(`malformed pkt-line: ${(err as Error).message}`);
  }
  const lines = packetLines(prefix.packets);
  if (lines.length === 0) return badRequest('empty receive-pack request');
  const commands: PushCommand[] = [];
  let caps = '';
  for (let i = 0; i < lines.length; i++) {
    let line = stripLf(lines[i] as string);
    if (i === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        caps = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
    }
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/\S+)$/.exec(line);
    if (!m) return badRequest('malformed receive-pack command');
    if ((m[3] as string).length > 200 || /[\s\x00-\x1f]/.test(m[3] as string)) {
      return badRequest('bad ref name in receive-pack command');
    }
    commands.push({ oldOid: m[1] as string, newOid: m[2] as string, ref: m[3] as string });
  }
  const sideband = caps.split(' ').includes('side-band-64k');
  const packBytes = body.subarray(prefix.consumed);

  // Parse and validate the pack first; only a valid, complete pack stores
  // objects, and only then do refs move.
  let unpackError: string | null = null;
  let packed = new Map<string, PackObject>();
  if (packBytes.length > 0) {
    try {
      packed = readPack(packBytes, (oid) => store.getObject(oid));
    } catch (err) {
      unpackError = (err as Error).message;
    }
  }
  if (!unpackError) {
    for (const obj of packed.values()) store.putObject(obj.type, obj.data);
    for (const cmd of commands) {
      if (cmd.newOid === ZERO_OID) continue;
      if (!store.getObject(cmd.newOid)) {
        unpackError = `object ${cmd.newOid} is missing`;
        break;
      }
      const missing = closureMissing(store, [cmd.newOid]);
      if (missing) {
        unpackError = `object ${missing} is missing`;
        break;
      }
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  if (unpackError) {
    for (const cmd of commands) results.push({ ref: cmd.ref, ok: false, reason: 'unpack failed' });
  } else {
    for (const cmd of commands) results.push(evalPushCommand(store, repo, cmd));
  }

  const detail = unpackError ? unpackError.replace(/[\r\n]+/g, ' ').slice(0, 200) : 'ok';
  const reportLines: string[] = [`unpack ${detail}\n`];
  for (const r of results) {
    reportLines.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`);
  }
  const parts: Buffer[] = [];
  if (sideband) {
    // Each report line is itself pkt-lined inside sideband band 1.
    for (const line of reportLines) parts.push(pkt(Buffer.concat([Buffer.from([1]), pkt(line)])));
  } else {
    for (const line of reportLines) parts.push(pkt(line));
  }
  parts.push(FLUSH);
  // HTTP 200 even when a ref is refused: the refusal lives in the report.
  return okGit('application/x-git-receive-pack-result', Buffer.concat(parts));
}

// ---------------------------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------------------------

function parseGitRoute(path: string): { owner: string; repo: string; suffix: string } | null {
  const clean = path.split('?')[0] as string;
  const m = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(clean);
  if (!m) return null;
  const owner = m[1] as string;
  const repo = m[2] as string;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(owner)) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repo) || repo.endsWith('.git')) return null;
  return { owner, repo, suffix: m[3] as string };
}

/**
 * Handle one git smart-HTTP request.
 *
 * Returns `null` when `path` is not a git route (`/{owner}/{repo}.git/...`).
 * Otherwise returns `{status, headers, body}`. Auth is required on every git
 * request (401 JSON); unknown repos are a plain 404; malformed pkt-lines are
 * a 400 that leaves the repo untouched.
 */
export async function handleGit(
  method: string,
  path: string,
  query: URLSearchParameters,
  headers: Record<string, string>,
  body: Buffer,
  ctx: any,
): Promise<{ status: number; headers: Record<string, string>; body: Buffer } | null> {
  try {
    const route = parseGitRoute(path);
    if (!route) return null;
    const hdrs = headerLookup(headers);
    const authed = typeof ctx?.authed === 'function' ? (ctx.authed(headers) as boolean) : true;
    if (!authed) return jsonResponse(401, { message: 'Requires authentication' });
    const store = ctx.store;
    const repo = store.getRepo(route.owner, route.repo);
    if (!repo) return textResponse(404, 'repository not found\n');
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body ?? '');
    if (method === 'GET' && route.suffix === 'info/refs') return handleInfoRefs(store, repo, query, hdrs);
    if (method === 'POST' && route.suffix === 'git-upload-pack') return handleUploadPack(store, repo, hdrs, buf);
    if (method === 'POST' && route.suffix === 'git-receive-pack') return handleReceivePack(store, repo, buf);
    return textResponse(404, 'not found\n');
  } catch (err) {
    // Last-resort guard: a handler must never take the server down with it.
    return jsonResponse(400, { message: err instanceof Error ? err.message : 'bad request' });
  }
}
