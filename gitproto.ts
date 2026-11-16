// Git smart HTTP: info/refs advertisements (v0 + v2), upload-pack v2/v0 and
// receive-pack v0. Packets are pkt-line framed; fetch packs are delta-free and
// cached per (wants, depth, haves) for the concurrent-clone workload.

import {
  ZERO_OID,
  decodePktLines,
  encodePktLines,
  hashObject,
  isAncestor,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  pktLine,
  readPack,
  writePack,
  type GitObject,
} from './gitcore.ts';
import { fastForwardOk, type Repo } from './store.ts';

const AGENT = 'forge/1.0';

/** Refs in advertisement order: HEAD, branches, tags. */
function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const out: Array<{ name: string; oid: string }> = [];
  for (const [name, oid] of repo.refs) out.push({ name, oid });
  out.sort((a, b) => {
    const rank = (n: string): number => (n.startsWith('refs/heads/') ? 0 : n.startsWith('refs/tags/') ? 1 : 2);
    const ra = rank(a.name);
    const rb = rank(b.name);
    if (ra !== rb) return ra - rb;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return out;
}

function peeledOid(repo: Repo, refOid: string): string | null {
  const obj = repo.objects.get(refOid);
  if (obj === undefined || obj.type !== 'tag') return null;
  const target = parseTag(obj.data).object;
  const targetObj = repo.objects.get(target);
  if (targetObj === undefined || targetObj.type !== 'commit') return null;
  return target;
}

/** v0 advertisement body for a service, cached per repo until a ref moves. */
export function advertisementV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const cacheKey = `v0-${service}-${repo.defaultBranch}`;
  const cached = repo.adCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const caps =
    service === 'git-upload-pack'
      ? `symref=HEAD:refs/heads/${repo.defaultBranch} side-band-64k thin-pack ofs-delta shallow multi_ack agent=${AGENT}`
      : `symref=HEAD:refs/heads/${repo.defaultBranch} report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const lines: Array<string | Buffer | 'flush'> = [`# service=${service}\n`, 'flush'];
  const refs = sortedRefs(repo);
  const headOid = repo.defaultTip() ?? ZERO_OID;
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    lines.push(`${headOid} HEAD\0${caps}\n`);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      const peeled = peeledOid(repo, ref.oid);
      if (peeled !== null) lines.push(`${peeled} ${ref.name}^{}\n`);
    }
  }
  lines.push('flush');
  const body = encodePktLines(lines);
  repo.adCache.set(cacheKey, body);
  return body;
}

/** v2 capability advertisement body (upload-pack only). */
export function advertisementV2(repo: Repo): Buffer {
  const cached = repo.adCache.get('v2');
  if (cached !== undefined) return cached;
  const body = encodePktLines([
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    'flush',
  ]);
  repo.adCache.set('v2', body);
  return body;
}

// ---------------------------------------------------------------- fetch planning

export interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

/**
 * Which objects a fetch sends: the closure of the wanted commits minus what the
 * client holds, cut to `depth` generations when asked. `held` are the have oids,
 * `shallowOld` the client's current shallow boundaries.
 */
