// HTTP server: git smart HTTP, REST v3, GraphQL v4 and MCP on one process.
// Every REST reply is application/json with a non-empty X-GitHub-Request-Id.
// Auth: Bearer $MAKEFUN_SHOP_TOKEN (exact match). A repo under another owner is
// a 404, never a 403. No clock in any stored value.

import http from 'node:http';
import { parseCommit } from './gitcore.ts';
import { advertisementV0, advertisementV2, receivePack, uploadPackV0, uploadPackV2 } from './gitproto.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp, issueJson, pullJson, repoJson } from './mcp.ts';
import { FIXED_ISO, type Issue, type Repo, type Store } from './store.ts';
import { VIEWER_LOGIN } from './scenario.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function sendJson(res: http.ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-github-request-id': nextRequestId(),
    ...extra,
  });
  res.end(body);
}

function sendBuffer(res: http.ServerResponse, status: number, body: Buffer, contentType: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': nextRequestId(),
    ...extra,
  });
  res.end(body);
}

function notFound(res: http.ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(raw: Buffer): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    const value = JSON.parse(raw.toString('utf8')) as unknown;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return { ok: true, value: value as Record<string, unknown> };
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

function authorized(req: http.IncomingMessage): boolean {
  if (TOKEN === '') return true;
  const header = req.headers.authorization;
  if (header === undefined) return false;
  return header === `Bearer ${TOKEN}` || header === `token ${TOKEN}`;
}

function segments(pathname: string): string[] {
  return pathname.split('/').filter((s) => s !== '').map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
}

/** Cached per-issue JSON buffer; invalidated whenever the issue changes. */
function issueBuffer(repo: Repo, issue: Issue): Buffer {
  if (issue.jsonCache !== null) return issue.jsonCache;
  const buf = Buffer.from(JSON.stringify(issueJson(repo, issue)), 'utf8');
  issue.jsonCache = buf;
  return buf;
}

/** Cached per-repo JSON buffer; invalidated on PATCH. */
function repoBuffer(repo: Repo): Buffer {
  if (repo.jsonCache !== null) return repo.jsonCache;
  const buf = Buffer.from(JSON.stringify(repoJson(repo)), 'utf8');
  repo.jsonCache = buf;
  return buf;
}

function jsonList(buffers: Buffer[]): Buffer {
  return Buffer.concat([Buffer.from('[', 'utf8'), Buffer.concat(buffers.map((b, i) => (i === 0 ? b : Buffer.concat([Buffer.from(',', 'utf8'), b])))), Buffer.from(']', 'utf8')]);
}

function getRepoOr404(store: Store, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return store.getRepo(owner, name) ?? null;
}

export function createServer(store: Store): http.Server {
  const server = http.createServer((req, res) => {
    void handleRequest(store, req, res).catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
      else res.end();
    });
  });
  return server;
}

