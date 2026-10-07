'use strict';

const { spawn, execFile } = require('child_process');

const DASHBOARD_URL = String(process.env.DASHBOARD_URL || '').replace(/\/+$/, '');
const ACCESS_TOKEN = String(process.env.ACCESS_TOKEN || '');

const RAW_ORGS = String(process.env.GITHUB_ORGS || '').trim();
const ORG_INCLUDE = csv(process.env.GITHUB_ORG_INCLUDE);
const ORG_EXCLUDE = lowerSet(process.env.GITHUB_ORG_EXCLUDE);

const RAW_PERSONAL_REPOS = String(process.env.GITHUB_PERSONAL_REPOS || '').trim();
const PERSONAL_INCLUDE = csv(process.env.GITHUB_PERSONAL_REPO_INCLUDE);
const PERSONAL_EXCLUDE = lowerSet(process.env.GITHUB_PERSONAL_REPO_EXCLUDE);
const INCLUDE_ARCHIVED = truthy(process.env.GITHUB_PERSONAL_INCLUDE_ARCHIVED || 'false');

const NODE_ID = safe(process.env.NODE_ID || 'node');
const PREFIX = safe(process.env.RUNNER_NAME_PREFIX || process.env.RUNNER_NAME || NODE_ID || 'neko-runner');
const RUNNER_IMAGE = String(process.env.RUNNER_IMAGE || 'ghcr.io/nekosuneprojects/docker-github-runners:latest');
const LABELS = String(process.env.LABELS || process.env.NODE_LABELS || 'docker,buildx,multiarch,builder');
const WORK_VOLUME = String(process.env.NODE_RUNNER_WORK_VOLUME || `${NODE_ID}-runner-work`);
const DIAG_VOLUME = String(process.env.NODE_RUNNER_DIAG_VOLUME || `${NODE_ID}-runner-diag`);
const LOCK_VOLUME = String(process.env.NODE_RUNNER_LOCK_VOLUME || `${NODE_ID}-runner-lock`);
const RECONCILE_SECONDS = Math.max(30, Math.min(Number(process.env.NODE_FLEET_RECONCILE_SECONDS || 120), 1800));
const LOCK_STALE_SECONDS = Math.max(3600, Number(process.env.NODE_SHARED_LOCK_STALE_SECONDS || 259200));
const UPDATE_ON_START = String(process.env.RUNNER_UPDATE_ON_START || 'true');
const ENABLE_MULTIARCH = String(process.env.ENABLE_MULTIARCH_ON_START || 'true');
const MULTIARCH_PLATFORMS = String(process.env.MULTIARCH_PLATFORMS || 'arm64,amd64');

let child = null;
let stopping = false;
let timer = null;

function csv(value) {
  return String(value || '').split(',').map(v => v.trim()).filter(Boolean);
}

function lowerSet(value) {
  return new Set(csv(value).map(v => v.toLowerCase()));
}

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || ''));
}

function safe(value) {
  return String(value || '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70);
}

function targetKey(target) {
  return target.scope === 'organization'
    ? `org:${target.org.toLowerCase()}`
    : `repo:${target.repo.toLowerCase()}`;
}

function targetLabel(target) {
  return target.scope === 'organization' ? target.org : target.repo;
}

function exec(command, args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { output: `${stdout || ''}\n${stderr || ''}`.trim() }));
      resolve(String(stdout || '') + String(stderr || ''));
    });
  });
}

async function github(pathname) {
  const r = await fetch(`https://api.github.com${pathname}`, {
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'neko-github-runner-fleet/1.1',
    },
  });
  if (!r.ok) throw new Error(`GitHub ${r.status} for ${pathname}: ${(await r.text()).slice(0, 220)}`);
  return r.json();
}