export function planFetch(
  repo: Repo,
  wants: string[],
  held: string[],
  shallowOld: string[],
  depth: number | null,
): FetchPlan {
  const heldSet = new Set(held);
  const included = new Set<string>(); // commit/tag oids to send
  const shallowNew: string[] = [];
  const visited = new Set<string>();
  const queue: Array<[string, number]> = wants.map((w) => [w, 0] as [string, number]);
  while (queue.length > 0) {
    const [oid, gen] = queue.shift() as [string, number];
    if (visited.has(oid)) continue;
    visited.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      included.add(oid);
      const target = parseTag(obj.data).object;
      queue.push([target, gen]);
      continue;
    }
    if (obj.type !== 'commit') {
      included.add(oid);
      continue;
    }
    if (heldSet.has(oid)) {
      if (depth !== null && gen + 1 < depth) {
        for (const parent of parseCommit(obj.data).parents) queue.push([parent, gen + 1]);
      }
      continue;
    }
    if (depth !== null && gen >= depth) continue;
    included.add(oid);
    if (depth !== null && gen === depth - 1) {
      shallowNew.push(oid);
      continue;
    }
    for (const parent of parseCommit(obj.data).parents) queue.push([parent, gen + 1]);
  }
  // Closure of the included commits/tags: their trees and blobs only — never their
  // parents (the BFS above already decided which commits are in scope; following
  // parents here would leak history past a shallow boundary).
  const send = new Set<string>();
  const stack: string[] = [...included];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (send.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    send.add(oid);
    if (obj.type === 'commit') {
      stack.push(parseCommit(obj.data).tree);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  // The BFS above already stops at held commits for the commit walk, but trees and
  // blobs shared with held history must not be re-sent either. A held commit's
  // history counts as held — except past a shallow boundary: the client holds the
  // boundary commit and its tree, but never received its parents, so the walk
  // stops there instead of claiming the parent's tree and blobs are held.
  const shallowOldSet = new Set(shallowOld);
  const heldClosure = new Set<string>();
  const heldStack: string[] = [...heldSet];
  while (heldStack.length > 0) {
    const oid = heldStack.pop() as string;
    if (heldClosure.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    heldClosure.add(oid);
    if (obj.type === 'commit') {
      const view = parseCommit(obj.data);
      heldStack.push(view.tree);
      if (!shallowOldSet.has(oid)) {
        for (const parent of view.parents) heldStack.push(parent);
      }
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) heldStack.push(entry.oid);
    } else if (obj.type === 'tag') {
      heldStack.push(parseTag(obj.data).object);
    }
  }
  for (const oid of heldClosure) send.delete(oid);
  // A commit the BFS included is never in the held closure (held commits are skipped),
  // but its tree/blobs may coincide with held ones; the delete above handles that.
  // Re-add the included commits themselves (they were never held).
  for (const oid of included) send.add(oid);
  const objects: GitObject[] = [];
  for (const oid of [...send].sort()) {
    const obj = repo.objects.get(oid);
    if (obj !== undefined) objects.push(obj);
  }
  const unshallow: string[] = [];
  for (const boundary of shallowOld) {
    if (shallowNew.includes(boundary)) continue;
    const obj = repo.objects.get(boundary);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.length > 0 && parents.every((p) => included.has(p) || heldSet.has(p))) unshallow.push(boundary);
  }
  return { objects, shallow: shallowNew, unshallow };
}

/** Pack bytes for a fetch, cached per (wants, depth, haves, shallow) key. */
function fetchPack(repo: Repo, wants: string[], held: string[], shallowOld: string[], depth: number | null, plan: FetchPlan): Buffer {
  const key = `${wants.join(',')}|${depth ?? ''}|${held.join(',')}|${shallowOld.join(',')}`;
  const cached = repo.packCache.get(key);
  if (cached !== undefined) return cached;
  const pack = writePack(plan.objects);
  repo.packCache.set(key, pack);
  return pack;
}

/** Sideband pkt-lines carrying `pack` as band-1 chunks (plus an optional band-2 note). */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65500;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const slice = pack.subarray(off, Math.min(pack.length, off + CHUNK));
    const payload = Buffer.concat([Buffer.from([1]), slice]);
    parts.push(pktLine(payload));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- upload-pack

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function parseFetchArgs(lines: string[]): FetchRequest {
  const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) req.wants.push(text.slice(5).trim().split(' ')[0] as string);
    else if (text.startsWith('have ')) req.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) req.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = parseInt(text.slice(7).trim(), 10);
      if (Number.isFinite(n)) req.depth = n;
    }
  }
  return req;
}