async function handleRequest(store: Store, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;
  const method = (req.method ?? 'GET').toUpperCase();

  // Health check (no auth).
  if (pathname === '/healthz' && method === 'GET') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // ---- Git smart HTTP -----------------------------------------------------
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
  if (gitMatch !== null) {
    const owner = gitMatch[1] as string;
    const repoName = gitMatch[2] as string;
    const action = gitMatch[3] as string;
    const repo = getRepoOr404(store, owner, repoName);
    if (repo === null) {
      notFound(res);
      return;
    }
    if (action === 'info/refs' && method === 'GET') {
      const service = url.searchParams.get('service') ?? '';
      if (service === 'git-upload-pack') {
        if (req.headers['git-protocol'] === 'version=2') {
          sendBuffer(res, 200, advertisementV2(repo), 'application/x-git-upload-pack-advertisement', { 'cache-control': 'no-cache' });
        } else {
          sendBuffer(res, 200, advertisementV0(repo, 'git-upload-pack'), 'application/x-git-upload-pack-advertisement', { 'cache-control': 'no-cache' });
        }
      } else if (service === 'git-receive-pack') {
        sendBuffer(res, 200, advertisementV0(repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement', { 'cache-control': 'no-cache' });
      } else {
        sendJson(res, 400, { message: 'unknown service' });
      }
      return;
    }
    if (action === 'git-upload-pack' && method === 'POST') {
      const body = await readBody(req);
      const out = req.headers['git-protocol'] === 'version=2' ? uploadPackV2(repo, body) : uploadPackV0(repo, body);
      sendBuffer(res, 200, out, 'application/x-git-upload-pack-result', { 'cache-control': 'no-cache' });
      return;
    }
    if (action === 'git-receive-pack' && method === 'POST') {
      const body = await readBody(req);
      const out = receivePack(repo, body);
      sendBuffer(res, 200, out, 'application/x-git-receive-pack-result', { 'cache-control': 'no-cache' });
      return;
    }
    notFound(res);
    return;
  }

  // ---- GraphQL ------------------------------------------------------------
  if (pathname === '/api/graphql' && method === 'POST') {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, { message: 'Invalid JSON' });
      return;
    }
    if (Array.isArray(parsed)) {
      const results = parsed.map((op) => {
        if (op === null || typeof op !== 'object') return { data: null, errors: [{ message: 'invalid operation' }] };
        const o = op as { query?: string; variables?: Record<string, unknown> };
        if (typeof o.query !== 'string') return { data: null, errors: [{ message: 'query is required' }] };
        return executeGraphQL(store, o.query, (o.variables ?? {}) as Record<string, unknown>);
      });
      sendJson(res, 200, results);
      return;
    }
    if (parsed === null || typeof parsed !== 'object') {
      sendJson(res, 400, { message: 'Invalid GraphQL request' });
      return;
    }
    const op = parsed as { query?: string; variables?: Record<string, unknown> };
    if (typeof op.query !== 'string') {
      sendJson(res, 400, { message: 'query is required' });
      return;
    }
    sendJson(res, 200, executeGraphQL(store, op.query, (op.variables ?? {}) as Record<string, unknown>));
    return;
  }

  // ---- MCP ----------------------------------------------------------------
  if (pathname === '/mcp' && method === 'POST') {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const raw = await readBody(req);
    const answer = handleMcp(store, raw);
    if (answer.body === '') {
      res.writeHead(answer.status, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    sendBuffer(res, answer.status, Buffer.from(answer.body, 'utf8'), 'application/json');
    return;
  }

  // ---- REST v3 ------------------------------------------------------------
  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    await handleRest(store, req, res, url, pathname, method);
    return;
  }

  notFound(res);
}

async function handleRest(store: Store, req: http.IncomingMessage, res: http.ServerResponse, url: URL, pathname: string, method: string): Promise<void> {
  const parts = segments(pathname.replace(/^\/api\/v3/, ''));

  // GET /api/v3/ — root, no auth required.
  if (parts.length === 0) {
    if (method !== 'GET') {
      notFound(res);
      return;
    }
    sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      user_url: '/api/v3/users/{user}',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      rate_limit_url: '/api/v3/rate_limit',
      meta_url: '/api/v3/meta',
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }

  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }

  // GET /api/v3/meta
  if (parts.length === 1 && parts[0] === 'meta' && method === 'GET') {
    sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: false, hooks: [], git: [], github_enterprise: false });
    return;
  }

  // GET /api/v3/user
  if (parts.length === 1 && parts[0] === 'user' && method === 'GET') {
    sendJson(res, 200, { login: VIEWER_LOGIN, id: 1000, type: 'User', name: VIEWER_LOGIN, email: `${VIEWER_LOGIN}@example.com`, html_url: `https://github.com/${VIEWER_LOGIN}` });
    return;
  }

  // /api/v3/user/repos
  if (parts.length === 2 && parts[0] === 'user' && parts[1] === 'repos') {
    if (method === 'GET') {
      const perPage = Math.max(1, Math.min(100, parseInt(url.searchParams.get('per_page') ?? '30', 10) || 30));
      const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
      const all = store.viewerRepos;
      const slice = all.slice((page - 1) * perPage, page * perPage);
      const extra: Record<string, string> = {};
      const totalPages = Math.max(1, Math.ceil(all.length / perPage));
      if (page < totalPages) {
        const host = req.headers.host ?? 'localhost';
        const nextUrl = `http://${host}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
        const lastUrl = `http://${host}/api/v3/user/repos?per_page=${perPage}&page=${totalPages}`;
        extra.link = `<${nextUrl}>; rel="next", <${lastUrl}>; rel="last"`;
      }
      sendBuffer(res, 200, jsonList(slice.map((repo) => repoBuffer(repo))), 'application/json', extra);
      return;
    }
    if (method === 'POST') {
      const raw = await readBody(req);
      const parsed = parseJsonBody(raw);
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Invalid JSON' });
        return;
      }
      const name = typeof parsed.value.name === 'string' ? parsed.value.name : '';
      if (name === '') {
        sendJson(res, 422, { message: 'name is required' });
        return;
      }
      const description = typeof parsed.value.description === 'string' ? parsed.value.description : '';
      const isPrivate = parsed.value.private === true;
      const repo = store.createRepo(VIEWER_LOGIN, name, description, isPrivate);
      if (repo === null) {
        sendJson(res, 422, { message: 'Repository already exists' });
        return;
      }
      sendBuffer(res, 201, repoBuffer(repo), 'application/json');
      return;
    }
    notFound(res);
    return;
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (parts.length >= 3 && parts[0] === 'repos') {
    const owner = parts[1] as string;
    const repoName = parts[2] as string;
    const repo = getRepoOr404(store, owner, repoName);
    if (repo === null) {
      notFound(res);
      return;
    }
    const rest = parts.slice(3);
    await handleRepoRoutes(store, repo, req, res, url, method, rest);
    return;
  }

  notFound(res);
}

