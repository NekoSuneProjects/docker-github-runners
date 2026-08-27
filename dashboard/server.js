const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const PORT = Number(process.env.PORT || 8080);
const GITHUB_ORG = process.env.GITHUB_ORG || '';
const GITHUB_TOKEN = process.env.GITHUB_DASHBOARD_TOKEN || process.env.ACCESS_TOKEN || '';
const DASHBOARD_REPOS = (process.env.DASHBOARD_REPOS || '').split(',').map(v => v.trim()).filter(Boolean);
const MAX_REPOS = Math.max(1, Math.min(Number(process.env.DASHBOARD_MAX_REPOS || 12), 50));
const REFRESH_SECONDS = Math.max(5, Math.min(Number(process.env.DASHBOARD_REFRESH_SECONDS || 10), 120));
const LOGIN_USER = process.env.DASHBOARD_USERNAME || '';
const LOGIN_PASS = process.env.DASHBOARD_PASSWORD || '';
const LOGIN_PASS_SHA256 = (process.env.DASHBOARD_PASSWORD_SHA256 || '').trim().toLowerCase();
const SESSION_SECRET = process.env.DASHBOARD_SESSION_SECRET || '';
const SESSION_TTL_HOURS = Math.max(1, Math.min(Number(process.env.DASHBOARD_SESSION_TTL_HOURS || 12), 168));
const COOKIE_SECURE = /^(1|true|yes|on)$/i.test(process.env.DASHBOARD_COOKIE_SECURE || 'false');
const AUTH_REQUIRED = !/^(0|false|no|off)$/i.test(process.env.DASHBOARD_AUTH_REQUIRED || 'true');
const DIAG_DIR = process.env.RUNNER_DIAG_DIR || '/runner-diag';
const CONSOLE_DIR = process.env.RUNNER_CONSOLE_DIR || '/runner-console';
const PUBLIC_DIR = path.join(__dirname, 'public');
const API_VERSION = '2022-11-28';
const SESSION_COOKIE = 'neko_runner_session';
const cache = new Map();
const loginAttempts = new Map();
let shuttingDown = false;

const passwordConfigured = Boolean(LOGIN_PASS || LOGIN_PASS_SHA256);
const authConfigured = Boolean(LOGIN_USER && passwordConfigured);

if (AUTH_REQUIRED && !authConfigured) {
  console.error('ERROR: Dashboard authentication is required but credentials are incomplete.');
  console.error('Set DASHBOARD_USERNAME and either DASHBOARD_PASSWORD or DASHBOARD_PASSWORD_SHA256.');
  process.exit(1);
}

if (authConfigured && SESSION_SECRET.length < 32) {
  console.error('ERROR: DASHBOARD_SESSION_SECRET must be at least 32 characters when authentication is enabled.');
  process.exit(1);
}

function securityHeaders() {
  return {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  };
}

