// GraphQL v4 for the documents gh and github-mcp-server send: a small parser for
// the query subset they use (operations, variables, aliases, inline fragments,
// input objects, enums, lists) and an executor over the same store as REST.
// Unknown fields answer HTTP 200 with an errors array naming the field.

import { type Issue, type Pull, type Repo, type Store } from './store.ts';
import { VIEWER_LOGIN } from './scenario.ts';

// ---------------------------------------------------------------- global ids

/** Opaque Relay ids: base64url of "<kind>:<key>", never the plain number. */
export function encodeGid(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}

export function decodeGid(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}


/** Split an issue/pull global-id key `owner/name:number` into its parts. */
function parseNumberedKey(key: string): { owner: string; name: string; number: number } | null {
  const colon = key.lastIndexOf(':');
  if (colon < 0) return null;
  const repoPart = key.slice(0, colon);
  const slash = repoPart.indexOf('/');
  if (slash < 0) return null;
  const number = Number(key.slice(colon + 1));
  if (!Number.isInteger(number)) return null;
  return { owner: repoPart.slice(0, slash), name: repoPart.slice(slash + 1), number };
}

function repoGid(repo: Repo): string {
  return encodeGid('R', `${repo.owner}/${repo.name}`);
}

function issueGid(repo: Repo, issue: Issue): string {
  return encodeGid('I', `${repo.owner}/${repo.name}:${issue.number}`);
}

function pullGid(repo: Repo, pull: Pull): string {
  return encodeGid('P', `${repo.owner}/${repo.name}:${pull.number}`);
}

function commentGid(repo: Repo, issue: Issue, commentId: number): string {
  return encodeGid('C', `${repo.owner}/${repo.name}:${issue.number}:${commentId}`);
}

// ---------------------------------------------------------------- parser

type GqlValue =
  | string
  | number
  | boolean
  | null
  | { kind: 'var'; name: string }
  | { kind: 'enum'; value: string }
  | GqlValue[]
  | { [key: string]: GqlValue };

interface GqlField {
  alias: string;
  name: string;
  args: Record<string, GqlValue>;
  selections: GqlField[] | null;
  /** Inline fragment type condition, when this entry is `... on Type { }`. */
  fragmentOn: string | null;
}

interface GqlOperation {
  kind: 'query' | 'mutation';
  selections: GqlField[];
}

class GqlParser {
  src: string;
  pos = 0;

  constructor(src: string) {
    this.src = src;
  }

  error(message: string): Error {
    return new Error(`GraphQL parse error at ${this.pos}: ${message}`);
  }

  skip(): void {
    for (;;) {
      while (this.pos < this.src.length && /[\s,]/.test(this.src[this.pos] as string)) this.pos += 1;
      if (this.src[this.pos] === '#') {
        while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos += 1;
        continue;
      }
      return;
    }
  }

  peek(): string {
    this.skip();
    return this.src[this.pos] ?? '';
  }

  expect(ch: string): void {
    this.skip();
    if (this.src[this.pos] !== ch) throw this.error(`expected ${JSON.stringify(ch)}, got ${JSON.stringify(this.src[this.pos] ?? '')}`);
    this.pos += 1;
  }

