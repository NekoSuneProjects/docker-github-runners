'use strict';

const fs = require('fs');
const { spawn, execFile } = require('child_process');

const DASHBOARD_URL = String(process.env.DASHBOARD_URL || '').replace(/\/+$/, '');
const ACCESS_TOKEN = String(process.env.ACCESS_TOKEN || '');
const RAW_ORGS = String(process.env.GITHUB_ORGS || '').trim();
const INCLUDE = csv(process.env.GITHUB_ORG_INCLUDE);
const EXCLUDE = new Set(csv(process.env.GITHUB_ORG_EXCLUDE).map(v => v.toLowerCase()));
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

function safe(value) {
  return String(value || '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70);
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
      'User-Agent': 'neko-multi-org-fleet/1.0',
    },
  });
  if (!r.ok) throw new Error(`GitHub ${r.status} for ${pathname}: ${(await r.text()).slice(0, 220)}`);
  return r.json();
}

async function discoverOrgs() {
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

  if (INCLUDE.length) {
    const allow = new Set(INCLUDE.map(v => v.toLowerCase()));
    orgs = orgs.filter(v => allow.has(v.toLowerCase()));
  }
  orgs = orgs.filter(v => !EXCLUDE.has(v.toLowerCase()));

  const seen = new Set();
  return orgs.filter(org => {
    const key = org.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function runnerName(org) {
  return `${PREFIX}-${safe(org)}`.slice(0, 64);
}

function containerName(org) {
  return `neko-runner-${NODE_ID}-${safe(org)}`.toLowerCase().slice(0, 120);
}

async function findContainer(org) {
  const out = await exec('docker', ['ps', '-aq', '--filter', `label=neko.runner.node=${NODE_ID}`, '--filter', `label=neko.runner.org=${org}`], 15000);
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

async function ensureRunner(org) {
  let id = await findContainer(org);
  if (id) {
    if (!(await isRunning(id))) {
      console.log(`[fleet] starting ${org} runner ${id}`);
      await exec('docker', ['start', id], 60000);
    }
    return;
  }

  const name = runnerName(org);
  const cname = containerName(org);
  console.log(`[fleet] creating runner for ${org}: ${name}`);

  const args = [
    'run', '-d',
    '--name', cname,
    '--restart', 'unless-stopped',
    '--label', 'neko.runner.managed=true',
    '--label', `neko.runner.node=${NODE_ID}`,
    '--label', `neko.runner.org=${org}`,
    '--label', `neko.runner.name=${name}`,
    '-e', 'RUNNER_SCOPE=organization',
    '-e', `GITHUB_ORG=${org}`,
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
    RUNNER_IMAGE,
  ];

  await exec('docker', args, 120000);
}

async function removeUnknownRunners(desired) {
  const out = await exec('docker', ['ps', '-a', '--format', '{{.ID}} {{.Label "neko.runner.org"}}', '--filter', `label=neko.runner.node=${NODE_ID}`], 15000);
  for (const line of out.split('\n').filter(Boolean)) {
    const firstSpace = line.indexOf(' ');
    const id = firstSpace < 0 ? line : line.slice(0, firstSpace);
    const org = firstSpace < 0 ? '' : line.slice(firstSpace + 1).trim();
    if (!org || desired.has(org.toLowerCase())) continue;
    console.log(`[fleet] removing runner for no-longer-managed org ${org}`);
    await exec('docker', ['rm', '-f', id], 60000).catch(err => console.error(`[fleet] remove ${org}: ${err.output || err.message}`));
  }
}

async function reconcile() {
  if (stopping) return;
  try {
    const orgs = await discoverOrgs();
    if (!orgs.length) throw new Error('No GitHub organizations resolved. Set GITHUB_ORGS=auto or a comma-separated list.');

    await Promise.all([ensureVolume(WORK_VOLUME), ensureVolume(DIAG_VOLUME), ensureVolume(LOCK_VOLUME)]);
    const desired = new Set(orgs.map(v => v.toLowerCase()));
    await removeUnknownRunners(desired);

    for (const org of orgs) {
      try {
        await ensureRunner(org);
      } catch (err) {
        console.error(`[fleet] ${org}: ${err.output || err.message}`);
      }
    }

    console.log(`[fleet] reconciled ${orgs.length} org(s): ${orgs.join(', ')}; shared concurrency=1`);
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
    for (const id of ids) await exec('docker', ['stop', '-t', '30', id], 60000).catch(() => {});
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
  console.error('ERROR: ACCESS_TOKEN is required for multi-org fleet mode');
  process.exit(1);
}

console.log(`[fleet] multi-org mode enabled for node ${NODE_ID}; orgs=${RAW_ORGS || '(none)'}; one shared job slot`);
startAgent();
reconcile();
process.once('SIGTERM', () => stop('SIGTERM'));
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGHUP', () => stop('SIGHUP'));
