'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

// This module is preloaded after github-cache.js. It turns GitHub's paginated
// organization runner endpoint into a persistent SQLite-backed inventory.
// Dashboard callers always read the inventory from SQLite; GitHub is only
// contacted by the background/full sync, so one partial/rate-limited response
// cannot make runners disappear from the UI.

const upstreamFetch = globalThis.fetch.bind(globalThis);
const GITHUB_ORG = String(process.env.GITHUB_ORG || '').trim();
const GITHUB_TOKEN = process.env.GITHUB_DASHBOARD_TOKEN || process.env.ACCESS_TOKEN || '';
const DB_FILE = process.env.DASHBOARD_DB_FILE || '/data/dashboard.sqlite';
const API_VERSION = '2022-11-28';
const SYNC_SECONDS = Math.max(30, Math.min(Number(process.env.DASHBOARD_GITHUB_RUNNER_SYNC_SECONDS || 60), 3600));
const MAX_PAGES = Math.max(1, Math.min(Number(process.env.DASHBOARD_GITHUB_RUNNER_MAX_PAGES || 100), 500));

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA synchronous=NORMAL;
  PRAGMA busy_timeout=5000;

  CREATE TABLE IF NOT EXISTS github_runners (
    github_id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    os TEXT DEFAULT '',
    status TEXT DEFAULT 'offline',
    busy INTEGER NOT NULL DEFAULT 0,
    labels_json TEXT NOT NULL DEFAULT '[]',
    first_seen_at TEXT NOT NULL,
    last_seen_api_at TEXT NOT NULL,
    last_full_sync_at TEXT,
    last_sync_id TEXT,
    api_present INTEGER NOT NULL DEFAULT 1
  );

  CREATE INDEX IF NOT EXISTS idx_github_runners_name
    ON github_runners(name COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_github_runners_present
    ON github_runners(api_present, status, name COLLATE NOCASE);

  CREATE TABLE IF NOT EXISTS github_runner_sync_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    last_attempt_at TEXT,
    last_success_at TEXT,
    last_error TEXT DEFAULT '',
    total_from_github INTEGER NOT NULL DEFAULT 0,
    pages_fetched INTEGER NOT NULL DEFAULT 0,
    authoritative INTEGER NOT NULL DEFAULT 0
  );

  INSERT OR IGNORE INTO github_runner_sync_state(singleton)
  VALUES(1);
