// Git object model: SHA-1 ids, pkt-line framing, packfiles (read with REF/OFS delta
// resolution, written delta-free), tree/commit/tag parsing and building, and
// reachability walks. Node stdlib only (node:crypto, node:zlib).

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------- pkt-line

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';
export interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const out = Buffer.allocUnsafe(len);
  out.write(len.toString(16).padStart(4, '0'), 0, 4, 'ascii');
  body.copy(out, 4);
  return out;
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_END = Buffer.from('0002', 'ascii');

/** Decode a whole buffer of pkt-lines. Throws on a malformed length. */
export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line length');
    const len = parseInt(buf.toString('ascii', off, off + 4), 16);
    if (Number.isNaN(len)) throw new Error('malformed pkt-line length');
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      off += 4;
    } else if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      off += 4;
    } else if (len === 2) {
      out.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      off += 4;
    } else {
      if (off + len > buf.length) throw new Error('truncated pkt-line payload');
      out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
      off += len;
    }
  }
  return out;
}

/** Concatenate pkt-lines from strings/buffers plus flush/delim markers. */
export function encodePktLines(lines: readonly (string | Buffer | 'flush' | 'delim' | 'end')[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(PKT_FLUSH);
    else if (line === 'delim') parts.push(PKT_DELIM);
    else if (line === 'end') parts.push(PKT_END);
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- trees / commits / tags

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    if (space < 0) break;
    const mode = Buffer.from(data.subarray(off, space)).toString('ascii');
    const nul = data.indexOf(0, space + 1);
    if (nul < 0) break;
    const name = Buffer.from(data.subarray(space + 1, nul)).toString('utf8');
    const oid = Buffer.from(data.subarray(nul + 1, nul + 21)).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Build a tree object, git-canonical order (directories sort as name + '/'). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Uint8Array): CommitView {
  const text = Buffer.from(data).toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  const parents: string[] = [];
  let tree = '';
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Uint8Array): TagView {
  const text = Buffer.from(data).toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}): Buffer {
  const ident = (who: string): string => `${who} ${fields.timestamp} +0000`;
  let out = `tree ${fields.tree}\n`;
  for (const parent of fields.parents) out += `parent ${parent}\n`;
  out += `author ${ident(fields.author)}\ncommitter ${ident(fields.committer)}\n\n${fields.message}`;
  return Buffer.from(out, 'utf8');
}

export function buildTag(fields: {
  object: string;
  type: string;
  tag: string;
  message: string;
  tagger: string;
  timestamp: number;
}): Buffer {
  return Buffer.from(
    `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${fields.tagger} ${fields.timestamp} +0000\n\n${fields.message}`,
    'utf8',
  );
}

// ---------------------------------------------------------------- packfiles

function readPackObjectHeader(buf: Buffer, start: number): { type: GitObjectType; size: number; next: number } {
  let off = start;
  let byte = buf[off] as number;
  off += 1;
  const typeCode = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  while (byte & 0x80) {
    byte = buf[off] as number;
    off += 1;
    size |= (byte & 0x7f) << shift;
    shift += 7;
  }
  if (typeCode === 6 || typeCode === 7) {
    // Delta entries: the caller handles the base reference before the zlib stream.
    return { type: typeCode === 6 ? 'commit' : 'commit', size, next: off };
  }
  const type = CODE_TYPE[typeCode];
  if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
  return { type, size, next: off };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVarint = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[off] as number;
      off += 1;
      result |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return result;
  };
  const baseSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const outSize = readVarint();
  const chunks: Buffer[] = [];
  let written = 0;
  while (off < delta.length) {
    const op = delta[off] as number;
    off += 1;
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          cpOff |= (delta[off] as number) << (bit * 8);
          off += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          cpSize |= (delta[off] as number) << (bit * 8);
          off += 1;
        }
      }
      if (cpSize === 0) cpSize = 0x10000;
      chunks.push(base.subarray(cpOff, cpOff + cpSize));
      written += cpSize;
    } else if (op !== 0) {
      chunks.push(delta.subarray(off, off + op));
      off += op;
      written += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== outSize) throw new Error('delta output size mismatch');
  return Buffer.concat(chunks);
}