  readName(): string {
    this.skip();
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.pos));
    if (match === null) throw this.error('expected a name');
    this.pos += match[0].length;
    return match[0];
  }

  readString(): string {
    this.skip();
    if (this.src[this.pos] !== '"') throw this.error('expected a string');
    this.pos += 1;
    let out = '';
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos] as string;
      if (ch === '"') {
        this.pos += 1;
        return out;
      }
      if (ch === '\\') {
        const next = this.src[this.pos + 1] as string;
        const escapes: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/' };
        out += escapes[next] ?? next;
        this.pos += 2;
        continue;
      }
      out += ch;
      this.pos += 1;
    }
    throw this.error('unterminated string');
  }

  readValue(): GqlValue {
    this.skip();
    const ch = this.src[this.pos] as string;
    if (ch === '"') return this.readString();
    if (ch === '$') {
      this.pos += 1;
      return { kind: 'var', name: this.readName() };
    }
    if (ch === '[') {
      this.pos += 1;
      const items: GqlValue[] = [];
      while (this.peek() !== ']') items.push(this.readValue());
      this.expect(']');
      return items;
    }
    if (ch === '{') {
      this.pos += 1;
      const obj: Record<string, GqlValue> = {};
      while (this.peek() !== '}') {
        const key = this.readName();
        this.expect(':');
        obj[key] = this.readValue();
      }
      this.expect('}');
      return obj;
    }
    const num = /^-?\d+(\.\d+)?/.exec(this.src.slice(this.pos));
    if (num !== null) {
      this.pos += num[0].length;
      return Number(num[0]);
    }
    const name = this.readName();
    if (name === 'true') return true;
    if (name === 'false') return false;
    if (name === 'null') return null;
    return { kind: 'enum', value: name };
  }

  readArgs(): Record<string, GqlValue> {
    const args: Record<string, GqlValue> = {};
    this.skip();
    if (this.src[this.pos] !== '(') return args;
    this.pos += 1;
    while (this.peek() !== ')') {
      const key = this.readName();
      this.expect(':');
      args[key] = this.readValue();
    }
    this.expect(')');
    return args;
  }

  readSelectionSet(): GqlField[] {
    this.expect('{');
    const fields: GqlField[] = [];
    while (this.peek() !== '}') {
      if (this.src.slice(this.pos, this.pos + 3) === '...') {
        this.pos += 3;
        this.skip();
        if (this.src.slice(this.pos, this.pos + 2) === 'on') {
          this.pos += 2;
          const typeName = this.readName();
          const selections = this.readSelectionSet();
          for (const field of selections) fields.push({ ...field, fragmentOn: typeName });
        } else {
          // A named fragment spread: unsupported by the suite's documents; skip its set.
          this.readName();
          this.skip();
          if (this.src[this.pos] === '{') this.readSelectionSet();
        }
        continue;
      }
      const first = this.readName();
      let alias = first;
      let name = first;
      this.skip();
      if (this.src[this.pos] === ':') {
        this.pos += 1;
        name = this.readName();
      }
      const args = this.readArgs();
      let selections: GqlField[] | null = null;
      this.skip();
      if (this.src[this.pos] === '{') selections = this.readSelectionSet();
      fields.push({ alias, name, args, selections, fragmentOn: null });
    }
    this.expect('}');
    return fields;
  }

  parseOperation(): GqlOperation {
    this.skip();
    let kind: 'query' | 'mutation' = 'query';
    const word = this.src.slice(this.pos, this.pos + 8);
    if (word.startsWith('mutation')) {
      kind = 'mutation';
      this.pos += 8;
      this.skip();
      if (/[A-Za-z_]/.test(this.src[this.pos] ?? '')) this.readName();
    } else if (word.startsWith('query')) {
      this.pos += 5;
      this.skip();
      if (/[A-Za-z_]/.test(this.src[this.pos] ?? '')) this.readName();
    }
    this.skip();
    if (this.src[this.pos] === '(') {
      // Variable definitions: skip them (values come from the variables map).
      let depth = 0;
      while (this.pos < this.src.length) {
        const ch = this.src[this.pos] as string;
        if (ch === '(') depth += 1;
        else if (ch === ')') {
          depth -= 1;
          this.pos += 1;
          if (depth === 0) break;
          continue;
        } else if (ch === '"') {
          this.readString();
          continue;
        }
        this.pos += 1;
      }
    }
    const selections = this.readSelectionSet();
    return { kind, selections };
  }
}

// ---------------------------------------------------------------- executor

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'closed', 'repository'];
const PULL_FIELDS = ['id', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'mergeable', 'files', 'url', 'author', 'repository', 'mergeCommitSha'];
const REPO_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'fork'];
const SEARCH_ENUMS = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'WIKI', 'PACKAGE', 'MARKETPLACE'];

interface Ctx {
  store: Store;
  errors: Array<{ message: string }>;
}

function resolveValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  if (value !== null && typeof value === 'object') {
    if (Array.isArray(value)) return value.map((v) => resolveValue(v, variables));
    if ((value as { kind?: string }).kind === 'var') return variables[(value as { name: string }).name];
    if ((value as { kind?: string }).kind === 'enum') return (value as { value: string }).value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveValue(v, variables);
    return out;
  }
  return value;
}

