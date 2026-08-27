'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

// Persistent stale-while-revalidate cache layered in front of the in-memory
// GitHub cache. This makes dashboard startup cache-first: if we already have a
// GitHub response in SQLite, serve it immediately and refresh it in background.

const upstreamFetch = globalThis.fetch.bind(globalThis);
const DB_FILE = process.env.DASHBOARD_DB_FILE || '/data/dashboard.sqlite';
const FRESH_SECONDS = Math.max(15, Math.min(Number(process.env.DASHBOARD_GITHUB_PERSIST_FRESH_SECONDS || 120), 3600));
const STALE_SECONDS = Math.max(FRESH_SECONDS, Math.min(Number(process.env.DASHBOARD_GITHUB_PERSIST_STALE_SECONDS || 86400), 7 * 86400));
const MAX_ROWS = Math.max(100, Math.min(Number(process.env.DASHBOARD_GITHUB_PERSIST_MAX_ROWS || 1000), 5000));
const MAX_BODY_BYTES = 6 * 1024 * 1024;

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA synchronous=NORMAL;
  PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS github_http_cache (
    cache_key TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    status INTEGER NOT NULL,
    status_text TEXT DEFAULT '',
    headers_json TEXT NOT NULL,
    body BLOB NOT NULL,
    stored_at INTEGER NOT NULL,
    last_access_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_github_http_cache_access
    ON github_http_cache(last_access_at DESC);
`);

const revalidating = new Map();

function reqUrl(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input && typeof input.url === 'string' ? input.url : '';
}
function reqMethod(input, init) {
  return String(init?.method || input?.method || 'GET').toUpperCase();
}
function cacheable(url, method) {
  if (method !== 'GET' || !url.startsWith('https://api.github.com/')) return false;
  if (/\/logs(?:\?|$)/.test(url)) return false;
  return true;
}
function keyFor(url, init) {
  const h = init?.headers || {};
  const accept = String(h.Accept || h.accept || '');
  return crypto.createHash('sha256').update(`GET\n${url}\n${accept}`).digest('hex');
}
function rowResponse(row, state) {
  const headers = new Headers(JSON.parse(row.headers_json || '[]'));
  headers.set('x-neko-persistent-cache', state);
  headers.set('x-neko-persistent-cache-age', String(Math.max(0, Math.floor((Date.now() - Number(row.stored_at)) / 1000))));
  return new Response(Buffer.from(row.body), {
    status: Number(row.status),
    statusText: row.status_text || '',
    headers,
  });
}
function readRow(key) {
  const row = db.prepare('SELECT * FROM github_http_cache WHERE cache_key=?').get(key);
  if (row) db.prepare('UPDATE github_http_cache SET last_access_at=? WHERE cache_key=?').run(Date.now(), key);
  return row || null;
}
function trim() {
  db.prepare(`DELETE FROM github_http_cache WHERE cache_key IN (
    SELECT cache_key FROM github_http_cache ORDER BY last_access_at DESC LIMIT -1 OFFSET ?
  )`).run(MAX_ROWS);
}
async function storeResponse(key, url, response) {
  const body = Buffer.from(await response.arrayBuffer());
  if (!response.ok || body.length > MAX_BODY_BYTES) {
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  const now = Date.now();
  const headers = Array.from(response.headers.entries());
  db.prepare(`
    INSERT INTO github_http_cache(cache_key,url,status,status_text,headers_json,body,stored_at,last_access_at)
    VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(cache_key) DO UPDATE SET
      url=excluded.url,status=excluded.status,status_text=excluded.status_text,
      headers_json=excluded.headers_json,body=excluded.body,
      stored_at=excluded.stored_at,last_access_at=excluded.last_access_at
  `).run(key, url, response.status, response.statusText || '', JSON.stringify(headers), body, now, now);
  trim();
  process.emit('neko:github-cache-updated', { url, at: new Date(now).toISOString() });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
async function revalidate(input, init, key, url) {
  if (revalidating.has(key)) return revalidating.get(key);
  const p = (async () => {
    try {
      const response = await upstreamFetch(input, init);
      if (response.ok) await storeResponse(key, url, response);
    } catch (err) {
      console.warn(`[github-persist] background refresh failed for ${new URL(url).pathname}: ${err.message}`);
    }
  })().finally(() => revalidating.delete(key));
  revalidating.set(key, p);
  return p;
}

globalThis.fetch = async function persistentGithubFetch(input, init = {}) {
  const url = reqUrl(input);
  const method = reqMethod(input, init);
  if (!cacheable(url, method)) return upstreamFetch(input, init);

  const key = keyFor(url, init);
  const row = readRow(key);
  const now = Date.now();
  if (row) {
    const age = now - Number(row.stored_at || 0);
    if (age <= FRESH_SECONDS * 1000) return rowResponse(row, 'fresh');
    if (age <= STALE_SECONDS * 1000) {
      revalidate(input, init, key, url).catch(() => {});
      return rowResponse(row, 'stale-while-revalidate');
    }
  }

  try {
    const response = await upstreamFetch(input, init);
    return await storeResponse(key, url, response);
  } catch (err) {
    if (row) return rowResponse(row, 'stale-on-error');
    throw err;
  }
};

for (const signal of ['SIGTERM','SIGINT','SIGHUP']) {
  process.once(signal, () => {
    try { db.close(); } catch {}
  });
}

console.log(`[github-persist] SQLite GitHub cache enabled: fresh=${FRESH_SECONDS}s stale=${STALE_SECONDS}s rows=${MAX_ROWS}`);
