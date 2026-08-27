const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 8080);
const GITHUB_ORG = process.env.GITHUB_ORG || '';
const GITHUB_TOKEN = process.env.GITHUB_DASHBOARD_TOKEN || process.env.ACCESS_TOKEN || '';
const DASHBOARD_REPOS = (process.env.DASHBOARD_REPOS || '').split(',').map(v => v.trim()).filter(Boolean);
const MAX_REPOS = Math.max(1, Math.min(Number(process.env.DASHBOARD_MAX_REPOS || 12), 50));
const REFRESH_SECONDS = Math.max(5, Math.min(Number(process.env.DASHBOARD_REFRESH_SECONDS || 10), 120));

const LOGIN_USER = process.env.DASHBOARD_USERNAME || '';
const LOGIN_PASS = process.env.DASHBOARD_PASSWORD || '';
const LOGIN_PASS_SHA256 = String(process.env.DASHBOARD_PASSWORD_SHA256 || '').trim().toLowerCase();
const SESSION_SECRET = process.env.DASHBOARD_SESSION_SECRET || '';
const SESSION_TTL_HOURS = Math.max(1, Math.min(Number(process.env.DASHBOARD_SESSION_TTL_HOURS || 12), 168));
const COOKIE_SECURE = /^(1|true|yes|on)$/i.test(process.env.DASHBOARD_COOKIE_SECURE || 'false');
const AUTH_REQUIRED = !/^(0|false|no|off)$/i.test(process.env.DASHBOARD_AUTH_REQUIRED || 'true');