function arg<T>(field: GqlField, name: string, variables: Record<string, unknown>): T | undefined {
  const raw = field.args[name];
  if (raw === undefined) return undefined;
  return resolveValue(raw, variables) as T;
}

function stateUpper(state: string): string {
  return state.toUpperCase();
}

function cursorFor(index: number): string {
  return Buffer.from(`c:${index}`, 'utf8').toString('base64url');
}

function indexFromCursor(cursor: string | null | undefined): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!text.startsWith('c:')) return -1;
    const n = parseInt(text.slice(2), 10);
    return Number.isFinite(n) ? n : -1;
  } catch {
    return -1;
  }
}

class Executor {
  ctx: Ctx;
  variables: Record<string, unknown>;

  constructor(store: Store, variables: Record<string, unknown>) {
    this.ctx = { store, errors: [] };
    this.variables = variables;
  }

  /** Execute one operation document; returns {data} or {data: null, errors}. */
  run(op: GqlOperation): { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } {
    const data: Record<string, unknown> = {};
    for (const field of op.selections) {
      if (field.fragmentOn !== null && field.fragmentOn !== 'Query' && field.fragmentOn !== 'Mutation') continue;
      const value = this.resolveRoot(field, op.kind);
      data[field.alias] = value;
    }
    if (this.ctx.errors.length > 0) return { data: null, errors: this.ctx.errors };
    return { data };
  }

  private unknownField(type: string, field: string): null {
    this.ctx.errors.push({ message: `Cannot query field "${field}" on type "${type}".` });
    return null;
  }

  private resolveRoot(field: GqlField, kind: 'query' | 'mutation'): unknown {
    if (kind === 'query') {
      switch (field.name) {
        case 'viewer':
          return this.select('Viewer', { login: VIEWER_LOGIN }, field.selections);
        case 'repository': {
          const owner = arg<string>(field, 'owner', this.variables);
          const name = arg<string>(field, 'name', this.variables);
          const repo = owner !== undefined && name !== undefined ? this.ctx.store.getRepo(owner, name) : undefined;
          if (repo === undefined) return null;
          return this.select('Repository', repo, field.selections);
        }
        case 'node': {
          const id = arg<string>(field, 'id', this.variables);
          if (id === undefined) return null;
          return this.resolveNode(id, field.selections);
        }
        case '__type': {
          const name = arg<string>(field, 'name', this.variables);
          if (name === undefined) return null;
          return this.select('__Type', { typeName: name }, field.selections);
        }
        default:
          return this.unknownField('Query', field.name);
      }
    }
    switch (field.name) {
      case 'createIssue':
        return this.select('CreateIssuePayload', this.mutationCreateIssue(field), field.selections);
      case 'closeIssue':
        return this.select('CloseIssuePayload', this.mutationCloseIssue(field), field.selections);
      case 'createPullRequest':
        return this.select('CreatePullRequestPayload', this.mutationCreatePullRequest(field), field.selections);
      case 'mergePullRequest':
        return this.select('MergePullRequestPayload', this.mutationMergePullRequest(field), field.selections);
      case 'addComment':
        return this.select('AddCommentPayload', this.mutationAddComment(field), field.selections);
      default:
        return this.unknownField('Mutation', field.name);
    }
  }

  private resolveNode(id: string, selections: GqlField[] | null): unknown {
    const decoded = decodeGid(id);
    if (decoded === null) return null;
    if (decoded.kind === 'R') {
      const [owner, name] = decoded.key.split('/');
      if (owner === undefined || name === undefined) return null;
      const repo = this.ctx.store.getRepo(owner, name);
      if (repo === undefined) return null;
      return this.select('Repository', repo, selections);
    }
    if (decoded.kind === 'I') {
      const parts = parseNumberedKey(decoded.key);
      if (parts === null) return null;
      const repo = this.ctx.store.getRepo(parts.owner, parts.name);
      const issue = repo?.issuesByNumber.get(parts.number);
      if (repo === undefined || issue === undefined) return null;
      return this.select('Issue', { repo, issue }, selections);
    }
    return null;
  }