`);

let syncPromise = null;
let lastRuntimeSyncAt = 0;

function requestUrl(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input && typeof input.url === 'string' ? input.url : '';
}

function requestMethod(input, init) {
  return String(init?.method || input?.method || 'GET').toUpperCase();
}

function isRunnerListRequest(url, method) {
  if (method !== 'GET' || !GITHUB_ORG) return false;
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.hostname !== 'api.github.com') return false;
  const match = parsed.pathname.match(/^\/orgs\/([^/]+)\/actions\/runners$/);
  if (!match) return false;
  try { return decodeURIComponent(match[1]).toLowerCase() === GITHUB_ORG.toLowerCase(); }
  catch { return false; }
}

function parseLabels(value) {
  try {
    const labels = JSON.parse(value || '[]');
    return Array.isArray(labels) ? labels : [];
  } catch {
    return [];
  }
}

function runnerSnapshot() {
  const rows = db.prepare(`
    SELECT github_id, name, os, status, busy, labels_json,
           first_seen_at, last_seen_api_at, last_full_sync_at, api_present
    FROM github_runners
    ORDER BY api_present DESC,
             CASE status WHEN 'online' THEN 0 ELSE 1 END,
             name COLLATE NOCASE
  `).all();

  return {
    total_count: rows.length,
    runners: rows.map(row => ({
      id: Number(row.github_id),
      name: row.name,
      os: row.os || 'unknown',
      status: row.api_present ? (row.status || 'offline') : 'offline',
      busy: row.api_present ? Boolean(row.busy) : false,
      labels: parseLabels(row.labels_json).map(name => ({ id: 0, name, type: 'custom' })),
      _neko_cached: true,
      _neko_api_present: Boolean(row.api_present),
      _neko_first_seen_at: row.first_seen_at,
      _neko_last_seen_api_at: row.last_seen_api_at,
      _neko_last_full_sync_at: row.last_full_sync_at,
    })),
  };
}

function snapshotResponse(cacheState = 'sqlite') {
  const snapshot = runnerSnapshot();
  const state = db.prepare(`
    SELECT last_success_at, last_error, total_from_github, pages_fetched, authoritative
    FROM github_runner_sync_state WHERE singleton=1
  `).get() || {};

  return new Response(JSON.stringify(snapshot), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-neko-runner-store': cacheState,
      'x-neko-runner-store-count': String(snapshot.total_count),
      'x-neko-runner-store-last-sync': state.last_success_at || '',
      'x-neko-runner-store-authoritative': state.authoritative ? '1' : '0',
    },
  });
}

function updateSyncState(values) {
  const current = db.prepare('SELECT * FROM github_runner_sync_state WHERE singleton=1').get() || {};
  db.prepare(`
    UPDATE github_runner_sync_state
    SET last_attempt_at=?, last_success_at=?, last_error=?,
        total_from_github=?, pages_fetched=?, authoritative=?
    WHERE singleton=1
  `).run(
    values.last_attempt_at ?? current.last_attempt_at ?? null,
    values.last_success_at ?? current.last_success_at ?? null,
    values.last_error ?? current.last_error ?? '',
    Number(values.total_from_github ?? current.total_from_github ?? 0),
    Number(values.pages_fetched ?? current.pages_fetched ?? 0),
    values.authoritative === undefined ? Number(current.authoritative || 0) : (values.authoritative ? 1 : 0),
  );
}

function upsertBatch(runners, syncId, now) {
  const stmt = db.prepare(`
    INSERT INTO github_runners(
      github_id, name, os, status, busy, labels_json,
      first_seen_at, last_seen_api_at, last_sync_id, api_present
    ) VALUES(?,?,?,?,?,?,?,?,?,1)
    ON CONFLICT(github_id) DO UPDATE SET
      name=excluded.name,
      os=excluded.os,
      status=excluded.status,
      busy=excluded.busy,
      labels_json=excluded.labels_json,
      last_seen_api_at=excluded.last_seen_api_at,
      last_sync_id=excluded.last_sync_id,
      api_present=1
  `);

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const runner of runners) {
      if (!runner || !Number.isFinite(Number(runner.id)) || !runner.name) continue;
      stmt.run(
        Number(runner.id),
        String(runner.name).slice(0, 200),
        String(runner.os || '').slice(0, 80),
        String(runner.status || 'offline').slice(0, 40),
        runner.busy ? 1 : 0,
        JSON.stringify((runner.labels || []).map(label => String(label?.name || '')).filter(Boolean).slice(0, 100)),
        now,
        now,
        syncId,
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    throw err;
  }
}

async function fetchRunnerPage(page) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': 'neko-runner-dashboard-runner-store/1.0',
  };
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;

  const url = `https://api.github.com/orgs/${encodeURIComponent(GITHUB_ORG)}/actions/runners?per_page=100&page=${page}`;
  const response = await upstreamFetch(url, { headers, redirect: 'follow' });
  const cacheState = String(response.headers.get('x-neko-github-cache') || '');
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw Object.assign(new Error(`GitHub runner sync ${response.status}: ${body.slice(0, 300) || response.statusText}`), { status: response.status });
  }
  const data = await response.json();
  return {
    runners: Array.isArray(data.runners) ? data.runners : [],
    total_count: Number(data.total_count || 0),
    authoritative: !cacheState.includes('stale-rate-limit'),
  };
}