/** ls-refs v2: filter by prefixes, HEAD first, peel + symref attributes. */
export function lsRefsV2(repo: Repo, args: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const line of args) {
    const text = line.replace(/\n$/, '');
    if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const lines: string[] = [];
  const headOid = repo.defaultTip() ?? ZERO_OID;
  if (keep('HEAD')) {
    const sym = symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
    lines.push(`${headOid} HEAD${sym}\n`);
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel) {
      const peeled = peeledOid(repo, ref.oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return encodePktLines(lines);
}

/** upload-pack v2: one ls-refs or fetch command. Throws on a malformed body. */
export function uploadPackV2(repo: Repo, body: Buffer): Buffer {
  const packets = decodePktLines(body);
  const texts: string[] = [];
  let command = '';
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8');
    if (!inArgs) {
      if (text.startsWith('command=')) command = text.slice('command='.length).replace(/\n$/, '');
      continue;
    }
    texts.push(text);
  }
  if (command === 'ls-refs') return lsRefsV2(repo, texts);
  if (command === 'fetch') {
    const req = parseFetchArgs(texts);
    const plan = planFetch(repo, req.wants, req.haves, req.shallow, req.depth);
    const pack = fetchPack(repo, req.wants, req.haves, req.shallow, req.depth, plan);
    const parts: Buffer[] = [];
    if (req.haves.length > 0) {
      parts.push(encodePktLines(['acknowledgments\n', 'NAK\n', 'delim']));
    }
    if (req.depth !== null) {
      const shallowLines: Array<string | 'delim'> = ['shallow-info\n'];
      for (const oid of plan.shallow) shallowLines.push(`shallow ${oid}\n`);
      for (const oid of plan.unshallow) shallowLines.push(`unshallow ${oid}\n`);
      shallowLines.push('delim');
      parts.push(encodePktLines(shallowLines));
    }
    parts.push(pktLine('packfile\n'));
    parts.push(sidebandPack(pack));
    parts.push(Buffer.from('0000', 'ascii'));
    return Buffer.concat(parts);
  }
  throw new Error(`unknown v2 command ${JSON.stringify(command)}`);
}

/** upload-pack v0: want/have negotiation, NAK, shallow lines, sideband pack. */
export function uploadPackV0(repo: Repo, body: Buffer): Buffer {
  const packets = decodePktLines(body);
  const lines: string[] = [];
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    lines.push(packet.payload.toString('utf8'));
  }
  void section;
  const req = parseFetchArgs(lines);
  // v0 puts haves after the first flush; parseFetchArgs already collected them.
  const plan = planFetch(repo, req.wants, req.haves, req.shallow, req.depth);
  const pack = fetchPack(repo, req.wants, req.haves, req.shallow, req.depth, plan);
  const parts: Buffer[] = [];
  parts.push(pktLine('NAK\n'));
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(sidebandPack(pack));
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- receive-pack

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Receive-pack v0: apply commands, answer a sideband report-status. */
export function receivePack(repo: Repo, body: Buffer): Buffer {
  const commands: PushCommand[] = [];
  let packStart = -1;
  let off = 0;
  // Walk the raw buffer: pkt-lines until the flush, then the pack bytes.
  // (The pack itself is binary and must never be parsed as pkt-lines.)
  while (off < body.length) {
    if (off + 4 > body.length) throw new Error('truncated pkt-line in push');
    const len = parseInt(body.toString('ascii', off, off + 4), 16);
    if (Number.isNaN(len)) throw new Error('malformed pkt-line in push');
    if (len === 0) {
      off += 4;
      packStart = off;
      break;
    }
    if (len < 4 || off + len > body.length) throw new Error('truncated pkt-line in push');
    const payload = body.toString('utf8', off + 4, off + len);
    const line = payload.replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const head = nul >= 0 ? line.slice(0, nul) : line;
    const parts = head.split(' ');
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts.slice(2).join(' ') });
    }
    off += len;
  }
  if (packStart < 0) throw new Error('push body has no command flush');
  const packBytes = body.subarray(packStart);
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const { objects } = readPack(packBytes, repo.lookup);
      for (const [oid, obj] of objects) {
        const recomputed = hashObject(obj.type, obj.data);
        if (recomputed !== oid) throw new Error(`pack object ${oid} does not hash to its id`);
        repo.storePushed(obj.type, obj.data);
      }
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }
  const report: string[] = [];
  if (unpackError !== null) {
    report.push(`unpack ${unpackError}\n`);
    for (const command of commands) report.push(`ng ${command.ref} unpack failed\n`);
  } else {
    report.push('unpack ok\n');
    for (const command of commands) {
      const verdict = applyPushCommand(repo, command);
      report.push(verdict === null ? `ok ${command.ref}\n` : `ng ${command.ref} ${verdict}\n`);
    }
  }
  const inner = encodePktLines([...report, 'flush']);
  const outerParts: Buffer[] = [];
  for (let off = 0; off < inner.length; off += 65500) {
    outerParts.push(pktLine(Buffer.concat([Buffer.from([1]), inner.subarray(off, Math.min(inner.length, off + 65500))])));
  }
  outerParts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(outerParts);
}

/** Apply one push command; null means ok, otherwise the ng reason. */
function applyPushCommand(repo: Repo, command: PushCommand): string | null {
  const current = repo.refs.get(command.ref);
  if (command.newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) {
      if (command.oldOid !== ZERO_OID) return 'non-fast-forward';
      return null;
    }
    if (command.oldOid !== ZERO_OID && command.oldOid !== current) return 'non-fast-forward';
    repo.deleteRef(command.ref);
    return null;
  }
  const obj = repo.objects.get(command.newOid);
  if (obj === undefined) return 'object not found';
  if (current === undefined) {
    if (command.oldOid !== ZERO_OID) return 'non-fast-forward';
    repo.setRef(command.ref, command.newOid);
    return null;
  }
  if (command.oldOid !== current) return 'non-fast-forward';
  if (command.ref.startsWith('refs/tags/')) {
    // Tags move only to the same object without force.
    if (command.newOid !== current) return 'non-fast-forward';
    return null;
  }
  if (obj.type !== 'commit' && obj.type !== 'tag') return 'object not found';
  if (command.ref.startsWith('refs/heads/') && obj.type !== 'commit') return 'object not found';
  const newCommit = obj.type === 'tag' ? parseTag(obj.data).object : command.newOid;
  if (!isOid(newCommit)) return 'object not found';
  if (!fastForwardOk(repo, current, newCommit)) return 'non-fast-forward';
  repo.setRef(command.ref, command.newOid);
  return null;
}