  /** Select subfields of a typed value. */
  private select(type: string, value: unknown, selections: GqlField[] | null): unknown {
    if (value === null || value === undefined) return null;
    if (selections === null) return this.scalar(type, value);
    const out: Record<string, unknown> = {};
    for (const field of selections) {
      if (field.fragmentOn !== null && field.fragmentOn !== type) continue;
      out[field.alias] = this.resolveField(type, value, field);
    }
    return out;
  }

  private scalar(type: string, value: unknown): unknown {
    if (type === '__Type') return (value as { typeName: string }).typeName;
    return value;
  }

  private resolveField(type: string, value: unknown, field: GqlField): unknown {
    switch (type) {
      case 'Viewer': {
        const viewer = value as { login: string };
        if (field.name === 'login') return viewer.login;
        return this.unknownField('Viewer', field.name);
      }
      case 'User': {
        const user = value as { login: string };
        if (field.name === 'login') return user.login;
        return this.unknownField('User', field.name);
      }
      case 'Repository': {
        const repo = value as Repo;
        switch (field.name) {
          case 'id':
            return repoGid(repo);
          case 'databaseId':
            return repo.id;
          case 'name':
            return repo.name;
          case 'nameWithOwner':
            return repo.fullName;
          case 'owner':
            return this.select('User', { login: repo.owner }, field.selections);
          case 'defaultBranchRef': {
            const tip = repo.defaultTip();
            if (tip === undefined) return null;
            return this.select('Ref', { name: repo.defaultBranch }, field.selections);
          }
          case 'viewerPermission':
            return 'ADMIN';
          case 'hasIssuesEnabled':
            return true;
          case 'description':
            return repo.description;
          case 'url':
            return `https://github.com/${repo.fullName}`;
          case 'issue': {
            const number = arg<number>(field, 'number', this.variables);
            if (number === undefined) return null;
            const issue = repo.issuesByNumber.get(number);
            if (issue === undefined) return null;
            return this.select('Issue', { repo, issue }, field.selections);
          }
          case 'issues':
            return this.select('IssueConnection', this.issueConnection(repo, field), field.selections);
          case 'pullRequests':
            return this.select('PullRequestConnection', this.pullConnection(repo, field), field.selections);
          case 'pullRequest': {
            const number = arg<number>(field, 'number', this.variables);
            if (number === undefined) return null;
            const pull = repo.pullsByNumber.get(number);
            if (pull === undefined) return null;
            return this.select('PullRequest', { repo, pull }, field.selections);
          }
          default:
            return this.unknownField('Repository', field.name);
        }
      }
      case 'Ref': {
        const ref = value as { name: string };
        if (field.name === 'name') return ref.name;
        return this.unknownField('Ref', field.name);
      }
      case 'Issue': {
        const wrapped = value as { repo: Repo; issue: Issue };
        const issue = wrapped.issue;
        switch (field.name) {
          case 'id':
            return issueGid(wrapped.repo, issue);
          case 'number':
            return issue.number;
          case 'title':
            return issue.title;
          case 'state':
            return stateUpper(issue.state);
          case 'body':
            return issue.body;
          case 'url':
            return `https://github.com/${wrapped.repo.fullName}/issues/${issue.number}`;
          case 'repository':
            return this.select('Repository', wrapped.repo, field.selections);
          default:
            return this.unknownField('Issue', field.name);
        }
      }
      case 'IssueConnection': {
        const conn = value as { nodes: Array<{ repo: Repo; issue: Issue }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
        switch (field.name) {
          case 'nodes':
            return conn.nodes.map((node) => this.select('Issue', node, field.selections));
          case 'pageInfo':
            return this.select('PageInfo', conn.pageInfo, field.selections);
          default:
            return this.unknownField('IssueConnection', field.name);
        }
      }
      case 'PullRequestConnection': {
        const conn = value as { nodes: Array<{ repo: Repo; pull: Pull }> };
        if (field.name === 'nodes') return conn.nodes.map((node) => this.select('PullRequest', node, field.selections));
        return this.unknownField('PullRequestConnection', field.name);
      }
      case 'PullRequest': {
        const wrapped = value as { repo: Repo; pull: Pull };
        const pull = wrapped.pull;
        switch (field.name) {
          case 'id':
            return pullGid(wrapped.repo, pull);
          case 'number':
            return pull.number;
          case 'title':
            return pull.title;
          case 'body':
            return pull.body;
          case 'state':
            return pull.merged ? 'MERGED' : stateUpper(pull.state);
          case 'merged':
            return pull.merged;
          case 'mergedAt':
            return pull.mergedAt;
          case 'headRefName':
            return pull.headRef;
          case 'baseRefName':
            return pull.baseRef;
          case 'mergeable':
            return wrapped.repo.pullMergeable(pull);
          case 'mergeCommitSha':
            return pull.mergeCommitSha;
          case 'files': {
            const first = arg<number>(field, 'first', this.variables) ?? 100;
            const files = wrapped.repo.pullFiles(pull).slice(0, first);
            return this.select('PullRequestChangedFileConnection', { nodes: files }, field.selections);
          }
          case 'repository':
            return this.select('Repository', wrapped.repo, field.selections);
          default:
            return this.unknownField('PullRequest', field.name);
        }
      }
      case 'PullRequestChangedFileConnection': {
        const conn = value as { nodes: Array<{ filename: string }> };
        if (field.name === 'nodes') return conn.nodes.map((node) => this.select('PullRequestChangedFile', node, field.selections));
        return this.unknownField('PullRequestChangedFileConnection', field.name);
      }
      case 'PullRequestChangedFile': {
        const file = value as { filename: string };
        if (field.name === 'path') return file.filename;
        return this.unknownField('PullRequestChangedFile', field.name);
      }
      case 'PageInfo': {
        const info = value as { hasNextPage: boolean; endCursor: string | null };
        if (field.name === 'hasNextPage') return info.hasNextPage;
        if (field.name === 'endCursor') return info.endCursor;
        if (field.name === 'hasPreviousPage') return false;
        if (field.name === 'startCursor') return null;
        return this.unknownField('PageInfo', field.name);
      }
      case '__Type': {
        const typeName = (value as { typeName: string }).typeName;
        if (field.name === 'name') return typeName;
        if (field.name === 'fields') {
          const names = typeName === 'Issue' ? ISSUE_FIELDS : typeName === 'PullRequest' ? PULL_FIELDS : typeName === 'Repository' ? REPO_FIELDS : [];
          return names.map((name) => this.select('__Field', { name }, field.selections));
        }
        if (field.name === 'enumValues') {
          const names = typeName === 'SearchType' ? SEARCH_ENUMS : [];
          return names.map((name) => this.select('__EnumValue', { name }, field.selections));
        }
        return this.unknownField('__Type', field.name);
      }
      case '__Field': {
        const f = value as { name: string };
        if (field.name === 'name') return f.name;
        return this.unknownField('__Field', field.name);
      }
      case '__EnumValue': {
        const f = value as { name: string };
        if (field.name === 'name') return f.name;
        return this.unknownField('__EnumValue', field.name);
      }
      case 'CreateIssuePayload': {
        const payload = value as { issue: { repo: Repo; issue: Issue } | null };
        if (field.name === 'issue') return payload.issue === null ? null : this.select('Issue', payload.issue, field.selections);
        return this.unknownField('CreateIssuePayload', field.name);
      }
      case 'CloseIssuePayload': {
        const payload = value as { issue: { repo: Repo; issue: Issue } | null };
        if (field.name === 'issue') return payload.issue === null ? null : this.select('Issue', payload.issue, field.selections);
        return this.unknownField('CloseIssuePayload', field.name);
      }
      case 'CreatePullRequestPayload': {
        const payload = value as { pullRequest: { repo: Repo; pull: Pull } | null };
        if (field.name === 'pullRequest') return payload.pullRequest === null ? null : this.select('PullRequest', payload.pullRequest, field.selections);
        return this.unknownField('CreatePullRequestPayload', field.name);
      }
      case 'MergePullRequestPayload': {
        const payload = value as { pullRequest: { repo: Repo; pull: Pull } | null };
        if (field.name === 'pullRequest') return payload.pullRequest === null ? null : this.select('PullRequest', payload.pullRequest, field.selections);
        return this.unknownField('MergePullRequestPayload', field.name);
      }
      case 'AddCommentPayload': {
        const payload = value as { commentEdge: { node: { id: string; body: string } } | null };
        if (field.name === 'commentEdge') return payload.commentEdge === null ? null : this.select('CommentEdge', payload.commentEdge, field.selections);
        return this.unknownField('AddCommentPayload', field.name);
      }
      case 'CommentEdge': {
        const edge = value as { node: { id: string; body: string } };
        if (field.name === 'node') return this.select('IssueComment', edge.node, field.selections);
        return this.unknownField('CommentEdge', field.name);
      }
      case 'IssueComment': {
        const comment = value as { id: string; body: string };
        if (field.name === 'id') return comment.id;
        if (field.name === 'body') return comment.body;
        return this.unknownField('IssueComment', field.name);
      }
      default:
        return this.unknownField(type, field.name);
    }
  }

  private issueConnection(repo: Repo, field: GqlField): { nodes: Array<{ repo: Repo; issue: Issue }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } {
    const first = arg<number>(field, 'first', this.variables);
    const after = arg<string>(field, 'after', this.variables);
    const states = arg<string[]>(field, 'states', this.variables);
    const orderBy = arg<{ field?: string; direction?: string }>(field, 'orderBy', this.variables);
    let list = [...repo.issues];
    if (states !== undefined && states.length > 0) {
      const wanted = new Set(states.map((s) => s.toUpperCase()));
      list = list.filter((issue) => wanted.has(stateUpper(issue.state)));
    }
    const direction = orderBy?.direction?.toUpperCase() ?? 'ASC';
    if (direction === 'DESC') list.sort((a, b) => b.number - a.number);
    else list.sort((a, b) => a.number - b.number);
    const start = indexFromCursor(after ?? null) + 1;
    const page = first === undefined ? list.slice(start) : list.slice(start, start + first);
    const endIndex = page.length === 0 ? -1 : start + page.length - 1;
    return {
      nodes: page.map((issue) => ({ repo, issue })),
      pageInfo: { hasNextPage: endIndex >= 0 && endIndex < list.length - 1, endCursor: endIndex < 0 ? null : cursorFor(endIndex) },
    };
  }

  private pullConnection(repo: Repo, field: GqlField): { nodes: Array<{ repo: Repo; pull: Pull }> } {
    const first = arg<number>(field, 'first', this.variables);
    const nodes = repo.pulls.filter((pull) => pull.state === 'open');
    const page = first === undefined ? nodes : nodes.slice(0, first);
    return { nodes: page.map((pull) => ({ repo, pull })) };
  }

  private findRepoByGid(id: string): Repo | null {
    const decoded = decodeGid(id);
    if (decoded === null || decoded.kind !== 'R') return null;
    const [owner, name] = decoded.key.split('/');
    if (owner === undefined || name === undefined) return null;
    return this.ctx.store.getRepo(owner, name) ?? null;
  }

  private mutationCreateIssue(field: GqlField): { issue: { repo: Repo; issue: Issue } | null } {
    const input = arg<{ repositoryId?: string; title?: string; body?: string }>(field, 'input', this.variables) ?? {};
    const repo = input.repositoryId !== undefined ? this.findRepoByGid(input.repositoryId) : null;
    if (repo === null || input.title === undefined) {
      this.ctx.errors.push({ message: 'createIssue: unknown repository or missing title' });
      return { issue: null };
    }
    const issue = this.ctx.store.createIssue(repo, input.title, input.body ?? '', []);
    return { issue: { repo, issue } };
  }

  private mutationCloseIssue(field: GqlField): { issue: { repo: Repo; issue: Issue } | null } {
    const input = arg<{ issueId?: string }>(field, 'input', this.variables) ?? {};
    const decoded = input.issueId !== undefined ? decodeGid(input.issueId) : null;
    if (decoded === null || decoded.kind !== 'I') {
      this.ctx.errors.push({ message: 'closeIssue: unknown issue' });
      return { issue: null };
    }
    const parts = parseNumberedKey(decoded.key);
    if (parts === null) {
      this.ctx.errors.push({ message: 'closeIssue: unknown issue' });
      return { issue: null };
    }
    const repo = this.ctx.store.getRepo(parts.owner, parts.name);
    const issue = repo?.issuesByNumber.get(parts.number);
    if (repo === undefined || issue === undefined) {
      this.ctx.errors.push({ message: 'closeIssue: unknown issue' });
      return { issue: null };
    }
    issue.state = 'closed';
    issue.jsonCache = null;
    return { issue: { repo, issue } };
  }

  private mutationCreatePullRequest(field: GqlField): { pullRequest: { repo: Repo; pull: Pull } | null } {
    const input = arg<{ repositoryId?: string; baseRefName?: string; headRefName?: string; title?: string; body?: string }>(field, 'input', this.variables) ?? {};
    const repo = input.repositoryId !== undefined ? this.findRepoByGid(input.repositoryId) : null;
    if (repo === null || input.headRefName === undefined || input.baseRefName === undefined || input.title === undefined) {
      this.ctx.errors.push({ message: 'createPullRequest: unknown repository or missing input' });
      return { pullRequest: null };
    }
    const pull = this.ctx.store.createPull(repo, input.title, input.body ?? '', input.headRefName, input.baseRefName);
    if (pull === null) {
      this.ctx.errors.push({ message: 'createPullRequest: the head branch does not exist or a pull request is already open' });
      return { pullRequest: null };
    }
    return { pullRequest: { repo, pull } };
  }

  private mutationMergePullRequest(field: GqlField): { pullRequest: { repo: Repo; pull: Pull } | null } {
    const input = arg<{ pullRequestId?: string; mergeMethod?: string }>(field, 'input', this.variables) ?? {};
    const decoded = input.pullRequestId !== undefined ? decodeGid(input.pullRequestId) : null;
    if (decoded === null || decoded.kind !== 'P') {
      this.ctx.errors.push({ message: 'mergePullRequest: unknown pull request' });
      return { pullRequest: null };
    }
    const parts = parseNumberedKey(decoded.key);
    if (parts === null) {
      this.ctx.errors.push({ message: 'mergePullRequest: unknown pull request' });
      return { pullRequest: null };
    }
    const repo = this.ctx.store.getRepo(parts.owner, parts.name);
    const pull = repo?.pullsByNumber.get(parts.number);
    if (repo === undefined || pull === undefined) {
      this.ctx.errors.push({ message: 'mergePullRequest: unknown pull request' });
      return { pullRequest: null };
    }
    const merged = repo.mergePull(pull);
    if (!merged.ok) {
      this.ctx.errors.push({ message: `mergePullRequest: ${merged.message}` });
      return { pullRequest: null };
    }
    return { pullRequest: { repo, pull } };
  }

  private mutationAddComment(field: GqlField): { commentEdge: { node: { id: string; body: string } } | null } {
    const input = arg<{ subjectId?: string; body?: string }>(field, 'input', this.variables) ?? {};
    const decoded = input.subjectId !== undefined ? decodeGid(input.subjectId) : null;
    if (decoded === null || decoded.kind !== 'I' || input.body === undefined) {
      this.ctx.errors.push({ message: 'addComment: unknown subject or missing body' });
      return { commentEdge: null };
    }
    const parts = parseNumberedKey(decoded.key);
    if (parts === null) {
      this.ctx.errors.push({ message: 'addComment: unknown subject' });
      return { commentEdge: null };
    }
    const repo = this.ctx.store.getRepo(parts.owner, parts.name);
    const issue = repo?.issuesByNumber.get(parts.number);
    if (repo === undefined || issue === undefined) {
      this.ctx.errors.push({ message: 'addComment: unknown subject' });
      return { commentEdge: null };
    }
    const id = this.ctx.store.commentIdSeq;
    this.ctx.store.commentIdSeq += 1;
    issue.comments.push({ id, body: input.body });
    issue.jsonCache = null;
    return { commentEdge: { node: { id: commentGid(repo, issue, id), body: input.body } } };
  }
}

/** Execute one GraphQL operation document against the store. */
export function executeGraphQL(
  store: Store,
  query: string,
  variables: Record<string, unknown>,
): { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } {
  try {
    const op = new GqlParser(query).parseOperation();
    return new Executor(store, variables).run(op);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}
