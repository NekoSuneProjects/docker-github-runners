'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const GITHUB_ORG = String(process.env.GITHUB_ORG || '').trim();
const GITHUB_TOKEN = process.env.GITHUB_DASHBOARD_TOKEN || process.env.ACCESS_TOKEN || '';
const DB_FILE = process.env.DASHBOARD_DB_FILE || '/data/dashboard.sqlite';
const CONFIG_REPOS = String(process.env.DASHBOARD_REPOS || '').split(',').map(v => v.trim()).filter(Boolean).map(v => v.includes('/') ? v.split('/').pop() : v);
const MAX_REPOS = Math.max(1, Math.min(Number(process.env.DASHBOARD_MAX_REPOS || 12), 50));
const SYNC_SECONDS = Math.max(60, Math.min(Number(process.env.DASHBOARD_GITHUB_WORKFLOW_SYNC_SECONDS || 180), 3600));
const RUNS_PER_REPO = Math.max(3, Math.min(Number(process.env.DASHBOARD_GITHUB_WORKFLOW_RUNS_PER_REPO || 8), 30));
const API_VERSION = '2022-11-28';

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA synchronous=NORMAL;
  PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS github_live_repos (
    name TEXT PRIMARY KEY,
    last_seen_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS github_live_runs (
    repo TEXT NOT NULL,
    run_id INTEGER NOT NULL,
    status TEXT NOT NULL,
    conclusion TEXT,
    updated_at TEXT NOT NULL,
    json TEXT NOT NULL,
    PRIMARY KEY(repo, run_id)
  );
  CREATE INDEX IF NOT EXISTS idx_github_live_runs_updated ON github_live_runs(updated_at DESC);
  CREATE TABLE IF NOT EXISTS github_live_jobs (
    repo TEXT NOT NULL,
    run_id INTEGER NOT NULL,
    job_id INTEGER NOT NULL,
    status TEXT NOT NULL,
    conclusion TEXT,
    runner_name TEXT DEFAULT '',
    runner_group_name TEXT DEFAULT '',
    runner_type TEXT NOT NULL DEFAULT 'waiting',
    updated_at TEXT NOT NULL,
    json TEXT NOT NULL,
    PRIMARY KEY(repo, job_id)
  );
  CREATE INDEX IF NOT EXISTS idx_github_live_jobs_run ON github_live_jobs(repo,run_id);
  CREATE TABLE IF NOT EXISTS github_workflow_sync_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    last_attempt_at TEXT,
    last_success_at TEXT,
    last_error TEXT DEFAULT '',
    repos_synced INTEGER NOT NULL DEFAULT 0
  );
  INSERT OR IGNORE INTO github_workflow_sync_state(singleton) VALUES(1);
