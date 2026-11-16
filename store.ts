// The forge's store: repositories, git objects and refs, issues, pull requests,
// labels and comments — all in memory, one process, no clock in any stored value
// (fixed timestamps keep two runs' behaviour identical).

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isAncestor,
  isOid,
  mergeBase,
  parseCommit,
  parseTree,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitcore.ts';
import { VIEWER_LOGIN } from './scenario.ts';

export const FIXED_EPOCH = 1_735_689_600; // 2025-01-01T00:00:00Z, every REST-made commit
export const FIXED_ISO = '2025-01-01T00:00:00Z';
const COMMITTER = `${VIEWER_LOGIN} <${VIEWER_LOGIN}@example.invalid>`;

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: IssueComment[];
  seq: number;
  jsonCache: Buffer | null;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
}

export interface PullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

export class Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch = 'main';
  refs = new Map<string, string>();
  objects = new Map<string, GitObject>();
  commitSeq = new Map<string, number>();
  seqCounter = 0;
  issues: Issue[] = [];
  issuesByNumber = new Map<number, Issue>();
  pulls: Pull[] = [];
  pullsByNumber = new Map<number, Pull>();
  nextNumber = 1;
  labels = new Map<string, Label>();
  jsonCache: Buffer | null = null;
  /** Cached advertisement bodies, rebuilt whenever a ref moves. */
  adCache = new Map<string, Buffer>();
  /** Cached fetch pack per (tip, depth, haves-key) for the clone workload. */
  packCache = new Map<string, Buffer>();

  constructor(id: number, owner: string, name: string, description: string, isPrivate: boolean) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  lookup = (oid: string): GitObject | undefined => this.objects.get(oid);

  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) {
      this.objects.set(oid, { type, data });
      if (type === 'commit') this.commitSeq.set(oid, ++this.seqCounter);
    }
    return oid;
  }

  /** Store an object the client pushed, keyed by its recomputed id. */
  storePushed(type: GitObjectType, data: Buffer): string {
    return this.putObject(type, data);
  }

  refTip(ref: string): string | undefined {
    return this.refs.get(ref);
  }

  setRef(ref: string, oid: string): void {
    this.refs.set(ref, oid);
    this.adCache.clear();
    this.packCache.clear();
  }

  deleteRef(ref: string): void {
    this.refs.delete(ref);
    this.adCache.clear();
    this.packCache.clear();
  }

  defaultTip(): string | undefined {
    return this.refs.get(`refs/heads/${this.defaultBranch}`);
  }

  /** Resolve a ref name or branch name to a commit oid. */
  resolveRef(ref: string): string | undefined {
    if (ref.startsWith('refs/')) return this.refs.get(ref);
    // A raw oid that exists in the store resolves to itself (contents ?ref=<sha> etc.).
    if (isOid(ref) && this.objects.has(ref)) return ref;
    return this.refs.get(`refs/heads/${ref}`) ?? this.refs.get(`refs/tags/${ref}`);
  }

  /** The tree oid of a commit, or undefined. */
  treeOf(commitOid: string): string | undefined {
    const obj = this.objects.get(commitOid);
    if (obj === undefined || obj.type !== 'commit') return undefined;
    return parseCommit(obj.data).tree;
  }

  /** Flatten a tree to path -> entry (recursive). */
  flattenTree(treeOid: string, prefix = ''): Map<string, TreeEntry> {
    const out = new Map<string, TreeEntry>();
    const walk = (oid: string, path: string): void => {
      const obj = this.objects.get(oid);
      if (obj === undefined || obj.type !== 'tree') return;
      for (const entry of parseTree(obj.data)) {
        const full = path === '' ? entry.name : `${path}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, full);
        else out.set(full, entry);
      }
    };
    walk(treeOid, prefix);
    return out;
  }

  /** Read a file's blob at a ref; null when absent. */
  readFileAt(ref: string, path: string): { oid: string; data: Buffer } | null {
    const tip = this.resolveRef(ref);
    if (tip === undefined) return null;
    const treeOid = this.treeOf(tip);
    if (treeOid === undefined) return null;
    const flat = this.flattenTree(treeOid);
    const entry = flat.get(path);
    if (entry === undefined) return null;
    const obj = this.objects.get(entry.oid);
    if (obj === undefined || obj.type !== 'blob') return null;
    return { oid: entry.oid, data: obj.data };
  }

  /** List a directory at a ref; null when the ref or path is absent. */
  listDirAt(ref: string, path: string): Array<{ name: string; path: string; type: string; sha: string }> | null {
    const tip = this.resolveRef(ref);
    if (tip === undefined) return null;
    const treeOid = this.treeOf(tip);
    if (treeOid === undefined) return null;
    let dirOid = treeOid;
    if (path !== '') {
      const parts = path.split('/');
      let current = treeOid;
      for (const part of parts) {
        const obj = this.objects.get(current);
        if (obj === undefined || obj.type !== 'tree') return null;
        const entry = parseTree(obj.data).find((e) => e.name === part);
        if (entry === undefined || entry.mode !== '40000') return null;
        current = entry.oid;
      }
      dirOid = current;
    }
    const obj = this.objects.get(dirOid);
    if (obj === undefined || obj.type !== 'tree') return null;
    return parseTree(obj.data).map((entry) => ({
      name: entry.name,
      path: path === '' ? entry.name : `${path}/${entry.name}`,
      type: entry.mode === '40000' ? 'dir' : 'file',
      sha: entry.oid,
    }));
  }

  /** Commits reachable from `ref`, newest first (by insertion order). */
  commitsFrom(ref: string): string[] {
    const tip = this.resolveRef(ref);
    if (tip === undefined) return [];
    const reachable = collectReachable([tip], this.lookup);
    const commits = [...reachable].filter((oid) => {
      const obj = this.objects.get(oid);
      return obj !== undefined && obj.type === 'commit';
    });
    commits.sort((a, b) => (this.commitSeq.get(b) ?? 0) - (this.commitSeq.get(a) ?? 0));
    return commits;
  }

  /** Commit one file through the contents API. */
  commitFile(options: {
    branch: string;
    path: string;
    content: Buffer;
    message: string;
    expectedSha?: string;
  }): { ok: true; commitSha: string; contentSha: string; created: boolean } | { ok: false; status: number; message: string } {
    const refName = `refs/heads/${options.branch}`;
    const currentTip = this.refs.get(refName);
    const existing = currentTip === undefined ? null : this.readFileAt(refName, options.path);
    if (existing !== null && options.expectedSha === undefined) {
      return { ok: false, status: 409, message: 'file already exists; a sha is required to update it' };
    }
    if (existing !== null && options.expectedSha !== undefined && options.expectedSha.toLowerCase() !== existing.oid.toLowerCase()) {
      return { ok: false, status: 409, message: 'sha does not match the current file' };
    }
    if (existing === null && options.expectedSha !== undefined) {
      return { ok: false, status: 409, message: 'sha does not match: the file does not exist' };
    }
    const created = existing === null;
    const blobOid = this.putObject('blob', options.content);
    const parent = currentTip ?? this.defaultTip();
    const baseTree = parent === undefined ? undefined : this.treeOf(parent);
    const newTree = this.updateTree(baseTree, options.path.split('/'), blobOid);
    const commitData = buildCommit({
      tree: newTree,
      parents: parent === undefined ? [] : [parent],
      message: options.message.endsWith('\n') ? options.message : `${options.message}\n`,
      author: COMMITTER,
      committer: COMMITTER,
      timestamp: FIXED_EPOCH,
    });
    const commitSha = this.putObject('commit', commitData);
    this.setRef(refName, commitSha);
    return { ok: true, commitSha, contentSha: blobOid, created };
  }

  /** Delete a file through the contents API. */
  deleteFile(options: { branch: string; path: string; message: string; expectedSha?: string }): { ok: true; commitSha: string } | { ok: false; status: number; message: string } {
    const refName = `refs/heads/${options.branch}`;
    const currentTip = this.refs.get(refName);
    if (currentTip === undefined) return { ok: false, status: 404, message: 'Not Found' };
    const existing = this.readFileAt(refName, options.path);
    if (existing === null) return { ok: false, status: 404, message: 'Not Found' };
    if (options.expectedSha !== undefined && options.expectedSha.toLowerCase() !== existing.oid.toLowerCase()) {
      return { ok: false, status: 409, message: 'sha does not match the current file' };
    }
    const baseTree = this.treeOf(currentTip);
    if (baseTree === undefined) return { ok: false, status: 404, message: 'Not Found' };
    const newTree = this.removeFromTree(baseTree, options.path.split('/'));
    if (newTree === null) return { ok: false, status: 404, message: 'Not Found' };
    const commitData = buildCommit({
      tree: newTree,
      parents: [currentTip],
      message: options.message.endsWith('\n') ? options.message : `${options.message}\n`,
      author: COMMITTER,
      committer: COMMITTER,
      timestamp: FIXED_EPOCH,
    });
    const commitSha = this.putObject('commit', commitData);
    this.setRef(refName, commitSha);
    return { ok: true, commitSha };
  }

  /** Return a new root tree oid with `path` set to `blobOid` (creating dirs as needed). */
  updateTree(baseTree: string | undefined, segments: string[], blobOid: string): string {
    if (segments.length === 0) return baseTree ?? this.putObject('tree', buildTree([]));
    const [head, ...rest] = segments as [string, ...string[]];
    let entries: TreeEntry[] = [];
    if (baseTree !== undefined) {
      const baseObj = this.objects.get(baseTree);
      if (baseObj === undefined || baseObj.type !== 'tree') throw new Error(`updateTree: missing base tree ${baseTree}`);
      entries = parseTree(baseObj.data);
    }
    const idx = entries.findIndex((e) => e.name === head);
    if (rest.length === 0) {
      const entry: TreeEntry = { mode: '100644', name: head, oid: blobOid };
      if (idx >= 0) entries[idx] = entry;
      else entries.push(entry);
      return this.putObject('tree', buildTree(entries));
    }
    const childTree = idx >= 0 && entries[idx]?.mode === '40000' ? entries[idx]?.oid : undefined;
    const newChild = this.updateTree(childTree, rest, blobOid);
    const entry: TreeEntry = { mode: '40000', name: head, oid: newChild };
    if (idx >= 0) entries[idx] = entry;
    else entries.push(entry);
    return this.putObject('tree', buildTree(entries));
  }

  /** Return a new root tree oid with `path` removed, or null when the path is absent. */
  removeFromTree(baseTree: string, segments: string[]): string | null {
    const [head, ...rest] = segments as [string, ...string[]];
    const obj = this.objects.get(baseTree);
    if (obj === undefined || obj.type !== 'tree') return null;
    const entries = parseTree(obj.data);
    const idx = entries.findIndex((e) => e.name === head);
    if (idx < 0) return null;
    if (rest.length === 0) {
      entries.splice(idx, 1);
      return this.putObject('tree', buildTree(entries));
    }
    const child = entries[idx] as TreeEntry;
    if (child.mode !== '40000') return null;
    const newChild = this.removeFromTree(child.oid, rest);
    if (newChild === null) return null;
    entries[idx] = { mode: '40000', name: head, oid: newChild };
    return this.putObject('tree', buildTree(entries));
  }

  /** Diff two trees (flat path maps) into pull-request file entries. */
  diffTrees(baseTree: string | undefined, headTree: string | undefined): PullFile[] {
    const base = baseTree === undefined ? new Map<string, TreeEntry>() : this.flattenTree(baseTree);
    const head = headTree === undefined ? new Map<string, TreeEntry>() : this.flattenTree(headTree);
    const files: PullFile[] = [];
    const names = new Set([...base.keys(), ...head.keys()]);
    for (const name of [...names].sort()) {
      const b = base.get(name);
      const h = head.get(name);
      if (b !== undefined && h !== undefined && b.oid === h.oid) continue;
      if (b === undefined && h !== undefined) {
        const data = this.objects.get(h.oid)?.data ?? Buffer.alloc(0);
        const lines = countLines(data);
        files.push({ filename: name, status: 'added', additions: lines, deletions: 0, changes: lines });
      } else if (b !== undefined && h === undefined) {
        const data = this.objects.get(b.oid)?.data ?? Buffer.alloc(0);
        const lines = countLines(data);
        files.push({ filename: name, status: 'removed', additions: 0, deletions: lines, changes: lines });
      } else if (b !== undefined && h !== undefined) {
        const oldData = this.objects.get(b.oid)?.data ?? Buffer.alloc(0);
        const newData = this.objects.get(h.oid)?.data ?? Buffer.alloc(0);
        const [additions, deletions] = lineDiff(oldData, newData);
        files.push({ filename: name, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return files;
  }

  /** Files changed between a pull request's merge-base and its head. */
  pullFiles(pull: Pull): PullFile[] {
    const headSha = this.currentHeadSha(pull);
    const base = mergeBase(headSha, pull.baseSha, this.lookup, (oid) => this.commitSeq.get(oid) ?? 0);
    const baseTree = base === null ? undefined : this.treeOf(base);
    return this.diffTrees(baseTree, this.treeOf(headSha));
  }

  /** The current tip of a pull request's base branch (it moves after other merges). */
  currentBaseSha(pull: Pull): string {
    return this.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  }

  /** The current tip of a pull request's head branch (it moves after new pushes). */
  currentHeadSha(pull: Pull): string {
    return this.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  }

  /** Is this pull request mergeable (no conflicting file)? */
  pullMergeable(pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.state !== 'open') return 'UNKNOWN';
    const conflict = this.mergeConflict(pull);
    return conflict === null ? 'MERGEABLE' : 'CONFLICTING';
  }

  /** The conflicting path of a pull request, or null when it merges cleanly. */
  mergeConflict(pull: Pull): string | null {
    const headSha = this.currentHeadSha(pull);
    const base = mergeBase(headSha, this.currentBaseSha(pull), this.lookup, (oid) => this.commitSeq.get(oid) ?? 0);
    const baseTree = base === null ? undefined : this.treeOf(base);
    const baseFlat = baseTree === undefined ? new Map<string, TreeEntry>() : this.flattenTree(baseTree);
    const headFlat = this.treeOf(headSha) === undefined ? new Map<string, TreeEntry>() : this.flattenTree(this.treeOf(headSha) as string);
    const currentSha = this.currentBaseSha(pull);
    const currentFlat = this.treeOf(currentSha) === undefined ? new Map<string, TreeEntry>() : this.flattenTree(this.treeOf(currentSha) as string);
    const names = new Set([...baseFlat.keys(), ...headFlat.keys(), ...currentFlat.keys()]);
    for (const name of names) {
      const b = baseFlat.get(name)?.oid;
      const h = headFlat.get(name)?.oid;
      const c = currentFlat.get(name)?.oid;
      const headChanged = h !== b;
      const baseChanged = c !== b;
      if (headChanged && baseChanged && h !== c) return name;
    }
    return null;
  }

  /** Squash-merge a pull request onto its base branch. */
  mergePull(pull: Pull): { ok: true; sha: string } | { ok: false; status: number; message: string } {
    if (pull.state !== 'open') return { ok: false, status: 405, message: 'Pull request is already closed' };
    const conflict = this.mergeConflict(pull);
    if (conflict !== null) return { ok: false, status: 405, message: `Merge conflict in ${conflict}` };
    const currentBase = this.currentBaseSha(pull);
    const currentHead = this.currentHeadSha(pull);
    const base = mergeBase(currentHead, currentBase, this.lookup, (oid) => this.commitSeq.get(oid) ?? 0);
    const baseTree = base === null ? undefined : this.treeOf(base);
    const baseFlat = baseTree === undefined ? new Map<string, TreeEntry>() : this.flattenTree(baseTree);
    const headFlat = this.treeOf(currentHead) === undefined ? new Map<string, TreeEntry>() : this.flattenTree(this.treeOf(currentHead) as string);
    const currentFlat = this.treeOf(currentBase) === undefined ? new Map<string, TreeEntry>() : this.flattenTree(this.treeOf(currentBase) as string);
    // Overlay the head's changes onto the base tip's tree.
    const result = new Map<string, { oid: string; mode: string }>();
    for (const [path, entry] of currentFlat) result.set(path, { oid: entry.oid, mode: entry.mode });
    for (const [path, entry] of headFlat) {
      if (baseFlat.get(path)?.oid !== entry.oid) result.set(path, { oid: entry.oid, mode: entry.mode });
    }
    for (const path of baseFlat.keys()) {
      // Deleted on the head side: drop it only when the base side did not change it.
      if (!headFlat.has(path) && currentFlat.get(path)?.oid === baseFlat.get(path)?.oid) result.delete(path);
    }
    const newTree = this.treeFromFlat(result);
    const message = `Merge pull request #${pull.number} from ${this.owner}/${pull.headRef}\n\n${pull.title}\n`;
    const commitData = buildCommit({
      tree: newTree,
      parents: [currentBase],
      message,
      author: COMMITTER,
      committer: COMMITTER,
      timestamp: FIXED_EPOCH,
    });
    const sha = this.putObject('commit', commitData);
    this.setRef(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = FIXED_ISO;
    pull.mergeCommitSha = sha;
    return { ok: true, sha };
  }

  /** Build nested trees from a flat path map. */
  treeFromFlat(flat: Map<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, entry] of flat) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const name = segments[i] as string;
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name) as Node;
      }
      node.files.set(segments[segments.length - 1] as string, entry);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject('tree', buildTree(entries));
    };
    return build(root);
  }
}

