const http = require('http');
const crypto = require('crypto');

const originalCreateServer = http.createServer.bind(http);
const clients = new Set();
const SESSION_COOKIE = 'neko_runner_session';
const LOGIN_USER = process.env.DASHBOARD_USERNAME || '';
const LOGIN_PASS = process.env.DASHBOARD_PASSWORD || '';
const LOGIN_PASS_SHA256 = String(process.env.DASHBOARD_PASSWORD_SHA256 || '').trim().toLowerCase();
const SESSION_SECRET = process.env.DASHBOARD_SESSION_SECRET || '';
const authConfigured = Boolean(LOGIN_USER && (LOGIN_PASS || LOGIN_PASS_SHA256));
const LIVE_GITHUB_SECONDS = Math.max(5, Math.min(Number(process.env.DASHBOARD_LIVE_GITHUB_SECONDS || process.env.DASHBOARD_REFRESH_SECONDS || 10), 120));
const SSE_KEEPALIVE_SECONDS = Math.max(5, Math.min(Number(process.env.DASHBOARD_SSE_KEEPALIVE_SECONDS || 15), 60));

function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
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

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}

function authenticated(req) {
  if (!authConfigured) return true;
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return false;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!constantTimeEqual(signature, sign(payload))) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.u === LOGIN_USER && Number.isFinite(data.exp) && data.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function sendEvent(res, event, data = {}) {
  if (res.destroyed || res.writableEnded) return false;
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function broadcast(event, data = {}) {
  for (const res of [...clients]) {
    if (!sendEvent(res, event, data)) clients.delete(res);
  }
}

function handleEvents(req, res) {
  if (!authenticated(req)) {
    res.writeHead(401, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(JSON.stringify({ error: 'Authentication required' }));
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  res.write('retry: 3000\n\n');
  clients.add(res);
  sendEvent(res, 'ready', {
    at: new Date().toISOString(),
    github_refresh_seconds: LIVE_GITHUB_SECONDS,
  });

  const remove = () => clients.delete(res);
  req.once('close', remove);
  res.once('close', remove);
  res.once('error', remove);
}

http.createServer = function patchedCreateServer(listener) {
  return originalCreateServer((req, res) => {
    let pathname = '/';
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch {}

    if (pathname === '/api/events' && req.method === 'GET') {
      return handleEvents(req, res);
    }

    const liveEvent = pathname === '/internal/nodes/heartbeat' && req.method === 'POST'
      ? 'nodes'
      : pathname === '/api/node/settings' && req.method === 'POST'
        ? 'nodes'
        : pathname === '/api/node/cleanup' && req.method === 'POST'
          ? 'nodes'
          : null;

    if (liveEvent) {
      res.once('finish', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          broadcast(liveEvent, { at: new Date().toISOString(), source: pathname });
        }
      });
    }

    return listener(req, res);
  });
};

const githubTimer = setInterval(() => {
  broadcast('github', { at: new Date().toISOString() });
}, LIVE_GITHUB_SECONDS * 1000);
githubTimer.unref();

const keepaliveTimer = setInterval(() => {
  for (const res of [...clients]) {
    if (res.destroyed || res.writableEnded) clients.delete(res);
    else {
      try { res.write(`: keepalive ${Date.now()}\n\n`); } catch { clients.delete(res); }
    }
  }
}, SSE_KEEPALIVE_SECONDS * 1000);
keepaliveTimer.unref();

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    clearInterval(githubTimer);
    clearInterval(keepaliveTimer);
    for (const res of [...clients]) {
      try { sendEvent(res, 'shutdown', { at: new Date().toISOString() }); res.end(); } catch {}
    }
    clients.clear();
  });
}

console.log(`Realtime SSE: enabled (GitHub tick ${LIVE_GITHUB_SECONDS}s, keepalive ${SSE_KEEPALIVE_SECONDS}s)`);
require('./server.js');