`);

let syncing = null;
let lastHash = '';

function headers() {
  const h = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': API_VERSION, 'User-Agent': 'neko-runner-dashboard-workflow-store/1.0' };
  if (GITHUB_TOKEN) h.Authorization = `Bearer ${GITHUB_TOKEN}`;
  return h;
}
async function gh(apiPath) {
  const r = await fetch(`https://api.github.com${apiPath}`, { headers: headers(), redirect: 'follow' });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`GitHub workflow sync ${r.status}: ${body.slice(0,300) || r.statusText}`);
  }
  return r.json();
}
function normalizeRun(run, repo) {
  return {
    id: Number(run.id), repo,
    name: run.name || 'Workflow',
    display_title: run.display_title || run.name || 'Workflow run',
    run_number: run.run_number,
    status: run.status || 'unknown', conclusion: run.conclusion || null,
    branch: run.head_branch || '', actor: run.actor?.login || 'unknown',
    created_at: run.created_at, updated_at: run.updated_at, html_url: run.html_url,
  };
}
function runnerType(job) {
  const name = String(job.runner_name || '');
  const group = String(job.runner_group_name || '');
  if (!name) return 'waiting';
  const known = db.prepare('SELECT github_id FROM github_runners WHERE name=?').get(name);
  if (known) return 'self_hosted';
  if (/github actions/i.test(group) || /^github actions\b/i.test(name) || /^hosted agent\b/i.test(name)) return 'github_hosted';
  return 'external';
}
function normalizeJob(job, repo, runId) {
  const type = runnerType(job);
  return {
    id: Number(job.id), run_id: Number(runId), repo,
    name: job.name || 'Job', status: job.status || 'unknown', conclusion: job.conclusion || null,
    runner_name: job.runner_name || '', runner_group_name: job.runner_group_name || '', runner_type: type,
    started_at: job.started_at || null, completed_at: job.completed_at || null,
    steps: (job.steps || []).map(s => ({ number: s.number, name: s.name, status: s.status, conclusion: s.conclusion, started_at: s.started_at || null, completed_at: s.completed_at || null })),
  };
}
async function reposToSync() {
  if (CONFIG_REPOS.length) return CONFIG_REPOS.slice(0, MAX_REPOS);
  const stored = db.prepare('SELECT name FROM github_live_repos ORDER BY last_seen_at DESC LIMIT ?').all(MAX_REPOS).map(r => r.name);
  if (stored.length) return stored;
  const data = await gh(`/orgs/${encodeURIComponent(GITHUB_ORG)}/repos?per_page=100&type=all&sort=pushed&direction=desc`);
  return data.slice(0, MAX_REPOS).map(r => r.name);
}
function upsertRepos(repos, now) {
  const stmt = db.prepare('INSERT INTO github_live_repos(name,last_seen_at) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET last_seen_at=excluded.last_seen_at');
  for (const repo of repos) stmt.run(repo, now);
}
function upsertRun(run) {
  db.prepare(`INSERT INTO github_live_runs(repo,run_id,status,conclusion,updated_at,json) VALUES(?,?,?,?,?,?)
    ON CONFLICT(repo,run_id) DO UPDATE SET status=excluded.status,conclusion=excluded.conclusion,updated_at=excluded.updated_at,json=excluded.json`)
    .run(run.repo, run.id, run.status, run.conclusion, run.updated_at || new Date().toISOString(), JSON.stringify(run));
}
function upsertJob(job) {
  db.prepare(`INSERT INTO github_live_jobs(repo,run_id,job_id,status,conclusion,runner_name,runner_group_name,runner_type,updated_at,json) VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(repo,job_id) DO UPDATE SET run_id=excluded.run_id,status=excluded.status,conclusion=excluded.conclusion,runner_name=excluded.runner_name,runner_group_name=excluded.runner_group_name,runner_type=excluded.runner_type,updated_at=excluded.updated_at,json=excluded.json`)
    .run(job.repo, job.run_id, job.id, job.status, job.conclusion, job.runner_name, job.runner_group_name, job.runner_type, new Date().toISOString(), JSON.stringify(job));
}
function snapshot() {
  const runs = db.prepare('SELECT json FROM github_live_runs ORDER BY datetime(updated_at) DESC LIMIT 120').all().map(r => JSON.parse(r.json));
  const jobs = db.prepare('SELECT json FROM github_live_jobs ORDER BY datetime(updated_at) DESC LIMIT 500').all().map(r => JSON.parse(r.json));
  const activeJobs = jobs.filter(j => ['queued','in_progress','waiting','pending'].includes(String(j.status)));
  const byRun = {};
  for (const job of jobs) (byRun[String(job.run_id)] ||= []).push(job);
  const state = db.prepare('SELECT last_success_at,last_error,repos_synced FROM github_workflow_sync_state WHERE singleton=1').get() || {};
  return { runs, jobs_by_run: byRun, active_jobs: activeJobs, sync: state };
}
function emitIfChanged(reason) {
  const snap = snapshot();
  const hash = crypto.createHash('sha256').update(JSON.stringify({runs:snap.runs,jobs:snap.jobs_by_run})).digest('hex');
  if (hash !== lastHash) {
    lastHash = hash;
    process.emit('neko:workflow-sync', { reason, snapshot: snap, at: new Date().toISOString() });
  }
  return snap;
}
async function syncRepo(repo) {
  const data = await gh(`/repos/${encodeURIComponent(GITHUB_ORG)}/${encodeURIComponent(repo)}/actions/runs?per_page=${RUNS_PER_REPO}`);
  const runs = (data.workflow_runs || []).map(r => normalizeRun(r, repo));
  for (const run of runs) upsertRun(run);

  for (const run of runs) {
    const active = ['queued','in_progress','waiting','pending','requested'].includes(String(run.status));
    const jobState = db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN status<>'completed' THEN 1 ELSE 0 END) AS unfinished FROM github_live_jobs WHERE repo=? AND run_id=?`).get(repo, run.id) || {};
    const haveJobs = Number(jobState.total || 0) > 0;
    const unfinished = Number(jobState.unfinished || 0) > 0;
    // Completed runs with a fully completed cached job timeline never need to be
    // fetched again. If a run just completed while its cached job still says
    // in_progress/queued, fetch it one final time to close the timeline cleanly.
    if (!active && haveJobs && !unfinished) continue;
    try {
      const jobs = await gh(`/repos/${encodeURIComponent(GITHUB_ORG)}/${encodeURIComponent(repo)}/actions/runs/${run.id}/jobs?per_page=100`);
      for (const job of jobs.jobs || []) upsertJob(normalizeJob(job, repo, run.id));
    } catch (err) {
      console.warn(`[workflow-store] jobs ${repo}#${run.id}: ${err.message}`);
    }
  }
}
async function sync(reason='periodic', onlyRepo='') {
  if (!GITHUB_ORG || !GITHUB_TOKEN) return snapshot();
  if (syncing) return syncing;
  syncing = (async () => {
    const attempt = new Date().toISOString();
    db.prepare('UPDATE github_workflow_sync_state SET last_attempt_at=?,last_error=? WHERE singleton=1').run(attempt, '');
    try {
      const repos = onlyRepo ? [onlyRepo] : await reposToSync();
      upsertRepos(repos, attempt);
      for (const repo of repos) {
        try { await syncRepo(repo); }
        catch (err) { console.warn(`[workflow-store] ${repo}: ${err.message}`); }
      }
      const now = new Date().toISOString();
      db.prepare('UPDATE github_workflow_sync_state SET last_success_at=?,last_error=?,repos_synced=? WHERE singleton=1').run(now, '', repos.length);
      const snap = emitIfChanged(reason);
      console.log(`[workflow-store] sync ${reason}: repos=${repos.length} runs=${snap.runs.length} active_jobs=${snap.active_jobs.length}`);
      return snap;
    } catch (err) {
      db.prepare('UPDATE github_workflow_sync_state SET last_error=? WHERE singleton=1').run(err.message);
      console.warn(`[workflow-store] sync failed: ${err.message}; retaining SQLite workflow state.`);
      return snapshot();
    }
  })().finally(() => { syncing = null; });
  return syncing;
}

setTimeout(() => sync('startup').catch(() => {}), 2500).unref();
const timer = setInterval(() => sync('periodic').catch(() => {}), SYNC_SECONDS * 1000);
timer.unref();

process.on('neko:github-webhook', payload => {
  const repo = payload?.repository?.name;
  if (repo) sync('webhook', repo).catch(() => {});
});
process.on('neko:runner-sync', () => {
  const rows = db.prepare('SELECT repo,run_id,json FROM github_live_jobs').all();
  for (const row of rows) {
    const job = JSON.parse(row.json);
    const type = runnerType(job);
    if (job.runner_type !== type) { job.runner_type = type; upsertJob(job); }
  }
  emitIfChanged('runner-classification');
});

for (const signal of ['SIGTERM','SIGINT','SIGHUP']) process.once(signal, () => { try { clearInterval(timer); db.close(); } catch {} });

globalThis.__NEKO_WORKFLOW_STORE__ = { snapshot, sync };
console.log(`[workflow-store] SQLite workflow state enabled: sync=${SYNC_SECONDS}s runs/repo=${RUNS_PER_REPO}`);