function json(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...securityHeaders(),
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

function text(res, status, body, type = 'text/plain; charset=utf-8', extraHeaders = {}) {
  res.writeHead(status, {
    ...securityHeaders(),
    'content-type': type,
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function redirect(res, location, extraHeaders = {}) {
  res.writeHead(303, {
    ...securityHeaders(),
    location,
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end();
}

function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function passwordMatches(candidate) {
  if (LOGIN_PASS_SHA256) {
    const digest = crypto.createHash('sha256').update(candidate, 'utf8').digest('hex');
    return constantTimeEqual(digest, LOGIN_PASS_SHA256);
  }
  return constantTimeEqual(candidate, LOGIN_PASS);
}

function parseCookies(req) {
  const result = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try {
      result[key] = decodeURIComponent(value);
    } catch {
      result[key] = value;
    }
  }
  return result;
}

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}

function makeSession(username) {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    u: username,
    iat: now,
    exp: now + SESSION_TTL_HOURS * 60 * 60,
    n: crypto.randomBytes(12).toString('hex'),
  })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function readSession(req) {
  if (!authConfigured) return { u: 'local', exp: Number.MAX_SAFE_INTEGER };
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!constantTimeEqual(signature, sign(payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (data.u !== LOGIN_USER) return null;
    if (!Number.isFinite(data.exp) || data.exp <= Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}

function sessionCookie(token) {
  const maxAge = SESSION_TTL_HOURS * 60 * 60;
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAge}`,
    COOKIE_SECURE ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

function clearSessionCookie() {
  return [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    COOKIE_SECURE ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

function clientIp(req) {
  return String(req.socket.remoteAddress || 'unknown');
}

function loginRateLimited(req) {
  const key = clientIp(req);
  const now = Date.now();
  const item = loginAttempts.get(key);
  if (!item || item.resetAt <= now) {
    loginAttempts.delete(key);
    return false;
  }
  return item.count >= 5;
}

function recordLoginFailure(req) {
  const key = clientIp(req);
  const now = Date.now();
  const current = loginAttempts.get(key);
  if (!current || current.resetAt <= now) {
    loginAttempts.set(key, { count: 1, resetAt: now + 15 * 60 * 1000 });
  } else {
    current.count += 1;
  }
}

function clearLoginFailures(req) {
  loginAttempts.delete(clientIp(req));
}

async function readBody(req, maxBytes = 16 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const err = new Error('Request body too large');
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function cached(key, ttlMs, fn) {
  const now = Date.now();
  const item = cache.get(key);
  if (item && item.expires > now) return item.value;
  const value = await fn();
  cache.set(key, { expires: now + ttlMs, value });
  return value;
}

async function githubFetch(apiPath, options = {}) {
  const headers = {
    Accept: options.accept || 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': 'neko-runner-dashboard/1.0',
  };
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  const response = await fetch(`https://api.github.com${apiPath}`, {
    method: options.method || 'GET',
    headers,
    redirect: 'follow',
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const err = new Error(`GitHub API ${response.status}: ${body.slice(0, 300) || response.statusText}`);
    err.status = response.status;
    throw err;
  }
  return options.buffer ? Buffer.from(await response.arrayBuffer()) : response.json();
}

async function mapLimit(items, limit, fn) {
  const result = new Array(items.length);
  let index = 0;
  async function worker() {
    while (true) {
      const current = index++;
      if (current >= items.length) return;
      result[current] = await fn(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, worker));
  return result;
}

async function getRepos() {
  if (!GITHUB_ORG) throw new Error('GITHUB_ORG is not configured');
  if (DASHBOARD_REPOS.length) {
    return DASHBOARD_REPOS.map(name => name.includes('/') ? name.split('/').pop() : name);
  }
  return cached('repos', 300000, async () => {
    const data = await githubFetch(`/orgs/${encodeURIComponent(GITHUB_ORG)}/repos?per_page=100&type=all&sort=pushed&direction=desc`);
    return data.slice(0, MAX_REPOS).map(repo => repo.name);
  });
}

function normalizeRun(run, repo) {
  return {
    id: run.id,
    repo,
    name: run.name || 'Workflow',
    display_title: run.display_title || run.name || 'Workflow run',
    run_number: run.run_number,
    event: run.event,
    status: run.status,
    conclusion: run.conclusion,
    branch: run.head_branch,
    sha: run.head_sha,
    actor: run.actor?.login || 'unknown',
    created_at: run.created_at,
    updated_at: run.updated_at,
    html_url: run.html_url,
  };
}

async function getOverview() {
  return cached('overview', REFRESH_SECONDS * 1000, async () => {
    const repos = await getRepos();
    let runners = [];
    let runnersError = null;
    try {
      const response = await githubFetch(`/orgs/${encodeURIComponent(GITHUB_ORG)}/actions/runners?per_page=100`);
      runners = (response.runners || []).map(runner => ({
        id: runner.id,
        name: runner.name,
        os: runner.os,
        status: runner.status,
        busy: runner.busy,
        labels: (runner.labels || []).map(label => label.name),
      }));
    } catch (err) {
      runnersError = err.message;
    }

    const repoRuns = await mapLimit(repos, 4, async repo => {
      try {
        const data = await githubFetch(`/repos/${encodeURIComponent(GITHUB_ORG)}/${encodeURIComponent(repo)}/actions/runs?per_page=5`);
        return (data.workflow_runs || []).map(run => normalizeRun(run, repo));
      } catch (err) {
        return [{ repo, api_error: err.message }];
      }
    });

    const errors = repoRuns.flat().filter(item => item.api_error);
    const runs = repoRuns.flat().filter(item => !item.api_error)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 60);

    const activeRuns = runs.filter(run => run.status === 'in_progress' || run.status === 'queued');
    const activeJobs = [];
    await mapLimit(activeRuns.slice(0, 10), 3, async run => {
      try {
        const data = await githubFetch(`/repos/${encodeURIComponent(GITHUB_ORG)}/${encodeURIComponent(run.repo)}/actions/runs/${run.id}/jobs?per_page=100`);
        for (const job of data.jobs || []) {
          if (job.status === 'in_progress' || job.status === 'queued') {
            activeJobs.push({
              id: job.id,
              run_id: run.id,
              repo: run.repo,
              name: job.name,
              status: job.status,
              conclusion: job.conclusion,
              runner_name: job.runner_name,
              runner_group_name: job.runner_group_name,
              started_at: job.started_at,
              html_url: job.html_url,
            });
          }
        }
      } catch {
        // Overview still works when job detail is unavailable.
      }
    });

    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const failed24h = runs.filter(run => run.conclusion === 'failure' && new Date(run.updated_at).getTime() >= oneDayAgo).length;
    return {
      org: GITHUB_ORG,
      generated_at: new Date().toISOString(),
      refresh_seconds: REFRESH_SECONDS,
      runners,
      runners_error: runnersError,
      repos,
      repo_errors: errors,
      runs,
      active_jobs: activeJobs,
      summary: {
        runners_total: runners.length,
        runners_online: runners.filter(r => r.status === 'online').length,
        runners_busy: runners.filter(r => r.busy).length,
        active_runs: activeRuns.length,
        failed_24h: failed24h,
      },
    };
  });
}

async function getRunDetail(repo, runId) {
  const safeRepo = encodeURIComponent(repo);
  const run = await githubFetch(`/repos/${encodeURIComponent(GITHUB_ORG)}/${safeRepo}/actions/runs/${encodeURIComponent(runId)}`);
  const jobs = await githubFetch(`/repos/${encodeURIComponent(GITHUB_ORG)}/${safeRepo}/actions/runs/${encodeURIComponent(runId)}/jobs?per_page=100`);
  return {
    run: normalizeRun(run, repo),
    jobs: (jobs.jobs || []).map(job => ({
      id: job.id,
      name: job.name,
      status: job.status,
      conclusion: job.conclusion,
      started_at: job.started_at,
      completed_at: job.completed_at,
      runner_name: job.runner_name,
      runner_group_name: job.runner_group_name,
      html_url: job.html_url,
      steps: (job.steps || []).map(step => ({
        number: step.number,
        name: step.name,
        status: step.status,
        conclusion: step.conclusion,
        started_at: step.started_at,
        completed_at: step.completed_at,
      })),
    })),
  };
}

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, '');
}

async function getRunLogs(repo, runId) {
  const buffer = await githubFetch(
    `/repos/${encodeURIComponent(GITHUB_ORG)}/${encodeURIComponent(repo)}/actions/runs/${encodeURIComponent(runId)}/logs`,
    { buffer: true, accept: 'application/vnd.github+json' }
  );
  const tmp = path.join(os.tmpdir(), `neko-run-${process.pid}-${Date.now()}.zip`);
  await fs.promises.writeFile(tmp, buffer);
  try {
    const output = await new Promise((resolve, reject) => {
      execFile('unzip', ['-p', tmp], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve(stdout);
      });
    });
    const cleaned = stripAnsi(String(output));
    return cleaned.length > 8 * 1024 * 1024 ? cleaned.slice(-8 * 1024 * 1024) : cleaned;
  } finally {
    fs.promises.unlink(tmp).catch(() => {});
  }
}

function safeLogFile(baseDir, file) {
  const base = path.resolve(baseDir);
  const target = path.resolve(base, path.basename(file));
  if (!target.startsWith(base + path.sep)) throw new Error('Invalid log file');
  return target;
}

async function listLocalLogs() {
  const sources = [
    ['diag', DIAG_DIR],
    ['console', CONSOLE_DIR],
  ];
  const result = [];
  for (const [source, dir] of sources) {
    try {
      const files = await fs.promises.readdir(dir);
      for (const file of files) {
        const full = safeLogFile(dir, file);
        const stat = await fs.promises.stat(full).catch(() => null);
        if (stat?.isFile()) {
          result.push({ source, file, size: stat.size, modified_at: stat.mtime.toISOString() });
        }
      }
    } catch {
      // A missing local log volume should not break the dashboard.
    }
  }
  return result.sort((a, b) => new Date(b.modified_at) - new Date(a.modified_at)).slice(0, 100);
}

async function tailFile(filePath, maxBytes = 1024 * 1024) {
  const stat = await fs.promises.stat(filePath);
  const start = Math.max(0, stat.size - maxBytes);
  const length = stat.size - start;
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return stripAnsi(buffer.toString('utf8'));
  } finally {
    await handle.close();
  }
}