export function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/** (additions, deletions) between two small texts via LCS on lines. */
export function lineDiff(oldData: Buffer, newData: Buffer): [number, number] {
  const oldLines = oldData.toString('utf8').split('\n');
  const newLines = newData.toString('utf8').split('\n');
  if (oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines[newLines.length - 1] === '') newLines.pop();
  const m = oldLines.length;
  const n = newLines.length;
  if (m * n > 250_000) {
    // Large files: fall back to a line-set estimate (still exact when disjoint).
    const oldSet = new Set(oldLines);
    const newSet = new Set(newLines);
    let additions = 0;
    let deletions = 0;
    for (const line of newLines) if (!oldSet.has(line)) additions += 1;
    for (const line of oldLines) if (!newSet.has(line)) deletions += 1;
    return [additions, deletions];
  }
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i]![j] = oldLines[i] === newLines[j] ? (dp[i + 1]![j + 1] as number) + 1 : Math.max(dp[i + 1]![j] as number, dp[i]![j + 1] as number);
    }
  }
  const common = dp[0]![0] as number;
  return [n - common, m - common];
}

export class Store {
  repos = new Map<string, Repo>();
  viewerRepos: Repo[] = [];
  repoIdSeq = 5000;
  issueIdSeq = 1;
  commentIdSeq = 1;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.has(this.key(owner, name))) return null;
    const repo = new Repo(this.repoIdSeq, owner, name, description, isPrivate);
    this.repoIdSeq += 1;
    this.repos.set(this.key(owner, name), repo);
    if (owner === VIEWER_LOGIN) this.viewerRepos.push(repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    const repo = this.repos.get(this.key(owner, name));
    if (repo === undefined) return false;
    this.repos.delete(this.key(owner, name));
    const idx = this.viewerRepos.indexOf(repo);
    if (idx >= 0) this.viewerRepos.splice(idx, 1);
    return true;
  }

  createIssue(repo: Repo, title: string, body: string, labels: Label[]): Issue {
    const issue: Issue = {
      id: this.issueIdSeq,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labels,
      comments: [],
      seq: repo.nextNumber,
      jsonCache: null,
    };
    this.issueIdSeq += 1;
    repo.nextNumber += 1;
    repo.issues.push(issue);
    repo.issuesByNumber.set(issue.number, issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, head: string, base: string): Pull | null {
    // Normalize to short branch names: callers may pass `refs/heads/feature`.
    const headName = head.replace(/^refs\/heads\//, '');
    const baseName = base.replace(/^refs\/heads\//, '');
    const headSha = repo.resolveRef(headName);
    const baseSha = repo.resolveRef(baseName);
    if (headSha === undefined || baseSha === undefined) return null;
    for (const existing of repo.pulls) {
      if (existing.state === 'open' && existing.headRef === headName && existing.baseRef === baseName) return null;
    }
    const pull: Pull = {
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      headRef: headName,
      baseRef: baseName,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
    };
    repo.nextNumber += 1;
    repo.pulls.push(pull);
    repo.pullsByNumber.set(pull.number, pull);
    return pull;
  }
}

/** Whether `oid` is a commit reachable as an ancestor of `tip` (or equal to it). */
export function fastForwardOk(repo: Repo, oldOid: string, newOid: string): boolean {
  if (oldOid === ZERO_OID) return true;
  if (!isOid(newOid)) return false;
  return isAncestor(oldOid, newOid, repo.lookup);
}