async function discoverOrgs() {
  if (!RAW_ORGS || /^(none|off|false)$/i.test(RAW_ORGS)) return [];

  let orgs;
  if (/^(auto|\*)$/i.test(RAW_ORGS)) {
    orgs = [];
    for (let page = 1; page <= 10; page++) {
      const rows = await github(`/user/memberships/orgs?state=active&per_page=100&page=${page}`);
      if (!Array.isArray(rows) || !rows.length) break;
      for (const row of rows) {
        if (row?.role === 'admin' && row?.organization?.login) orgs.push(row.organization.login);
      }
      if (rows.length < 100) break;
    }
  } else {
    orgs = csv(RAW_ORGS);
  }

  if (ORG_INCLUDE.length) {
    const allow = new Set(ORG_INCLUDE.map(v => v.toLowerCase()));
    orgs = orgs.filter(v => allow.has(v.toLowerCase()));
  }
  orgs = orgs.filter(v => !ORG_EXCLUDE.has(v.toLowerCase()));

  const seen = new Set();
  return orgs.filter(org => {
    const key = org.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(org => ({ scope: 'organization', org }));
}

async function discoverPersonalRepos() {
  if (!RAW_PERSONAL_REPOS || /^(none|off|false)$/i.test(RAW_PERSONAL_REPOS)) return [];

  let repos = [];
  if (/^(auto|\*)$/i.test(RAW_PERSONAL_REPOS)) {
    const me = await github('/user');
    const login = String(me?.login || '').trim();
    if (!login) throw new Error('GitHub /user did not return a login for personal repository discovery');

    for (let page = 1; page <= 20; page++) {
      const rows = await github(`/user/repos?affiliation=owner&visibility=all&sort=full_name&direction=asc&per_page=100&page=${page}`);
      if (!Array.isArray(rows) || !rows.length) break;

      for (const row of rows) {
        const fullName = String(row?.full_name || '').trim();
        const owner = String(row?.owner?.login || '').trim();
        if (!fullName || owner.toLowerCase() !== login.toLowerCase()) continue;
        if (!INCLUDE_ARCHIVED && row?.archived === true) continue;
        repos.push(fullName);
      }

      if (rows.length < 100) break;
    }
  } else {
    repos = csv(RAW_PERSONAL_REPOS).map(value => {
      const trimmed = value.replace(/^https:\/\/github\.com\//i, '').replace(/\.git$/i, '');
      return trimmed;
    });
  }

  if (PERSONAL_INCLUDE.length) {
    const allow = new Set(PERSONAL_INCLUDE.map(v => v.toLowerCase()));
    repos = repos.filter(full => {
      const short = full.split('/').pop().toLowerCase();
      return allow.has(full.toLowerCase()) || allow.has(short);
    });
  }

  repos = repos.filter(full => {
    const short = full.split('/').pop().toLowerCase();
    return !PERSONAL_EXCLUDE.has(full.toLowerCase()) && !PERSONAL_EXCLUDE.has(short);
  });

  const seen = new Set();
  return repos.filter(repo => {
    const key = repo.toLowerCase();
    if (!repo.includes('/') || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(repo => ({ scope: 'repository', repo }));
}

async function discoverTargets() {
  const [orgTargets, personalTargets] = await Promise.all([
    discoverOrgs(),
    discoverPersonalRepos(),
  ]);
  return [...orgTargets, ...personalTargets];
}

function runnerName(target) {
  const suffix = target.scope === 'organization'
    ? `org-${safe(target.org)}`
    : `repo-${safe(target.repo.replace('/', '-'))}`;
  return `${PREFIX}-${suffix}`.slice(0, 64);
}

function containerName(target) {
  const suffix = target.scope === 'organization'
    ? `org-${safe(target.org)}`
    : `repo-${safe(target.repo.replace('/', '-'))}`;
  return `neko-runner-${NODE_ID}-${suffix}`.toLowerCase().slice(0, 120);
}

async function findContainer(target) {
  const out = await exec('docker', [
    'ps', '-aq',
    '--filter', `label=neko.runner.node=${NODE_ID}`,
    '--filter', `label=neko.runner.target=${targetKey(target)}`,
  ], 15000);
  return out.trim().split('\n').filter(Boolean)[0] || '';
}

async function isRunning(id) {
  if (!id) return false;
  try {
    return (await exec('docker', ['inspect', '-f', '{{.State.Running}}', id], 15000)).trim() === 'true';
  } catch {
    return false;
  }
}

async function ensureVolume(name) {
  try {
    await exec('docker', ['volume', 'inspect', name], 15000);
  } catch {
    await exec('docker', ['volume', 'create', name], 15000);
  }
}

async function ensureRunner(target) {
  let id = await findContainer(target);
  if (id) {
    if (!(await isRunning(id))) {
      console.log(`[fleet] starting ${targetKey(target)} runner ${id}`);
      await exec('docker', ['start', id], 60000);
    }
    return;
  }

  const name = runnerName(target);
  const cname = containerName(target);
  console.log(`[fleet] creating runner for ${targetKey(target)}: ${name}`);

  const args = [
    'run', '-d',
    '--name', cname,
    '--restart', 'unless-stopped',
    '--label', 'neko.runner.managed=true',
    '--label', `neko.runner.node=${NODE_ID}`,
    '--label', `neko.runner.target=${targetKey(target)}`,
    '--label', `neko.runner.scope=${target.scope}`,
    '--label', `neko.runner.name=${name}`,
    '-e', `RUNNER_SCOPE=${target.scope}`,
    '-e', `ACCESS_TOKEN=${ACCESS_TOKEN}`,
    '-e', `RUNNER_NAME=${name}`,
    '-e', `LABELS=${LABELS}`,
    '-e', `RUNNER_UPDATE_ON_START=${UPDATE_ON_START}`,
    '-e', `ENABLE_MULTIARCH_ON_START=${ENABLE_MULTIARCH}`,
    '-e', `MULTIARCH_PLATFORMS=${MULTIARCH_PLATFORMS}`,
    '-e', 'NODE_SHARED_JOB_LOCK=true',
    '-e', 'NODE_SHARED_LOCK_DIR=/runner-lock',
    '-e', `NODE_SHARED_LOCK_STALE_SECONDS=${LOCK_STALE_SECONDS}`,
    '-v', '/var/run/docker.sock:/var/run/docker.sock',
    '-v', `${WORK_VOLUME}:/work`,
    '-v', `${DIAG_VOLUME}:/actions-runner/_diag`,
    '-v', `${LOCK_VOLUME}:/runner-lock`,
  ];

  if (target.scope === 'organization') {
    args.push('-e', `GITHUB_ORG=${target.org}`);
  } else {
    args.push('-e', `REPO_URL=https://github.com/${target.repo}`);
  }

  args.push(RUNNER_IMAGE);
  await exec('docker', args, 120000);
}

async function removeUnknownRunners(desired) {
  const out = await exec('docker', [
    'ps', '-a',
    '--format', '{{.ID}} {{.Label "neko.runner.target"}}',
    '--filter', `label=neko.runner.node=${NODE_ID}`,
  ], 15000);

  for (const line of out.split('\n').filter(Boolean)) {
    const firstSpace = line.indexOf(' ');
    const id = firstSpace < 0 ? line : line.slice(0, firstSpace);
    const target = firstSpace < 0 ? '' : line.slice(firstSpace + 1).trim().toLowerCase();
    if (!target || desired.has(target)) continue;
    console.log(`[fleet] removing runner for no-longer-managed target ${target}`);
    await exec('docker', ['rm', '-f', id], 60000)
      .catch(err => console.error(`[fleet] remove ${target}: ${err.output || err.message}`));
  }
}

async function reconcile() {
  if (stopping) return;
  try {
    const targets = await discoverTargets();
    if (!targets.length) {
      throw new Error('No GitHub targets resolved. Configure GITHUB_ORGS and/or GITHUB_PERSONAL_REPOS.');
    }

    await Promise.all([
      ensureVolume(WORK_VOLUME),
      ensureVolume(DIAG_VOLUME),
      ensureVolume(LOCK_VOLUME),
    ]);

    const desired = new Set(targets.map(targetKey));
    await removeUnknownRunners(desired);

    for (const target of targets) {
      try {
        await ensureRunner(target);
      } catch (err) {
        console.error(`[fleet] ${targetKey(target)}: ${err.output || err.message}`);
      }
    }

    const orgCount = targets.filter(v => v.scope === 'organization').length;
    const repoCount = targets.filter(v => v.scope === 'repository').length;
    console.log(`[fleet] reconciled ${targets.length} target(s): ${orgCount} org(s), ${repoCount} personal repo(s); shared concurrency=1`);
  } catch (err) {
    console.error(`[fleet] reconcile failed: ${err.output || err.message}`);
  } finally {
    if (!stopping) timer = setTimeout(reconcile, RECONCILE_SECONDS * 1000);
  }
}

function startAgent() {
  if (child || stopping) return;
  const env = {
    ...process.env,
    RUNNER_NAME: process.env.RUNNER_NAME || PREFIX,
    GITHUB_ORG: '',
    REPO_URL: '',
    RUNNER_SCOPE: 'organization',
  };
  child = spawn(process.execPath, ['/app/agent.js'], { stdio: 'inherit', env });
  console.log(`[fleet] node agent started pid=${child.pid}`);
  child.once('exit', (code, signal) => {
    child = null;
    if (stopping) return;
    console.error(`[fleet] node agent exited code=${code} signal=${signal || 'none'}; restarting in 2s`);
    setTimeout(startAgent, 2000);
  });
}

async function stopFleet() {
  try {
    const out = await exec('docker', ['ps', '-q', '--filter', `label=neko.runner.node=${NODE_ID}`], 15000);
    const ids = out.trim().split('\n').filter(Boolean);
    for (const id of ids) {
      await exec('docker', ['stop', '-t', '30', id], 60000).catch(() => {});
    }
  } catch {}
}

function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[fleet] ${signal}: stopping`);
  if (timer) clearTimeout(timer);
  if (child) child.kill('SIGTERM');
  stopFleet().finally(() => setTimeout(() => process.exit(0), 100).unref());
}

if (!ACCESS_TOKEN) {
  console.error('ERROR: ACCESS_TOKEN is required for GitHub runner fleet mode');
  process.exit(1);
}

console.log(
  `[fleet] mode enabled for node ${NODE_ID}; orgs=${RAW_ORGS || 'off'}; personal-repos=${RAW_PERSONAL_REPOS || 'off'}; one shared job slot`,
);
startAgent();
reconcile();
process.once('SIGTERM', () => stop('SIGTERM'));
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGHUP', () => stop('SIGHUP'));
