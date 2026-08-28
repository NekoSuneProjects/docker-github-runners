'use strict';

const fs = require('fs');

const file = '/app/github-workflow-store.js';
let source = fs.readFileSync(file, 'utf8');

const oldReposToSync = `async function reposToSync() {
  if (CONFIG_REPOS.length) return CONFIG_REPOS.slice(0, MAX_REPOS);
  const stored = db.prepare('SELECT name FROM github_live_repos ORDER BY last_seen_at DESC LIMIT ?').all(MAX_REPOS).map(r => r.name);
  if (stored.length) return stored;
  const data = await gh(\`/orgs/\${encodeURIComponent(GITHUB_ORG)}/repos?per_page=100&type=all&sort=pushed&direction=desc\`);
  return data.slice(0, MAX_REPOS).map(r => r.name);
}`;

const newReposToSync = `function normalizeRepoName(value) {
  const raw = String(value || '').trim().replace(/^https:\/\/github\\.com\//i, '').replace(/\\.git$/i, '');
  if (!raw) return '';
  if (!raw.includes('/')) return raw;
  const parts = raw.split('/').filter(Boolean);
  if (parts.length < 2) return '';
  if (String(parts[0]).toLowerCase() !== GITHUB_ORG.toLowerCase()) return '';
  return parts[1];
}
function activeNodeRepos() {
  try {
    const rows = db.prepare("SELECT workload_json FROM nodes WHERE workload_json IS NOT NULL AND workload_json <> ''").all();
    const repos = [];
    for (const row of rows) {
      try {
        const workload = JSON.parse(row.workload_json || '{}');
        if (!workload.active) continue;
        const repo = normalizeRepoName(workload.repository);
        if (repo) repos.push(repo);
      } catch {}
    }
    return [...new Set(repos)];
  } catch { return []; }
}
async function reposToSync() {
  const active = activeNodeRepos();
  if (CONFIG_REPOS.length) return [...new Set([...active, ...CONFIG_REPOS])].slice(0, MAX_REPOS);

  const stored = db.prepare('SELECT name FROM github_live_repos ORDER BY last_seen_at DESC LIMIT ?').all(MAX_REPOS).map(r => r.name);
  let discovered = [];
  try {
    const data = await gh(\`/orgs/\${encodeURIComponent(GITHUB_ORG)}/repos?per_page=100&type=all&sort=pushed&direction=desc\`);
    discovered = data.map(r => r.name).filter(Boolean);
  } catch (err) {
    console.warn(\`[workflow-store] repository discovery: \${err.message}; using active/SQLite repos.\`);
    if (!active.length && !stored.length) throw err;
  }

  return [...new Set([...active, ...discovered, ...stored])].slice(0, MAX_REPOS);
}`;

if (!source.includes(oldReposToSync)) throw new Error('workflow discovery patch: reposToSync anchor not found');
source = source.replace(oldReposToSync, newReposToSync);

const webhookAnchor = `process.on('neko:github-webhook', payload => {`;
const nodeListener = `const NODE_WORKFLOW_SYNC_SECONDS = Math.max(30, Math.min(Number(process.env.DASHBOARD_NODE_WORKFLOW_SYNC_SECONDS || 60), 600));
const nodeWorkflowSyncAt = new Map();
async function syncNodeWorkload(payload) {
  if (!payload?.active) return;
  const repo = normalizeRepoName(payload.repository);
  if (!repo) return;

  const now = Date.now();
  upsertRepos([repo], new Date(now).toISOString());
  const previous = Number(nodeWorkflowSyncAt.get(repo) || 0);
  if (now - previous < NODE_WORKFLOW_SYNC_SECONDS * 1000) return;
  nodeWorkflowSyncAt.set(repo, now);

  if (syncing) await syncing.catch(() => {});
  await sync('node-workload', repo);
}
process.on('neko:node-workload', payload => {
  syncNodeWorkload(payload).catch(err => console.warn(\`[workflow-store] node workload sync: \${err.message}\`));
});

${webhookAnchor}`;

if (!source.includes(webhookAnchor)) throw new Error('workflow discovery patch: webhook anchor not found');
source = source.replace(webhookAnchor, nodeListener);

fs.writeFileSync(file, source);
console.log('[dashboard-build] live workflow repository discovery patch applied');