function serveStatic(reqPath, res) {
  const requested = reqPath === '/' ? 'index.html' : reqPath.slice(1);
  const target = path.resolve(PUBLIC_DIR, requested);
  if (!target.startsWith(PUBLIC_DIR + path.sep) && target !== path.join(PUBLIC_DIR, 'index.html')) {
    return text(res, 403, 'Forbidden');
  }
  fs.readFile(target, (err, data) => {
    if (err) return text(res, 404, 'Not found');
    const ext = path.extname(target);
    const type = ext === '.html' ? 'text/html; charset=utf-8'
      : ext === '.css' ? 'text/css; charset=utf-8'
      : ext === '.js' ? 'application/javascript; charset=utf-8'
      : 'application/octet-stream';
    res.writeHead(200, { ...securityHeaders(), 'content-type': type, 'cache-control': 'no-cache' });
    res.end(data);
  });
}

function serveLogin(res, error = '') {
  fs.readFile(path.join(PUBLIC_DIR, 'login.html'), 'utf8', (err, template) => {
    if (err) return text(res, 500, 'Login page is unavailable');
    const safeError = error
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
    const body = template.replace('{{ERROR}}', safeError);
    return text(res, 200, body, 'text/html; charset=utf-8');
  });
}

const server = http.createServer(async (req, res) => {
  if (shuttingDown) {
    return text(res, 503, 'Dashboard is shutting down', 'text/plain; charset=utf-8', { connection: 'close' });
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    if (url.pathname === '/healthz') {
      return json(res, 200, { ok: true });
    }

    if (url.pathname === '/login' && req.method === 'GET') {
      if (readSession(req)) return redirect(res, '/');
      return serveLogin(res, '');
    }

    if (url.pathname === '/login' && req.method === 'POST') {
      if (!authConfigured) return redirect(res, '/');
      if (loginRateLimited(req)) {
        return serveLogin(res, 'Too many failed login attempts. Try again in about 15 minutes.');
      }
      const form = new URLSearchParams(await readBody(req));
      const username = String(form.get('username') || '');
      const password = String(form.get('password') || '');
      const usernameOk = constantTimeEqual(username, LOGIN_USER);
      const passwordOk = passwordMatches(password);
      if (!usernameOk || !passwordOk) {
        recordLoginFailure(req);
        return serveLogin(res, 'Invalid username or password.');
      }
      clearLoginFailures(req);
      return redirect(res, '/', { 'set-cookie': sessionCookie(makeSession(LOGIN_USER)) });
    }

    if (url.pathname === '/logout') {
      return redirect(res, '/login', { 'set-cookie': clearSessionCookie() });
    }

    const session = readSession(req);
    if (!session) {
      if (url.pathname.startsWith('/api/')) {
        return json(res, 401, { error: 'Authentication required' });
      }
      return redirect(res, '/login');
    }

    if (url.pathname === '/api/session') {
      return json(res, 200, { authenticated: true, username: session.u, expires_at: Number.isFinite(session.exp) ? new Date(session.exp * 1000).toISOString() : null });
    }
    if (url.pathname === '/api/health') {
      return json(res, 200, { ok: true, org: GITHUB_ORG, token_configured: Boolean(GITHUB_TOKEN), refresh_seconds: REFRESH_SECONDS });
    }
    if (url.pathname === '/api/overview') {
      return json(res, 200, await getOverview());
    }
    if (url.pathname === '/api/run') {
      const repo = url.searchParams.get('repo');
      const id = url.searchParams.get('id');
      if (!repo || !id) return json(res, 400, { error: 'repo and id are required' });
      return json(res, 200, await getRunDetail(repo, id));
    }
    if (url.pathname === '/api/run-logs') {
      const repo = url.searchParams.get('repo');
      const id = url.searchParams.get('id');
      if (!repo || !id) return json(res, 400, { error: 'repo and id are required' });
      return text(res, 200, await getRunLogs(repo, id));
    }
    if (url.pathname === '/api/local-files') {
      return json(res, 200, { files: await listLocalLogs() });
    }
    if (url.pathname === '/api/local-log') {
      const source = url.searchParams.get('source');
      const file = url.searchParams.get('file');
      if (!file || !['diag', 'console'].includes(source)) return json(res, 400, { error: 'valid source and file are required' });
      const base = source === 'diag' ? DIAG_DIR : CONSOLE_DIR;
      return text(res, 200, await tailFile(safeLogFile(base, file)));
    }
    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found' });
    return serveStatic(url.pathname, res);
  } catch (err) {
    console.error(err);
    const status = Number(err.status) || 500;
    return json(res, status, { error: err.message || 'Internal server error' });
  }
});