async function fullSync(reason = 'scheduled') {
  if (!GITHUB_ORG || !GITHUB_TOKEN) {
    throw new Error('GitHub runner sync requires GITHUB_ORG and dashboard/access token');
  }
  if (syncPromise) return syncPromise;

  syncPromise = (async () => {
    const started = new Date().toISOString();
    const syncId = `${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
    let totalExpected = 0;
    let pagesFetched = 0;
    let authoritative = true;
    let complete = false;
    const collected = [];

    updateSyncState({ last_attempt_at: started, last_error: '', authoritative: false });
    console.log(`[runner-store] syncing all GitHub org runners (${reason})...`);

    try {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const result = await fetchRunnerPage(page);
        pagesFetched = page;
        if (page === 1) totalExpected = result.total_count;
        authoritative = authoritative && result.authoritative;
        collected.push(...result.runners);

        if (result.runners.length < 100 || (totalExpected > 0 && collected.length >= totalExpected)) {
          complete = true;
          break;
        }
      }

      const now = new Date().toISOString();
      upsertBatch(collected, syncId, now);

      // Only a complete, non-stale pagination pass is allowed to mark runners as
      // absent. They are intentionally retained forever in SQLite and shown
      // offline instead of being deleted from the dashboard inventory.
      if (complete && authoritative) {
        db.prepare(`
          UPDATE github_runners
          SET api_present=0, status='offline', busy=0, last_full_sync_at=?
          WHERE last_sync_id IS NULL OR last_sync_id<>?
        `).run(now, syncId);
        db.prepare(`UPDATE github_runners SET last_full_sync_at=? WHERE last_sync_id=?`).run(now, syncId);
      }

      updateSyncState({
        last_attempt_at: started,
        last_success_at: now,
        last_error: '',
        total_from_github: totalExpected || collected.length,
        pages_fetched: pagesFetched,
        authoritative: complete && authoritative,
      });
      lastRuntimeSyncAt = Date.now();

      console.log(`[runner-store] sync complete: fetched=${collected.length} expected=${totalExpected || '?'} pages=${pagesFetched} stored=${runnerSnapshot().total_count} authoritative=${complete && authoritative}`);
      return runnerSnapshot();
    } catch (err) {
      // Keep every previously stored runner. A failed/rate-limited sync must not
      // shrink the inventory or overwrite old status with a partial result.
      if (collected.length) {
        try { upsertBatch(collected, syncId, new Date().toISOString()); } catch {}
      }
      updateSyncState({
        last_attempt_at: started,
        last_error: err.message,
        total_from_github: totalExpected,
        pages_fetched: pagesFetched,
        authoritative: false,
      });
      console.warn(`[runner-store] sync failed after ${pagesFetched} page(s): ${err.message}; keeping ${runnerSnapshot().total_count} cached runner(s).`);
      throw err;
    }
  })().finally(() => { syncPromise = null; });

  return syncPromise;
}

function needsSync() {
  const count = Number(db.prepare('SELECT COUNT(*) AS count FROM github_runners').get()?.count || 0);
  if (count === 0) return true;
  const state = db.prepare('SELECT last_success_at FROM github_runner_sync_state WHERE singleton=1').get();
  const last = state?.last_success_at ? new Date(state.last_success_at).getTime() : 0;
  const effectiveLast = Math.max(lastRuntimeSyncAt, Number.isFinite(last) ? last : 0);
  return !effectiveLast || Date.now() - effectiveLast >= SYNC_SECONDS * 1000;
}

globalThis.fetch = async function sqliteRunnerInventoryFetch(input, init = {}) {
  const url = requestUrl(input);
  const method = requestMethod(input, init);
  if (!isRunnerListRequest(url, method)) return upstreamFetch(input, init);

  if (needsSync()) {
    try { await fullSync('dashboard-request'); }
    catch {
      // Serving SQLite is preferable to returning a rate-limit/partial error.
    }
  }
  return snapshotResponse('sqlite');
};

globalThis.__NEKO_RUNNER_STORE__ = {
  sync: fullSync,
  snapshot: runnerSnapshot,
  state() {
    return db.prepare('SELECT * FROM github_runner_sync_state WHERE singleton=1').get();
  },
};

// First-boot/full sync. This is deliberately asynchronous so the dashboard can
// start immediately and still serve an existing SQLite inventory while GitHub is
// slow or rate-limited.
setTimeout(() => {
  if (needsSync()) fullSync('startup').catch(() => {});
}, 750).unref();

const periodic = setInterval(() => {
  if (needsSync()) fullSync('periodic').catch(() => {});
}, Math.max(30, Math.min(SYNC_SECONDS, 300)) * 1000);
periodic.unref();

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.once(signal, () => {
    try { clearInterval(periodic); } catch {}
    try { db.close(); } catch {}
  });
}

console.log(`[runner-store] SQLite runner inventory enabled: sync=${SYNC_SECONDS}s db=${DB_FILE}`);
