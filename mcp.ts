// MCP over Streamable HTTP (JSON): the 2026-07-28 era via server/discover, with the
// legacy initialize handshake as a fallback. Tools act on the same store as REST.

import { FIXED_ISO, type Repo, type Store } from './store.ts';
import { VIEWER_LOGIN } from './scenario.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

const TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: 1000 },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.fullName}`,
    url: `/api/v3/repos/${repo.fullName}`,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  };
}

export function issueJson(repo: Repo, issue: { id: number; number: number; title: string; body: string; state: string; labels: Array<{ name: string; color: string }> }): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    user: { login: repo.owner, id: 1000 },
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  };
}

export function pullJson(repo: Repo, pull: { number: number; title: string; body: string; state: string; headRef: string; baseRef: string; headSha: string; baseSha: string; merged: boolean; mergedAt: string | null; mergeCommitSha: string | null }): Record<string, unknown> {
  return {
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    html_url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  };
}

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: unknown;
  isError: boolean;
}

function okResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false };
}

function errResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], structuredContent: { error: message }, isError: true };
}

function strArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function numArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): ToolResult {
  switch (name) {
    case 'create_repo': {
      const repoName = strArg(args, 'name');
      if (repoName === undefined) return errResult('create_repo: name is required');
      const description = strArg(args, 'description') ?? '';
      const isPrivate = args.private === true;
      const repo = store.createRepo(VIEWER_LOGIN, repoName, description, isPrivate);
      if (repo === null) return errResult(`create_repo: repository ${repoName} already exists`);
      return okResult(repoJson(repo));
    }
    case 'get_repo': {
      const owner = strArg(args, 'owner');
      const repoName = strArg(args, 'repo');
      if (owner === undefined || repoName === undefined) return errResult('get_repo: owner and repo are required');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return errResult(`get_repo: repository ${owner}/${repoName} not found`);
      return okResult(repoJson(repo));
    }
    case 'create_issue': {
      const owner = strArg(args, 'owner');
      const repoName = strArg(args, 'repo');
      const title = strArg(args, 'title');
      if (owner === undefined || repoName === undefined || title === undefined) return errResult('create_issue: owner, repo and title are required');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return errResult(`create_issue: repository ${owner}/${repoName} not found`);
      const issue = store.createIssue(repo, title, strArg(args, 'body') ?? '', []);
      return okResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const owner = strArg(args, 'owner');
      const repoName = strArg(args, 'repo');
      if (owner === undefined || repoName === undefined) return errResult('list_issues: owner and repo are required');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return errResult(`list_issues: repository ${owner}/${repoName} not found`);
      const state = (strArg(args, 'state') ?? 'open').toLowerCase();
      const list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      return okResult(list.map((issue) => issueJson(repo, issue)));
    }
    case 'create_pull_request': {
      const owner = strArg(args, 'owner');
      const repoName = strArg(args, 'repo');
      const title = strArg(args, 'title');
      const head = strArg(args, 'head');
      const base = strArg(args, 'base');
      if (owner === undefined || repoName === undefined || title === undefined || head === undefined || base === undefined) {
        return errResult('create_pull_request: owner, repo, title, head and base are required');
      }
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return errResult(`create_pull_request: repository ${owner}/${repoName} not found`);
      const pull = store.createPull(repo, title, strArg(args, 'body') ?? '', head, base);
      if (pull === null) return errResult('create_pull_request: the head branch does not exist or a pull request is already open');
      return okResult(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const owner = strArg(args, 'owner');
      const repoName = strArg(args, 'repo');
      const number = numArg(args, 'pull_number');
      if (owner === undefined || repoName === undefined || number === undefined) return errResult('merge_pull_request: owner, repo and pull_number are required');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return errResult(`merge_pull_request: repository ${owner}/${repoName} not found`);
      const pull = repo.pullsByNumber.get(number);
      if (pull === undefined) return errResult(`merge_pull_request: pull request #${number} not found`);
      const merged = repo.mergePull(pull);
      if (!merged.ok) return errResult(`merge_pull_request: ${merged.message}`);
      return okResult({ ...pullJson(repo, pull), sha: merged.sha, merged: true });
    }
    default:
      return errResult(`unknown tool ${name}`);
  }
}

const REQUIRED_ARGS: Record<string, string[]> = {
  create_repo: ['name'],
  get_repo: ['owner', 'repo'],
  create_issue: ['owner', 'repo', 'title'],
  list_issues: ['owner', 'repo'],
  create_pull_request: ['owner', 'repo', 'title', 'head', 'base'],
  merge_pull_request: ['owner', 'repo', 'pull_number'],
};

export interface McpAnswer {
  status: number;
  body: string;
}

/** Handle one POST /mcp body (already authenticated). Returns the HTTP answer. */
export function handleMcp(store: Store, rawBody: Buffer): McpAnswer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return {
      status: 400,
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      status: 400,
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }),
    };
  }
  const req = parsed as { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
  const id = req.id === undefined ? null : req.id;
  const method = req.method ?? '';
  // A notification (no id) is acknowledged with an empty 202.
  if (req.id === undefined) {
    return { status: 202, body: '' };
  }
  const result = (value: unknown): McpAnswer => ({ status: 200, body: JSON.stringify({ jsonrpc: '2.0', id, result: value }) });
  const error = (code: number, message: string): McpAnswer => ({ status: 200, body: JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) });
  switch (method) {
    case 'server/discover':
      return result({
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      });
    case 'initialize': {
      const params = (req.params ?? {}) as { protocolVersion?: string };
      const wanted = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      const negotiated = SUPPORTED_VERSIONS.includes(wanted) ? wanted : '2025-11-25';
      return result({
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case 'ping':
      return result({});
    case 'tools/list':
      return result({ tools: TOOLS });
    case 'tools/call': {
      const params = (req.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      const toolName = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS.find((t) => t.name === toolName);
      if (tool === undefined) return error(-32601, `Method not found: ${toolName}`);
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const missing = (REQUIRED_ARGS[toolName] ?? []).filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
      if (missing.length > 0) return error(-32602, `Invalid params: missing required argument(s): ${missing.join(', ')}`);
      return result(callTool(store, toolName, args));
    }
    default:
      return error(-32601, `Method not found: ${method}`);
  }
}