server.keepAliveTimeout = 5000;
server.headersTimeout = 10000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Neko Runner Dashboard listening on :${PORT}`);
  console.log(`Organization: ${GITHUB_ORG || '(not configured)'}`);
  console.log(`Tracked repos: ${DASHBOARD_REPOS.length ? DASHBOARD_REPOS.join(', ') : `auto (max ${MAX_REPOS})`}`);
  console.log(`Authentication: ${authConfigured ? 'enabled' : 'disabled by explicit configuration'}`);
  console.log(`Session lifetime: ${SESSION_TTL_HOURS} hour(s)`);
  if (COOKIE_SECURE) console.log('Secure session cookies: enabled');
  if (!GITHUB_TOKEN) console.warn('WARNING: No GitHub token configured. API rate limits and private data access will be limited.');
});

function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received: stopping Neko Runner Dashboard...`);

  const forceTimer = setTimeout(() => {
    console.warn('Graceful shutdown timed out; closing remaining connections.');
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    process.exit(0);
  }, 8000);
  forceTimer.unref();

  if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
  server.close(err => {
    clearTimeout(forceTimer);
    if (err) {
      console.error('Dashboard shutdown error:', err);
      process.exit(1);
    }
    console.log('Neko Runner Dashboard stopped cleanly.');
    process.exit(0);
  });
}

process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.once('SIGINT', () => gracefulShutdown('SIGINT'));
process.once('SIGHUP', () => gracefulShutdown('SIGHUP'));
process.on('uncaughtException', err => {
  console.error('Uncaught exception:', err);
  gracefulShutdown('uncaughtException');
});
process.on('unhandledRejection', err => {
  console.error('Unhandled rejection:', err);
});