async function handleRepoRoutes(store: Store, repo: Repo, req: http.IncomingMessage, res: http.ServerResponse, url: URL, method: string, rest: string[]): Promise<void> {
  // GET/PATCH/DELETE /repos/{o}/{r}
  if (rest.length === 0) {
    if (method === 'GET') {
      sendBuffer(res, 200, repoBuffer(repo), 'application/json');
      return;
    }
    if (method === 'PATCH') {
      const raw = await readBody(req);
      const parsed = parseJsonBody(raw);
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Invalid JSON' });
        return;
      }
      if (typeof parsed.value.description === 'string') repo.description = parsed.value.description;
      repo.jsonCache = null;
      sendBuffer(res, 200, repoBuffer(repo), 'application/json');
      return;
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo.owner, repo.name);
      res.writeHead(204, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    notFound(res);
    return;
  }

  // /git/refs
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const raw = await readBody(req);
      const parsed = parseJsonBody(raw);
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Invalid JSON' });
        return;
      }
      const ref = typeof parsed.value.ref === 'string' ? parsed.value.ref : '';
      const sha = typeof parsed.value.sha === 'string' ? parsed.value.sha : '';
      if (ref === '' || sha === '') {
        sendJson(res, 422, { message: 'ref and sha are required' });
        return;
      }
      if (repo.refs.has(ref)) {
        sendJson(res, 422, { message: 'Reference already exists' });
        return;
      }
      if (repo.lookup(sha) === undefined) {
        sendJson(res, 422, { message: 'Invalid SHA' });
        return;
      }
      repo.setRef(ref, sha);
      sendJson(res, 201, { ref, object: { sha, type: 'commit', url: `/api/v3/repos/${repo.fullName}/git/commits/${sha}` } });
      return;
    }
    if (method === 'GET' && rest.length >= 4 && rest[2] === 'heads') {
      const branch = rest.slice(3).join('/');
      const sha = repo.resolveRef(branch);
      if (sha === undefined) {
        notFound(res);
        return;
      }
      sendJson(res, 200, { ref: `refs/heads/${branch}`, object: { sha, type: 'commit', url: `/api/v3/repos/${repo.fullName}/git/commits/${sha}` } });
      return;
    }
    notFound(res);
    return;
  }

  // /branches
  if (rest[0] === 'branches') {
    if (method === 'GET' && rest.length === 1) {
      const list = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }));
      list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      sendJson(res, 200, list);
      return;
    }
    if (method === 'GET' && rest.length === 2) {
      const sha = repo.resolveRef(rest[1] as string);
      if (sha === undefined) {
        notFound(res);
        return;
      }
      sendJson(res, 200, { name: rest[1], commit: { sha }, protected: false });
      return;
    }
    notFound(res);
    return;
  }

  // /commits
  if (rest[0] === 'commits' && method === 'GET' && rest.length === 1) {
    const shaParam = url.searchParams.get('sha');
    const tip = shaParam !== null && shaParam !== '' ? repo.resolveRef(shaParam) : repo.defaultTip();
    if (tip === undefined) {
      sendJson(res, 200, []);
      return;
    }
    const list = repo.commitsFrom(shaParam !== null && shaParam !== '' ? shaParam : repo.defaultBranch).map((sha) => {
      const obj = repo.objects.get(sha);
      const message = obj !== undefined && obj.type === 'commit' ? parseCommit(obj.data).message : '';
      return {
        sha,
        commit: {
          message,
          author: { name: VIEWER_LOGIN, email: `${VIEWER_LOGIN}@example.com`, date: FIXED_ISO },
          committer: { name: VIEWER_LOGIN, email: `${VIEWER_LOGIN}@example.com`, date: FIXED_ISO },
        },
        parents: obj !== undefined && obj.type === 'commit' ? parseCommit(obj.data).parents.map((p) => ({ sha: p })) : [],
      };
    });
    sendJson(res, 200, list);
    return;
  }

  // /labels
  if (rest[0] === 'labels') {
    if (method === 'POST' && rest.length === 1) {
      const raw = await readBody(req);
      const parsed = parseJsonBody(raw);
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Invalid JSON' });
        return;
      }
      const name = typeof parsed.value.name === 'string' ? parsed.value.name : '';
      const color = typeof parsed.value.color === 'string' ? parsed.value.color : 'ededed';
      if (name === '') {
        sendJson(res, 422, { message: 'name is required' });
        return;
      }
      const label = { name, color };
      repo.labels.set(name, label);
      sendJson(res, 201, { name, color, id: repo.labels.size, url: `/api/v3/repos/${repo.fullName}/labels/${encodeURIComponent(name)}` });
      return;
    }
    if (method === 'GET' && rest.length === 1) {
      sendJson(res, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
      return;
    }
    notFound(res);
    return;
  }

  // /contents/{path...}
  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'GET') {
      const ref = url.searchParams.get('ref') ?? repo.defaultBranch;
      const file = repo.readFileAt(ref, path);
      if (file !== null) {
        const name = path.split('/').pop() ?? path;
        sendJson(res, 200, {
          type: 'file',
          encoding: 'base64',
          size: file.data.length,
          name,
          path,
          content: file.data.toString('base64'),
          sha: file.oid,
        });
        return;
      }
      const dir = repo.listDirAt(ref, path);
      if (dir !== null) {
        sendJson(res, 200, dir.map((entry) => ({
          type: entry.type,
          name: entry.name,
          path: entry.path,
          sha: entry.sha,
          size: entry.type === 'file' ? (repo.objects.get(entry.sha)?.data.length ?? 0) : 0,
        })));
        return;
      }
      notFound(res);
      return;
    }
    if (method === 'PUT') {
      const raw = await readBody(req);
      const parsed = parseJsonBody(raw);
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Invalid JSON' });
        return;
      }
      const content = typeof parsed.value.content === 'string' ? Buffer.from(parsed.value.content, 'base64') : null;
      const message = typeof parsed.value.message === 'string' ? parsed.value.message : 'Update file';
      const branch = typeof parsed.value.branch === 'string' ? parsed.value.branch : repo.defaultBranch;
      const sha = typeof parsed.value.sha === 'string' ? parsed.value.sha : undefined;
      if (content === null) {
        sendJson(res, 422, { message: 'content is required' });
        return;
      }
      const result = repo.commitFile({ branch, path, content, message, expectedSha: sha });
      if (!result.ok) {
        sendJson(res, result.status, { message: result.message });
        return;
      }
      sendJson(res, result.created ? 201 : 200, {
        content: { name: path.split('/').pop() ?? path, path, sha: result.contentSha, size: content.length, encoding: 'base64' },
        commit: { sha: result.commitSha, message },
      });
      return;
    }
    if (method === 'DELETE') {
      const raw = await readBody(req);
      const parsed = parseJsonBody(raw);
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Invalid JSON' });
        return;
      }
      const message = typeof parsed.value.message === 'string' ? parsed.value.message : 'Delete file';
      const branch = typeof parsed.value.branch === 'string' ? parsed.value.branch : repo.defaultBranch;
      const sha = typeof parsed.value.sha === 'string' ? parsed.value.sha : undefined;
      const result = repo.deleteFile({ branch, path, message, expectedSha: sha });
      if (!result.ok) {
        sendJson(res, result.status, { message: result.message });
        return;
      }
      sendJson(res, 200, { commit: { sha: result.commitSha, message } });
      return;
    }
    notFound(res);
    return;
  }

  // /issues...
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = (url.searchParams.get('state') ?? 'open').toLowerCase();
        const direction = (url.searchParams.get('direction') ?? 'desc').toLowerCase();
        let list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
        list = [...list].sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        sendBuffer(res, 200, jsonList(list.map((issue) => issueBuffer(repo, issue))), 'application/json');
        return;
      }
      if (method === 'POST') {
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'Invalid JSON' });
          return;
        }
        const title = typeof parsed.value.title === 'string' ? parsed.value.title : '';
        const body = typeof parsed.value.body === 'string' ? parsed.value.body : '';
        if (title === '') {
          sendJson(res, 422, { message: 'title is required' });
          return;
        }
        const labelNames = Array.isArray(parsed.value.labels) ? parsed.value.labels.filter((l): l is string => typeof l === 'string') : [];
        const labels: Array<{ name: string; color: string }> = [];
        for (const labelName of labelNames) {
          const label = repo.labels.get(labelName);
          if (label === undefined) {
            sendJson(res, 422, { message: `Label does not exist: ${labelName}` });
            return;
          }
          labels.push(label);
        }
        const issue = store.createIssue(repo, title, body, labels);
        sendBuffer(res, 201, issueBuffer(repo, issue), 'application/json');
        return;
      }
      notFound(res);
      return;
    }
    const number = parseInt(rest[1] as string, 10);
    const issue = Number.isInteger(number) ? repo.issuesByNumber.get(number) : undefined;
    if (issue === undefined) {
      notFound(res);
      return;
    }
    if (rest.length === 2) {
      if (method === 'GET') {
        sendBuffer(res, 200, issueBuffer(repo, issue), 'application/json');
        return;
      }
      if (method === 'PATCH') {
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'Invalid JSON' });
          return;
        }
        if (typeof parsed.value.title === 'string') issue.title = parsed.value.title;
        if (typeof parsed.value.body === 'string') issue.body = parsed.value.body;
        if (parsed.value.state === 'open' || parsed.value.state === 'closed') issue.state = parsed.value.state;
        issue.jsonCache = null;
        sendBuffer(res, 200, issueBuffer(repo, issue), 'application/json');
        return;
      }
      notFound(res);
      return;
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (method === 'GET') {
        sendJson(res, 200, issue.comments.map((comment) => ({
          id: comment.id,
          body: comment.body,
          user: { login: repo.owner, id: 1000 },
          created_at: FIXED_ISO,
          updated_at: FIXED_ISO,
        })));
        return;
      }
      if (method === 'POST') {
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'Invalid JSON' });
          return;
        }
        const body = typeof parsed.value.body === 'string' ? parsed.value.body : '';
        const id = store.commentIdSeq;
        store.commentIdSeq += 1;
        issue.comments.push({ id, body });
        issue.jsonCache = null;
        sendJson(res, 201, { id, body, user: { login: repo.owner, id: 1000 }, created_at: FIXED_ISO, updated_at: FIXED_ISO });
        return;
      }
      notFound(res);
      return;
    }
    notFound(res);
    return;
  }

  // /pulls...
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = (url.searchParams.get('state') ?? 'open').toLowerCase();
        const list = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
        sendJson(res, 200, list.map((pull) => pullJson(repo, pull)));
        return;
      }
      if (method === 'POST') {
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'Invalid JSON' });
          return;
        }
        const title = typeof parsed.value.title === 'string' ? parsed.value.title : '';
        const body = typeof parsed.value.body === 'string' ? parsed.value.body : '';
        const headRaw = typeof parsed.value.head === 'string' ? parsed.value.head : '';
        const baseRaw = typeof parsed.value.base === 'string' ? parsed.value.base : '';
        const head = headRaw.includes(':') ? (headRaw.split(':').pop() as string) : headRaw;
        const base = baseRaw.includes(':') ? (baseRaw.split(':').pop() as string) : baseRaw;
        if (title === '' || head === '' || base === '') {
          sendJson(res, 422, { message: 'title, head and base are required' });
          return;
        }
        const pull = store.createPull(repo, title, body, head, base);
        if (pull === null) {
          sendJson(res, 422, { message: 'A pull request is already open for this head and base, or the head branch does not exist' });
          return;
        }
        sendJson(res, 201, pullJson(repo, pull));
        return;
      }
      notFound(res);
      return;
    }
    const number = parseInt(rest[1] as string, 10);
    const pull = Number.isInteger(number) ? repo.pullsByNumber.get(number) : undefined;
    if (pull === undefined) {
      notFound(res);
      return;
    }
    if (rest.length === 2 && method === 'GET') {
      sendJson(res, 200, pullJson(repo, pull));
      return;
    }
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      sendJson(res, 200, repo.pullFiles(pull));
      return;
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      const raw = await readBody(req);
      parseJsonBody(raw); // Body is optional; ignore malformed content.
      if (pull.merged && pull.mergeCommitSha !== null) {
        sendJson(res, 200, { sha: pull.mergeCommitSha, merged: true, message: 'Pull Request successfully merged' });
        return;
      }
      const merged = repo.mergePull(pull);
      if (!merged.ok) {
        sendJson(res, merged.status, { message: merged.message });
        return;
      }
      sendJson(res, 200, { sha: merged.sha, merged: true, message: 'Pull Request successfully merged' });
      return;
    }
    notFound(res);
    return;
  }

  notFound(res);
}