const NODE_SHARED_SECRET = process.env.DASHBOARD_NODE_SHARED_SECRET || '';
const NODE_OFFLINE_SECONDS = Math.max(15, Math.min(Number(process.env.DASHBOARD_NODE_OFFLINE_SECONDS || 45), 3600));
const NODE_MAX_LOG_BYTES = Math.max(16384, Math.min(Number(process.env.DASHBOARD_NODE_MAX_LOG_BYTES || 262144), 1048576));
const NODE_MAX_BODY_BYTES = Math.max(65536, Math.min(Number(process.env.DASHBOARD_NODE_MAX_BODY_BYTES || 1048576), 4 * 1024 * 1024));
const LOG_RETENTION_DAYS = Math.max(1, Math.min(Number(process.env.DASHBOARD_LOG_RETENTION_DAYS || 30), 365));
const LOG_MAX_ROWS_PER_NODE = Math.max(20, Math.min(Number(process.env.DASHBOARD_LOG_MAX_ROWS_PER_NODE || 500), 5000));
const DB_FILE = process.env.DASHBOARD_DB_FILE || '/data/dashboard.sqlite';

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
  process.exit(1);
}
if (authConfigured && SESSION_SECRET.length < 32) {
  console.error('ERROR: DASHBOARD_SESSION_SECRET must be at least 32 characters.');
  process.exit(1);
}
if (NODE_SHARED_SECRET && NODE_SHARED_SECRET.length < 32) {
  console.error('ERROR: DASHBOARD_NODE_SHARED_SECRET must be at least 32 characters.');
  process.exit(1);
}

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA synchronous=NORMAL;
  PRAGMA foreign_keys=ON;
  CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    location TEXT DEFAULT '',
    runner_name TEXT DEFAULT '',
    labels_json TEXT DEFAULT '[]',
    agent_version TEXT DEFAULT '',
    hostname TEXT DEFAULT '',
    platform TEXT DEFAULT '',
    arch TEXT DEFAULT '',
    kernel TEXT DEFAULT '',
    uptime_seconds REAL DEFAULT 0,
    metrics_json TEXT DEFAULT '{}',
    storage_json TEXT DEFAULT '{}',
    log_file TEXT DEFAULT '',
    sent_at TEXT DEFAULT '',
    last_seen TEXT NOT NULL,
    source_ip TEXT DEFAULT '',
    runner_busy INTEGER,
    auto_cleanup INTEGER NOT NULL DEFAULT 0,
    include_volumes INTEGER NOT NULL DEFAULT 0,
    last_cleanup_at TEXT,
    last_cleanup_reclaimed_bytes INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS node_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    file_name TEXT DEFAULT '',
    sha256 TEXT NOT NULL,
    content TEXT NOT NULL,
    FOREIGN KEY(node_id) REFERENCES nodes(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_node_logs_node_time ON node_logs(node_id, id DESC);
  CREATE TABLE IF NOT EXISTS cleanup_commands (
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    reason TEXT NOT NULL,
    include_volumes INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    issued_at TEXT,
    completed_at TEXT,
    success INTEGER,
    reclaimed_bytes INTEGER NOT NULL DEFAULT 0,
    output TEXT DEFAULT '',
    FOREIGN KEY(node_id) REFERENCES nodes(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_cleanup_node_time ON cleanup_commands(node_id, created_at DESC);
`);

function securityHeaders() {
  return {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  };
}
function json(res, status, body, extra = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { ...securityHeaders(), 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(payload), ...extra });
  res.end(payload);
}
function text(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  body = String(body ?? '');
  res.writeHead(status, { ...securityHeaders(), 'content-type': type, 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body), ...extra });
  res.end(body);
}
function redirect(res, location, extra = {}) {
  res.writeHead(303, { ...securityHeaders(), location, 'cache-control': 'no-store', ...extra });
  res.end();
}
function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function passwordMatches(candidate) {
  if (LOGIN_PASS_SHA256) return constantTimeEqual(crypto.createHash('sha256').update(candidate, 'utf8').digest('hex'), LOGIN_PASS_SHA256);
  return constantTimeEqual(candidate, LOGIN_PASS);
}
function parseCookies(req) {
  const result = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try { result[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch {}
  }
  return result;
}
function sign(value) { return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url'); }
function makeSession(username) {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ u: username, iat: now, exp: now + SESSION_TTL_HOURS * 3600, n: crypto.randomBytes(12).toString('hex') })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
function readSession(req) {
  if (!authConfigured) return { u: 'local', exp: Number.MAX_SAFE_INTEGER };
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot), signature = token.slice(dot + 1);
  if (!constantTimeEqual(signature, sign(payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (data.u !== LOGIN_USER || !Number.isFinite(data.exp) || data.exp <= Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch { return null; }
}
function sessionCookie(token) {
  return [`${SESSION_COOKIE}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${SESSION_TTL_HOURS * 3600}`, COOKIE_SECURE ? 'Secure' : ''].filter(Boolean).join('; ');
}
function clearSessionCookie() {
  return [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT', COOKIE_SECURE ? 'Secure' : ''].filter(Boolean).join('; ');
}
function clientIp(req) { return String(req.socket.remoteAddress || 'unknown'); }
function loginRateLimited(req) {
  const key = clientIp(req), item = loginAttempts.get(key), now = Date.now();
  if (!item || item.resetAt <= now) { loginAttempts.delete(key); return false; }
  return item.count >= 8;
}
function recordLoginFailure(req) {
  const key = clientIp(req), now = Date.now(), item = loginAttempts.get(key);
  if (!item || item.resetAt <= now) loginAttempts.set(key, { count: 1, resetAt: now + 15 * 60 * 1000 }); else item.count++;
}
function readBody(req, maxBytes = 65536) {
  return new Promise((resolve, reject) => {
    let total = 0; const chunks = [];
    req.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes) { reject(Object.assign(new Error('Request body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
async function readJsonBody(req, maxBytes = 65536) {
  try { return JSON.parse(await readBody(req, maxBytes)); } catch (err) { if (err.status) throw err; throw Object.assign(new Error('Invalid JSON body'), { status: 400 }); }
}

async function cached(key, ttl, fn) {
  const now = Date.now(), item = cache.get(key);
  if (item && item.expires > now) return item.value;
  const value = await fn(); cache.set(key, { expires: now + ttl, value }); return value;
}
async function githubFetch(apiPath, options = {}) {
  const headers = { Accept: options.accept || 'application/vnd.github+json', 'X-GitHub-Api-Version': API_VERSION, 'User-Agent': 'neko-runner-dashboard/3.0' };
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  const response = await fetch(`https://api.github.com${apiPath}`, { method: options.method || 'GET', headers, redirect: 'follow' });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw Object.assign(new Error(`GitHub API ${response.status}: ${body.slice(0, 300) || response.statusText}`), { status: response.status });
  }
  return options.buffer ? Buffer.from(await response.arrayBuffer()) : response.json();
}
async function mapLimit(items, limit, fn) {
  let index = 0; const result = new Array(items.length);
  async function worker() { while (true) { const i = index++; if (i >= items.length) return; result[i] = await fn(items[i]); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, worker)); return result;
}
async function getRepos() {
  if (!GITHUB_ORG) throw new Error('GITHUB_ORG is not configured');
  if (DASHBOARD_REPOS.length) return DASHBOARD_REPOS.map(v => v.includes('/') ? v.split('/').pop() : v);
  return cached('repos', 300000, async () => {
    const data = await githubFetch(`/orgs/${encodeURIComponent(GITHUB_ORG)}/repos?per_page=100&type=all&sort=pushed&direction=desc`);
    return data.slice(0, MAX_REPOS).map(repo => repo.name);
  });
}
function normalizeRun(run, repo) {
  return { id: run.id, repo, name: run.name || 'Workflow', display_title: run.display_title || run.name || 'Workflow run', run_number: run.run_number, status: run.status, conclusion: run.conclusion, branch: run.head_branch, actor: run.actor?.login || 'unknown', created_at: run.created_at, updated_at: run.updated_at, html_url: run.html_url };
}
async function getOverview() {
  return cached('overview', REFRESH_SECONDS * 1000, async () => {
    const repos = await getRepos(); let runners = [], runnersError = null;
    try {
      const response = await githubFetch(`/orgs/${encodeURIComponent(GITHUB_ORG)}/actions/runners?per_page=100`);
      runners = (response.runners || []).map(r => ({ id: r.id, name: r.name, os: r.os, status: r.status, busy: r.busy, labels: (r.labels || []).map(l => l.name) }));
    } catch (err) { runnersError = err.message; }
    const repoRuns = await mapLimit(repos, 4, async repo => {
      try { const data = await githubFetch(`/repos/${encodeURIComponent(GITHUB_ORG)}/${encodeURIComponent(repo)}/actions/runs?per_page=5`); return (data.workflow_runs || []).map(run => normalizeRun(run, repo)); }
      catch (err) { return [{ repo, api_error: err.message }]; }
    });
    const runs = repoRuns.flat().filter(v => !v.api_error).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 60);
    const activeRuns = runs.filter(r => ['queued', 'in_progress'].includes(r.status));
    const activeJobs = [];
    await mapLimit(activeRuns.slice(0, 10), 3, async run => {
      try {
        const data = await githubFetch(`/repos/${encodeURIComponent(GITHUB_ORG)}/${encodeURIComponent(run.repo)}/actions/runs/${run.id}/jobs?per_page=100`);
        for (const job of data.jobs || []) if (['queued', 'in_progress'].includes(job.status)) activeJobs.push({ id: job.id, run_id: run.id, repo: run.repo, name: job.name, status: job.status, runner_name: job.runner_name, started_at: job.started_at });
      } catch {}
    });
    const oneDay = Date.now() - 86400000;
    const failed24h = runs.filter(r => r.conclusion === 'failure' && new Date(r.updated_at).getTime() >= oneDay).length;
    return { org: GITHUB_ORG, generated_at: new Date().toISOString(), refresh_seconds: REFRESH_SECONDS, runners, runners_error: runnersError, repos, runs, active_jobs: activeJobs, summary: { runners_total: runners.length, runners_online: runners.filter(r => r.status === 'online').length, runners_busy: runners.filter(r => r.busy).length, active_runs: activeRuns.length, failed_24h: failed24h } };
  });
}
async function getRunDetail(repo, runId) {
  const safeRepo = encodeURIComponent(repo);
  const run = await githubFetch(`/repos/${encodeURIComponent(GITHUB_ORG)}/${safeRepo}/actions/runs/${encodeURIComponent(runId)}`);
  const jobs = await githubFetch(`/repos/${encodeURIComponent(GITHUB_ORG)}/${safeRepo}/actions/runs/${encodeURIComponent(runId)}/jobs?per_page=100`);
  return { run: normalizeRun(run, repo), jobs: (jobs.jobs || []).map(j => ({ id: j.id, name: j.name, status: j.status, conclusion: j.conclusion, runner_name: j.runner_name, runner_group_name: j.runner_group_name, started_at: j.started_at, completed_at: j.completed_at, steps: (j.steps || []).map(s => ({ number: s.number, name: s.name, status: s.status, conclusion: s.conclusion })) })) };
}
function stripAnsi(value) { return String(value || '').replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, ''); }
async function getRunLogs(repo, runId) {
  const buffer = await githubFetch(`/repos/${encodeURIComponent(GITHUB_ORG)}/${encodeURIComponent(repo)}/actions/runs/${encodeURIComponent(runId)}/logs`, { buffer: true });
  const tmp = path.join(os.tmpdir(), `neko-run-${process.pid}-${Date.now()}.zip`); await fs.promises.writeFile(tmp, buffer);
  try {
    const output = await new Promise((resolve, reject) => execFile('unzip', ['-p', tmp], { maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => err ? reject(new Error(stderr || err.message)) : resolve(stdout)));
    return stripAnsi(output).slice(-8 * 1024 * 1024);
  } finally { fs.promises.unlink(tmp).catch(() => {}); }
}

function safeLogFile(baseDir, file) {
  const base = path.resolve(baseDir), target = path.resolve(base, path.basename(file));
  if (!target.startsWith(base + path.sep)) throw new Error('Invalid log file'); return target;
}
async function listLocalLogs() {
  const result = [];
  for (const [source, dir] of [['diag', DIAG_DIR], ['console', CONSOLE_DIR]]) {
    try {
      for (const file of await fs.promises.readdir(dir)) {
        const full = safeLogFile(dir, file), stat = await fs.promises.stat(full).catch(() => null);
        if (stat?.isFile()) result.push({ source, file, size: stat.size, modified_at: stat.mtime.toISOString() });
      }
    } catch {}
  }
  return result.sort((a, b) => new Date(b.modified_at) - new Date(a.modified_at)).slice(0, 100);
}
async function tailFile(filePath, maxBytes = 1024 * 1024) {
  const stat = await fs.promises.stat(filePath), start = Math.max(0, stat.size - maxBytes), handle = await fs.promises.open(filePath, 'r');
  try { const buffer = Buffer.alloc(stat.size - start); await handle.read(buffer, 0, buffer.length, start); return stripAnsi(buffer); } finally { await handle.close(); }
}

function sanitizeNodeId(value) {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id)) throw Object.assign(new Error('Invalid node id'), { status: 400 });
  return id;
}
function safeString(value, max = 160) { return String(value ?? '').slice(0, max); }
function safeNumber(value, min = 0, max = Number.MAX_SAFE_INTEGER) { const n = Number(value); return Number.isFinite(n) ? Math.max(min, Math.min(n, max)) : 0; }
function parseJson(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }
function nodeOnline(lastSeen) { return Date.now() - new Date(lastSeen).getTime() <= NODE_OFFLINE_SECONDS * 1000; }
function publicNode(row) {
  const storage = parseJson(row.storage_json, {}), metrics = parseJson(row.metrics_json, {});
  return { id: row.id, name: row.name, location: row.location, runner_name: row.runner_name, labels: parseJson(row.labels_json, []), agent_version: row.agent_version, hostname: row.hostname, platform: row.platform, arch: row.arch, kernel: row.kernel, uptime_seconds: row.uptime_seconds, metrics, storage, log_file: row.log_file, sent_at: row.sent_at, last_seen: row.last_seen, online: nodeOnline(row.last_seen), runner_busy: row.runner_busy === null ? null : Boolean(row.runner_busy), auto_cleanup: Boolean(row.auto_cleanup), include_volumes: Boolean(row.include_volumes), last_cleanup_at: row.last_cleanup_at, last_cleanup_reclaimed_bytes: Number(row.last_cleanup_reclaimed_bytes || 0) };
}
function normalizeNodePayload(body) {
  const metrics = body.metrics && typeof body.metrics === 'object' ? body.metrics : {};
  const storage = body.storage && typeof body.storage === 'object' ? body.storage : {};
  return {
    id: sanitizeNodeId(body.id), name: safeString(body.name || body.id, 120), location: safeString(body.location, 160), runner_name: safeString(body.runner_name, 120), labels: Array.isArray(body.labels) ? body.labels.slice(0, 30).map(v => safeString(v, 50)) : [], agent_version: safeString(body.agent_version, 40), hostname: safeString(body.hostname, 160), platform: safeString(body.platform, 100), arch: safeString(body.arch, 40), kernel: safeString(body.kernel, 160), uptime_seconds: safeNumber(body.uptime_seconds, 0, 10 * 365 * 86400), metrics: { load_1: safeNumber(metrics.load_1, 0, 100000), load_5: safeNumber(metrics.load_5, 0, 100000), load_15: safeNumber(metrics.load_15, 0, 100000), memory_total: safeNumber(metrics.memory_total), memory_free: safeNumber(metrics.memory_free), memory_used_percent: safeNumber(metrics.memory_used_percent, 0, 100), cpu_count: safeNumber(metrics.cpu_count, 0, 4096) }, storage: { docker_total_bytes: safeNumber(storage.docker_total_bytes), docker_reclaimable_bytes: safeNumber(storage.docker_reclaimable_bytes), runner_logs_bytes: safeNumber(storage.runner_logs_bytes), reclaimable_bytes: safeNumber(storage.reclaimable_bytes) }, log_file: safeString(body.log_file, 200), log_tail: stripAnsi(body.log_tail).slice(-NODE_MAX_LOG_BYTES), sent_at: safeString(body.sent_at, 64), runner_busy: typeof body.runner_busy === 'boolean' ? body.runner_busy : null, cleanup_result: body.cleanup_result && typeof body.cleanup_result === 'object' ? body.cleanup_result : null };
}
function nodeAuthorized(req) {
  const header = String(req.headers.authorization || '');
  return Boolean(NODE_SHARED_SECRET && header.startsWith('Bearer ') && constantTimeEqual(header.slice(7), NODE_SHARED_SECRET));
}
function queueCleanup(nodeId, reason, includeVolumes) {
  const existing = db.prepare("SELECT id FROM cleanup_commands WHERE node_id=? AND status IN ('pending','issued') ORDER BY created_at DESC LIMIT 1").get(nodeId);
  if (existing) return existing.id;
  const id = crypto.randomUUID(), now = new Date().toISOString();
  db.prepare('INSERT INTO cleanup_commands(id,node_id,created_at,reason,include_volumes,status) VALUES(?,?,?,?,?,?)').run(id, nodeId, now, reason, includeVolumes ? 1 : 0, 'pending');
  return id;
}
function archiveLog(nodeId, fileName, content) {
  if (!content) return;
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  const latest = db.prepare('SELECT sha256 FROM node_logs WHERE node_id=? ORDER BY id DESC LIMIT 1').get(nodeId);
  if (latest?.sha256 === hash) return;
  const now = new Date().toISOString();
  db.prepare('INSERT INTO node_logs(node_id,created_at,file_name,sha256,content) VALUES(?,?,?,?,?)').run(nodeId, now, fileName || '', hash, content);
  const cutoff = new Date(Date.now() - LOG_RETENTION_DAYS * 86400000).toISOString();
  db.prepare('DELETE FROM node_logs WHERE created_at < ?').run(cutoff);
  db.prepare('DELETE FROM node_logs WHERE node_id=? AND id NOT IN (SELECT id FROM node_logs WHERE node_id=? ORDER BY id DESC LIMIT ?)').run(nodeId, nodeId, LOG_MAX_ROWS_PER_NODE);
}
function applyCleanupResult(result) {
  if (!result?.command_id) return;
  const id = safeString(result.command_id, 80), success = Boolean(result.success), reclaimed = safeNumber(result.reclaimed_bytes), output = safeString(result.output, 16000), now = new Date().toISOString();
  const cmd = db.prepare('SELECT node_id FROM cleanup_commands WHERE id=?').get(id);
  if (!cmd) return;
  db.prepare('UPDATE cleanup_commands SET status=?,completed_at=?,success=?,reclaimed_bytes=?,output=? WHERE id=?').run(success ? 'completed' : 'failed', now, success ? 1 : 0, reclaimed, output, id);
  if (success) db.prepare('UPDATE nodes SET last_cleanup_at=?,last_cleanup_reclaimed_bytes=? WHERE id=?').run(now, reclaimed, cmd.node_id);
}
function pendingCleanup(nodeId) {
  const retryBefore = new Date(Date.now() - 120000).toISOString();
  const cmd = db.prepare("SELECT * FROM cleanup_commands WHERE node_id=? AND (status='pending' OR (status='issued' AND issued_at<?)) ORDER BY created_at LIMIT 1").get(nodeId, retryBefore);
  if (!cmd) return null;
  const now = new Date().toISOString();
  db.prepare("UPDATE cleanup_commands SET status='issued',issued_at=? WHERE id=?").run(now, cmd.id);
  return { id: cmd.id, type: 'cleanup', reason: cmd.reason, include_volumes: Boolean(cmd.include_volumes) };
}
async function receiveHeartbeat(req, res) {
  if (!NODE_SHARED_SECRET) return json(res, 503, { error: 'Remote node ingestion is disabled' });
  if (!nodeAuthorized(req)) return json(res, 401, { error: 'Invalid node token' });
  const body = normalizeNodePayload(await readJsonBody(req, NODE_MAX_BODY_BYTES));
  const previous = db.prepare('SELECT runner_busy,auto_cleanup,include_volumes FROM nodes WHERE id=?').get(body.id);
  applyCleanupResult(body.cleanup_result);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO nodes(id,name,location,runner_name,labels_json,agent_version,hostname,platform,arch,kernel,uptime_seconds,metrics_json,storage_json,log_file,sent_at,last_seen,source_ip,runner_busy)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,location=excluded.location,runner_name=excluded.runner_name,labels_json=excluded.labels_json,agent_version=excluded.agent_version,hostname=excluded.hostname,platform=excluded.platform,arch=excluded.arch,kernel=excluded.kernel,uptime_seconds=excluded.uptime_seconds,metrics_json=excluded.metrics_json,storage_json=excluded.storage_json,log_file=excluded.log_file,sent_at=excluded.sent_at,last_seen=excluded.last_seen,source_ip=excluded.source_ip,runner_busy=excluded.runner_busy`).run(body.id, body.name, body.location, body.runner_name, JSON.stringify(body.labels), body.agent_version, body.hostname, body.platform, body.arch, body.kernel, body.uptime_seconds, JSON.stringify(body.metrics), JSON.stringify(body.storage), body.log_file, body.sent_at, now, clientIp(req), body.runner_busy === null ? null : (body.runner_busy ? 1 : 0));
  archiveLog(body.id, body.log_file, body.log_tail);
  if (previous && previous.runner_busy === 1 && body.runner_busy === false && previous.auto_cleanup === 1) queueCleanup(body.id, 'job-finished', Boolean(previous.include_volumes));
  const action = pendingCleanup(body.id);
  return json(res, 200, { ok: true, node_id: body.id, received_at: now, action });
}
function getNodesSummary() {
  const rows = db.prepare('SELECT * FROM nodes ORDER BY name COLLATE NOCASE').all();
  const nodes = rows.map(publicNode).sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  const reclaimable = nodes.reduce((sum, n) => sum + Number(n.storage?.reclaimable_bytes || 0), 0);
  return { enabled: Boolean(NODE_SHARED_SECRET), offline_after_seconds: NODE_OFFLINE_SECONDS, nodes, summary: { total: nodes.length, online: nodes.filter(n => n.online).length, offline: nodes.filter(n => !n.online).length, reclaimable_bytes: reclaimable } };
}

function serveStatic(name, res) {
  const target = path.resolve(PUBLIC_DIR, name);
  if (!target.startsWith(PUBLIC_DIR + path.sep)) return text(res, 403, 'Forbidden');
  fs.readFile(target, (err, data) => {
    if (err) return text(res, 404, 'Not found');
    const ext = path.extname(target), type = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.css' ? 'text/css; charset=utf-8' : ext === '.js' ? 'application/javascript; charset=utf-8' : 'application/octet-stream';
    res.writeHead(200, { ...securityHeaders(), 'content-type': type, 'cache-control': 'no-cache' }); res.end(data);
  });
}
function serveLogin(res, error = '') {
  fs.readFile(path.join(PUBLIC_DIR, 'login.html'), 'utf8', (err, template) => {
    if (err) return text(res, 500, 'Login page unavailable');
    const safe = String(error).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
    text(res, 200, template.replace('{{ERROR}}', safe), 'text/html; charset=utf-8');
  });
}

const server = http.createServer(async (req, res) => {
  if (shuttingDown) return text(res, 503, 'Dashboard is shutting down', 'text/plain; charset=utf-8', { connection: 'close' });
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/healthz') return json(res, 200, { ok: true });
    if (url.pathname === '/internal/nodes/heartbeat' && req.method === 'POST') return receiveHeartbeat(req, res);
    if (url.pathname === '/login' && req.method === 'GET') return readSession(req) ? redirect(res, '/') : serveLogin(res);
    if (url.pathname === '/login' && req.method === 'POST') {
      if (loginRateLimited(req)) return serveLogin(res, 'Too many failed attempts. Try again later.');
      const form = new URLSearchParams(await readBody(req));
      const username = String(form.get('username') || ''), password = String(form.get('password') || '');
      if (!constantTimeEqual(username, LOGIN_USER) || !passwordMatches(password)) { recordLoginFailure(req); return serveLogin(res, 'Invalid username or password.'); }
      loginAttempts.delete(clientIp(req)); return redirect(res, '/', { 'set-cookie': sessionCookie(makeSession(LOGIN_USER)) });
    }
    if (url.pathname === '/logout') return redirect(res, '/login', { 'set-cookie': clearSessionCookie() });
    const session = readSession(req);
    if (!session) return url.pathname.startsWith('/api/') ? json(res, 401, { error: 'Authentication required' }) : redirect(res, '/login');

    if (url.pathname === '/api/health') return json(res, 200, { ok: true, org: GITHUB_ORG, db_file: DB_FILE, db_bytes: fs.statSync(DB_FILE).size, log_retention_days: LOG_RETENTION_DAYS });
    if (url.pathname === '/api/overview') return json(res, 200, await getOverview());
    if (url.pathname === '/api/nodes') return json(res, 200, getNodesSummary());
    if (url.pathname === '/api/node') {
      const id = sanitizeNodeId(url.searchParams.get('id')), row = db.prepare('SELECT * FROM nodes WHERE id=?').get(id);
      if (!row) return json(res, 404, { error: 'Node not found' });
      const latest = db.prepare('SELECT id,created_at,file_name,content FROM node_logs WHERE node_id=? ORDER BY id DESC LIMIT 1').get(id);
      return json(res, 200, { node: publicNode(row), latest_log: latest || null });
    }
    if (url.pathname === '/api/node/log-history') {
      const id = sanitizeNodeId(url.searchParams.get('id')), limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 50), 200));
      return json(res, 200, { logs: db.prepare('SELECT id,created_at,file_name,length(content) AS bytes,content FROM node_logs WHERE node_id=? ORDER BY id DESC LIMIT ?').all(id, limit) });
    }
    if (url.pathname === '/api/node/cleanup-history') {
      const id = sanitizeNodeId(url.searchParams.get('id'));
      return json(res, 200, { commands: db.prepare('SELECT * FROM cleanup_commands WHERE node_id=? ORDER BY created_at DESC LIMIT 50').all(id) });
    }
    if (url.pathname === '/api/node/settings' && req.method === 'POST') {
      const body = await readJsonBody(req), id = sanitizeNodeId(body.id);
      if (!db.prepare('SELECT id FROM nodes WHERE id=?').get(id)) return json(res, 404, { error: 'Node not found' });
      db.prepare('UPDATE nodes SET auto_cleanup=?,include_volumes=? WHERE id=?').run(body.auto_cleanup ? 1 : 0, body.include_volumes ? 1 : 0, id);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/node/cleanup' && req.method === 'POST') {
      const body = await readJsonBody(req), id = sanitizeNodeId(body.id), row = db.prepare('SELECT include_volumes FROM nodes WHERE id=?').get(id);
      if (!row) return json(res, 404, { error: 'Node not found' });
      return json(res, 200, { ok: true, command_id: queueCleanup(id, 'manual', Boolean(row.include_volumes)) });
    }
    if (url.pathname === '/api/run') {
      const repo = url.searchParams.get('repo'), id = url.searchParams.get('id');
      if (!repo || !id) return json(res, 400, { error: 'repo and id required' });
      return json(res, 200, await getRunDetail(repo, id));
    }
    if (url.pathname === '/api/run-logs') {
      const repo = url.searchParams.get('repo'), id = url.searchParams.get('id');
      if (!repo || !id) return json(res, 400, { error: 'repo and id required' });
      return text(res, 200, await getRunLogs(repo, id));
    }
    if (url.pathname === '/api/local-files') return json(res, 200, { files: await listLocalLogs() });
    if (url.pathname === '/api/local-log') {
      const source = url.searchParams.get('source'), file = url.searchParams.get('file');
      if (!file || !['diag','console'].includes(source)) return json(res, 400, { error: 'valid source and file required' });
      return text(res, 200, await tailFile(safeLogFile(source === 'diag' ? DIAG_DIR : CONSOLE_DIR, file)));
    }
    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found' });
    if (url.pathname === '/' || url.pathname === '/index.html') return serveStatic('index-v3.html', res);
    return serveStatic(url.pathname.slice(1), res);
  } catch (err) {
    console.error(err);
    return json(res, Number(err.status) || 500, { error: err.message || 'Internal server error' });
  }
});

server.keepAliveTimeout = 5000;
server.headersTimeout = 10000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Neko Runner Dashboard v3 listening on :${PORT}`);
  console.log(`SQLite: ${DB_FILE}`);
  console.log(`Authentication: ${authConfigured ? 'enabled' : 'disabled'}`);
  console.log(`Remote nodes: ${NODE_SHARED_SECRET ? 'enabled' : 'disabled'}`);
});
function shutdown(signal) {
  if (shuttingDown) return; shuttingDown = true; console.log(`${signal}: stopping dashboard...`);
  const timer = setTimeout(() => { if (server.closeAllConnections) server.closeAllConnections(); try { db.close(); } catch {} process.exit(0); }, 8000); timer.unref();
  if (server.closeIdleConnections) server.closeIdleConnections();
  server.close(() => { clearTimeout(timer); try { db.close(); } catch {} console.log('Dashboard stopped cleanly.'); process.exit(0); });
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGHUP', () => shutdown('SIGHUP'));