export interface PackReadResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/** Read a packfile, resolving OFS_DELTA (6) and REF_DELTA (7) entries. */
export function readPack(pack: Buffer, lookup?: (oid: string) => GitObject | undefined): PackReadResult {
  if (pack.length < 12 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let deltaCount = 0;
  // First pass: plain objects and OFS deltas whose base precedes them; REF deltas deferred.
  const deferred: Array<{ offset: number; baseOid: string; delta: Buffer; type: GitObjectType }> = [];
  let off = 12;
  const entries: Array<{ offset: number; typeCode: number }> = [];
  for (let i = 0; i < count; i += 1) {
    const start = off;
    let byte = pack[off] as number;
    off += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[off] as number;
      off += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    entries.push({ offset: start, typeCode });
    if (typeCode === 6) {
      // OFS_DELTA: negative offset varint.
      let b = pack[off] as number;
      off += 1;
      let baseOff = b & 0x7f;
      while (b & 0x80) {
        b = pack[off] as number;
        off += 1;
        baseOff = ((baseOff + 1) << 7) | (b & 0x7f);
      }
      const baseOffset = start - baseOff;
      const data = inflateSync(pack.subarray(off));
      // inflateSync consumes the whole tail; find the true end via the stream length trick:
      // re-inflate with a bounded approach is not available, so use zlib inflate with chunking.
      const resolved = resolveInflate(pack, off);
      const base = byOffset.get(baseOffset);
      if (base === undefined) throw new Error('ofs-delta base not yet read');
      deltaCount += 1;
      const out = applyDelta(base.data, resolved.data);
      const obj: GitObject = { type: base.type, data: out };
      const oid = hashObject(obj.type, out);
      objects.set(oid, obj);
      byOffset.set(start, obj);
      off = resolved.next;
      void data;
      void size;
    } else if (typeCode === 7) {
      const baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
      const resolved = resolveInflate(pack, off);
      deferred.push({ offset: start, baseOid, delta: resolved.data, type: 'commit' });
      off = resolved.next;
      void size;
    } else {
      const type = CODE_TYPE[typeCode];
      if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      const resolved = resolveInflate(pack, off);
      const data = resolved.data;
      if (data.length !== size) throw new Error('pack object size mismatch');
      const obj: GitObject = { type, data };
      const oid = hashObject(type, data);
      objects.set(oid, obj);
      byOffset.set(start, obj);
      off = resolved.next;
    }
  }
  // Deferred REF deltas: base may be in this pack or in the caller's store.
  for (const entry of deferred) {
    const base = objects.get(entry.baseOid) ?? lookup?.(entry.baseOid);
    if (base === undefined) throw new Error(`ref-delta base ${entry.baseOid} not found`);
    deltaCount += 1;
    const out = applyDelta(base.data, entry.delta);
    const obj: GitObject = { type: base.type, data: out };
    const oid = hashObject(obj.type, out);
    objects.set(oid, obj);
    byOffset.set(entry.offset, obj);
  }
  void entries;
  return { objects, deltaCount };
}

/** Inflate one zlib stream starting at `off`; returns the data and the offset past the stream. */
function resolveInflate(pack: Buffer, off: number): { data: Buffer; next: number } {
  // The stream's end is not marked in the pack; find the smallest end that inflates
  // cleanly. Each probe is small (objects here are a few KiB at most), so this is cheap.
  let lo = off + 1;
  let hi = pack.length - 20; // the pack trailer is 20 bytes and never part of a stream
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(pack.subarray(off, mid));
      found = mid;
      hi = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  if (found < 0) throw new Error('could not inflate a pack object');
  return { data: inflateSync(pack.subarray(off, found)), next: found };
}

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
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

/** Build a packfile from plain objects (no deltas), with the SHA-1 trailer. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

export function verifyPackChecksum(pack: Buffer): boolean {
  if (pack.length < 20) return false;
  const actual = pack.subarray(pack.length - 20);
  const expected = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  return actual.equals(expected);
}

// ---------------------------------------------------------------- reachability

export type ObjectLookup = (oid: string) => GitObject | undefined;

/** All oids reachable from `tips` (commits -> parents/trees/blobs, tags -> target). */
export function collectReachable(tips: Iterable<string>, lookup: ObjectLookup): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = lookup(oid);
    if (obj === undefined) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const view = parseCommit(obj.data);
      stack.push(view.tree);
      for (const parent of view.parents) stack.push(parent);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return seen;
}

/** Ancestor generations of `tip` (commit oids only), gen 0 = tip itself. */
export function commitGenerations(tip: string, lookup: ObjectLookup): Map<string, number> {
  const gens = new Map<string, number>();
  const queue: Array<[string, number]> = [[tip, 0]];
  while (queue.length > 0) {
    const [oid, gen] = queue.shift() as [string, number];
    if (gens.has(oid)) continue;
    const obj = lookup(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    gens.set(oid, gen);
    for (const parent of parseCommit(obj.data).parents) queue.push([parent, gen + 1]);
  }
  return gens;
}

/** True when `ancestor` is reachable from `tip` (or equal). */
export function isAncestor(ancestor: string, tip: string, lookup: ObjectLookup): boolean {
  if (ancestor === tip) return true;
  if (ancestor === ZERO_OID) return true;
  const stack: string[] = [tip];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = lookup(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return false;
}

/** The best merge-base: the common ancestor with the highest insertion order. */
export function mergeBase(a: string, b: string, lookup: ObjectLookup, order: (oid: string) => number): string | null {
  const ancestorsA = new Set<string>();
  const stack: string[] = [a];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const obj = lookup(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  let best: string | null = null;
  let bestOrder = -1;
  const stackB: string[] = [b];
  const seenB = new Set<string>();
  while (stackB.length > 0) {
    const oid = stackB.pop() as string;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    if (ancestorsA.has(oid)) {
      const ord = order(oid);
      if (ord > bestOrder) {
        bestOrder = ord;
        best = oid;
      }
    }
    const obj = lookup(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) stackB.push(parent);
  }
  return best;
}
