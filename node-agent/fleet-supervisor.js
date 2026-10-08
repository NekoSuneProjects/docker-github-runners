'use strict';

const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');

const DASHBOARD_URL = String(process.env.DASHBOARD_URL || '').replace(/\/+$/, '');
const NODE_TOKEN = String(process.env.DASHBOARD_NODE_SHARED_SECRET || '');

let credentialLease = null;
const NODE_ID = safe(process.env.NODE_ID || 'node');
const PREFIX = safe(process.env.RUNNER_NAME_PREFIX || process.env.RUNNER_NAME || NODE_ID || 'neko-runner');
const RUNNER_IMAGE = String(process.env.RUNNER_IMAGE || 'ghcr.io/nekosuneprojects/docker-github-runners:latest');
const LABELS = String(process.env.LABELS || process.env.NODE_LABELS || 'docker,buildx,multiarch,builder');
const WORK_VOLUME = String(process.env.NODE_RUNNER_WORK_VOLUME || `${NODE_ID}-runner-work`);
const DIAG_VOLUME = String(process.env.NODE_RUNNER_DIAG_VOLUME || `${NODE_ID}-runner-diag`);
const SLOT_OVERRIDE = Math.max(0, Number(process.env.NODE_MAX_CONCURRENT_JOBS || 0));
let remoteSlotPolicy = null;
const SLOT_RAM_GB = Math.max(1, Number(process.env.NODE_SLOT_RAM_GB || 4));
const SLOT_CPU_CORES = Math.max(1, Number(process.env.NODE_SLOT_CPU_CORES || 2));
const ROTATE_MS = Math.max(60000, Number(process.env.NODE_SLOT_ROTATE_SECONDS || 600) * 1000);
let lastRotation = 0;
let rotationCursor = 0;
const RECONCILE_SECONDS = Math.max(30, Math.min(Number(process.env.NODE_FLEET_RECONCILE_SECONDS || 120), 1800));
const UPDATE_ON_START = String(process.env.RUNNER_UPDATE_ON_START || 'true');
const ENABLE_MULTIARCH = String(process.env.ENABLE_MULTIARCH_ON_START || 'true');
const MULTIARCH_PLATFORMS = String(process.env.MULTIARCH_PLATFORMS || 'arm64,amd64');

const CAPACITY_OVERRIDE = String(process.env.NODE_CAPACITY_CLASS || 'auto').trim().toLowerCase();
const GPU_OVERRIDE = String(process.env.NODE_GPU || 'auto').trim().toLowerCase();
const SMALL_MAX_CPU = Math.max(1, Number(process.env.NODE_SMALL_MAX_CPU || 2));
const SMALL_MAX_RAM_GB = Math.max(1, Number(process.env.NODE_SMALL_MAX_RAM_GB || 4));
const LARGE_MIN_CPU = Math.max(2, Number(process.env.NODE_LARGE_MIN_CPU || 8));
const LARGE_MIN_RAM_GB = Math.max(4, Number(process.env.NODE_LARGE_MIN_RAM_GB || 16));

const API_VERSION = '2022-11-28';
const installationIdCache = new Map();
const installationTokenCache = new Map();

let child = null;
let stopping = false;
let timer = null;

function csv(value) {
  return String(value || '').split(',').map(v => v.trim()).filter(Boolean);
}
function safe(value) {
  return String(value || '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70);
}
function readHostText(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } }
function hostCpuCount() {
  const text = readHostText('/host/proc/cpuinfo');
  const count = text.split('\n').filter(line => /^processor\s*:/i.test(line)).length;
  return count || os.cpus().length || 1;
}
function hostMemoryBytes() {
  const text = readHostText('/host/proc/meminfo');
  const match = /^MemTotal:\s+(\d+)\s+kB/im.exec(text);
  if (match) return Number(match[1]) * 1024;
  return os.totalmem();
}
function exec(command, args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { output: `${stdout || ''}\n${stderr || ''}`.trim() }));
      resolve(String(stdout || '') + String(stderr || ''));
    });
  });
}

async function getCredentialLease(force = false) {
  const now = Date.now();
  if (!force && credentialLease) {
    const expires = credentialLease.expires_at ? Date.parse(credentialLease.expires_at) : Number.POSITIVE_INFINITY;
    if (!Number.isFinite(expires) || expires - now > 60000) return credentialLease;
  }

  const r = await fetch(`${DASHBOARD_URL}/internal/github/lease`, {
    headers: {
      Authorization: `Bearer ${NODE_TOKEN}`,
      Accept: 'application/json',
      'User-Agent': 'neko-runner-agent/3.1',
    },
  });
  const raw = await r.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch {}
  if (!r.ok) throw new Error(`dashboard credential lease ${r.status}: ${data.error || raw.slice(0, 500) || r.statusText}`);
  if (!['app','token'].includes(data.mode) || !data.token) throw new Error('dashboard returned an invalid GitHub credential lease');
  credentialLease = data;
  return credentialLease;
}

async function githubFetch(apiPath, options = {}) {
  const lease = await getCredentialLease();
  const token = options.token || lease.token;
  const r = await fetch(`https://api.github.com${apiPath}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': 'neko-runner-agent/3.1',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const raw = await r.text();
  if (!r.ok) {
    if (r.status === 401 && !options.token) credentialLease = null;
    throw new Error(`GitHub API ${r.status}: ${raw.slice(0, 500) || r.statusText}`);
  }
  if (r.status === 204 || !raw) return {};
  return JSON.parse(raw);
}
async function listAppInstallations() {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const rows = await githubFetch(`/app/installations?per_page=100&page=${page}`);
    if (!Array.isArray(rows) || !rows.length) break;
    out.push(...rows);
    if (rows.length < 100) break;
  }
  return out;
}
async function installationIdForTarget(target) {
  const key = targetKey(target);
  if (installationIdCache.has(key)) return installationIdCache.get(key);
  let data;
  if (target.scope === 'organization') {
    data = await githubFetch(`/orgs/${encodeURIComponent(target.org)}/installation`);
  } else {
    const [owner, repo] = target.repo.split('/');
    data = await githubFetch(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`);
  }
  if (!data?.id) throw new Error(`No GitHub App installation found for ${key}`);
  installationIdCache.set(key, data.id);
  return data.id;
}
async function installationTokenById(id) {
  const key = String(id);
  const cached = installationTokenCache.get(key);
  if (cached && cached.expiresAt - Date.now() > 5 * 60 * 1000) return cached.token;
  const data = await githubFetch(`/app/installations/${id}/access_tokens`, { method: 'POST' });
  if (!data?.token) throw new Error('GitHub did not return an installation token');
  const expiresAt = Date.parse(data.expires_at || '') || Date.now() + 55 * 60 * 1000;
  installationTokenCache.set(key, { token: data.token, expiresAt });
  return data.token;
}
async function tokenForTarget(target) {
  const lease = await getCredentialLease();
  if (lease.mode !== 'app') return lease.token;
  return installationTokenById(await installationIdForTarget(target));
}
function targetApiBase(target) {
  if (target.scope === 'organization') return `/orgs/${encodeURIComponent(target.org)}`;
  const [owner, repo] = target.repo.split('/');
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}
async function discoverTargets() {
  const targets = [];
  const lease = await getCredentialLease();
  const policy = lease.policy || {};
  const GITHUB_AUTH_MODE = lease.mode;
  const GITHUB_ORGS = String(policy.orgs || 'auto').trim();
  const GITHUB_ORG_INCLUDE = csv(policy.org_include);
  const GITHUB_ORG_EXCLUDE = new Set(csv(policy.org_exclude).map(v => v.toLowerCase()));
  const GITHUB_PERSONAL_REPOS = String(policy.personal_repos || 'auto').trim();
  const GITHUB_PERSONAL_REPO_INCLUDE = csv(policy.personal_repo_include);
  const GITHUB_PERSONAL_REPO_EXCLUDE = new Set(csv(policy.personal_repo_exclude).map(v => v.toLowerCase()));
  const GITHUB_PERSONAL_INCLUDE_ARCHIVED = policy.personal_include_archived === true;

  if (GITHUB_ORGS && !/^(none|off|false)$/i.test(GITHUB_ORGS)) {
    let orgs = [];
    if (/^(auto|\*)$/i.test(GITHUB_ORGS)) {
      if (GITHUB_AUTH_MODE === 'app') {
        for (const installation of await listAppInstallations()) {
          if (installation?.account?.type === 'Organization' && installation?.account?.login) {
            orgs.push(installation.account.login);
            installationIdCache.set(`org:${installation.account.login.toLowerCase()}`, installation.id);
          }
        }
      } else {
        for (let page = 1; page <= 10; page++) {
          const rows = await githubFetch(`/user/memberships/orgs?state=active&per_page=100&page=${page}`);
          if (!Array.isArray(rows) || !rows.length) break;
          for (const row of rows) if (row?.role === 'admin' && row?.organization?.login) orgs.push(row.organization.login);
          if (rows.length < 100) break;
        }
      }
    } else {
      orgs = csv(GITHUB_ORGS);
    }
    if (GITHUB_ORG_INCLUDE.length) {
      const allow = new Set(GITHUB_ORG_INCLUDE.map(v => v.toLowerCase()));
      orgs = orgs.filter(v => allow.has(v.toLowerCase()));
    }
    orgs = [...new Set(orgs.filter(v => !GITHUB_ORG_EXCLUDE.has(v.toLowerCase())))];
    for (const org of orgs) targets.push({ scope: 'organization', org });
  }

  if (GITHUB_PERSONAL_REPOS && !/^(none|off|false)$/i.test(GITHUB_PERSONAL_REPOS)) {
    let repos = [];
    if (/^(auto|\*)$/i.test(GITHUB_PERSONAL_REPOS)) {
      if (GITHUB_AUTH_MODE === 'app') {
        for (const installation of await listAppInstallations()) {
          if (installation?.account?.type !== 'User' || !installation?.id) continue;
          const token = await installationTokenById(installation.id);
          for (let page = 1; page <= 20; page++) {
            const data = await githubFetch(`/installation/repositories?per_page=100&page=${page}`, { token });
            const rows = Array.isArray(data?.repositories) ? data.repositories : [];
            if (!rows.length) break;
            for (const row of rows) {
              const fullName = String(row?.full_name || '').trim();
              if (!fullName || (!GITHUB_PERSONAL_INCLUDE_ARCHIVED && row?.archived)) continue;
              repos.push(fullName);
              installationIdCache.set(`repo:${fullName.toLowerCase()}`, installation.id);
            }
            if (rows.length < 100) break;
          }
        }
      } else {
        for (let page = 1; page <= 20; page++) {
          const rows = await githubFetch(`/user/repos?affiliation=owner&visibility=all&sort=full_name&direction=asc&per_page=100&page=${page}`);
          if (!Array.isArray(rows) || !rows.length) break;
          for (const row of rows) {
            const fullName = String(row?.full_name || '').trim();
            if (!fullName || (!GITHUB_PERSONAL_INCLUDE_ARCHIVED && row?.archived)) continue;
            repos.push(fullName);
          }
          if (rows.length < 100) break;
        }
      }
    } else {
      repos = csv(GITHUB_PERSONAL_REPOS);
    }
    if (GITHUB_PERSONAL_REPO_INCLUDE.length) {
      const allow = new Set(GITHUB_PERSONAL_REPO_INCLUDE.map(v => v.toLowerCase()));
      repos = repos.filter(full => allow.has(full.toLowerCase()) || allow.has(full.split('/').pop().toLowerCase()));
    }
    repos = [...new Set(repos.filter(full => !GITHUB_PERSONAL_REPO_EXCLUDE.has(full.toLowerCase()) && !GITHUB_PERSONAL_REPO_EXCLUDE.has(full.split('/').pop().toLowerCase())))];
    for (const repo of repos) targets.push({ scope: 'repository', repo });
  }

  return targets;
}
async function listRunners(target) {
  const token = await tokenForTarget(target);
  const base = targetApiBase(target);
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const data = await githubFetch(`${base}/actions/runners?per_page=100&page=${page}`, { token });
    const rows = Array.isArray(data?.runners) ? data.runners : [];
    all.push(...rows);
    if (rows.length < 100) break;
  }
  return { token, base, runners: all };
}
async function prepareRunner(target, name) {
  const { token, base, runners } = await listRunners(target);
  const stale = runners.find(r => r.name === name);
  if (stale) await githubFetch(`${base}/actions/runners/${stale.id}`, { method: 'DELETE', token });
  const registration = await githubFetch(`${base}/actions/runners/registration-token`, { method: 'POST', token });
  if (!registration?.token) throw new Error(`GitHub did not return a registration token for ${targetKey(target)}`);
  return {
    config_url: target.scope === 'organization' ? `https://github.com/${target.org}` : `https://github.com/${target.repo}`,
    registration_token: registration.token,
  };
}
async function syncLabels(target, name, labels) {
  const { token, base, runners } = await listRunners(target);
  const runner = runners.find(r => r.name === name);
  if (!runner) throw new Error(`Runner ${name} is not registered yet`);
  await githubFetch(`${base}/actions/runners/${runner.id}/labels`, {
    method: 'PUT',
    token,
    body: { labels },
  });
}
async function removeRemoteRunner(target, name) {
  try {
    const { token, base, runners } = await listRunners(target);
    const runner = runners.find(r => r.name === name);
    if (runner) await githubFetch(`${base}/actions/runners/${runner.id}`, { method: 'DELETE', token });
  } catch (err) {
    console.warn(`[fleet] remote remove ${targetKey(target)}: ${err.message}`);
  }
}

async function remoteRunnerBusy(target, name) {
  // Never evict a runner unless GitHub positively confirms it is idle.
  const { runners } = await listRunners(target);
  const runner = runners.find(r => r.name === name);
  return runner ? Boolean(runner.busy) : false;
}
async function refreshSlotPolicy() {
  try {
    const r = await fetch(`${DASHBOARD_URL}/internal/nodes/scheduling?id=${encodeURIComponent(NODE_ID)}`, {
      headers: { Authorization: `Bearer ${NODE_TOKEN}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw Error(`dashboard scheduling policy HTTP ${r.status}`);
    const data = await r.json();
    remoteSlotPolicy = data.policy || null;
  } catch (err) {
    console.warn(`[fleet] keeping previous capacity policy: ${err.message}`);
  }
}
function slotCapacity(caps) {
  // Reserve system resources. Each runner takes one GitHub job at a time.
  const cpuSlots = Math.max(1, Math.floor(Math.max(1, caps.cpu - 1) / (remoteSlotPolicy?.cpu_per_slot || SLOT_CPU_CORES)));
  const ramSlots = Math.max(1, Math.floor(Math.max(1, caps.ram_gb - 2) / (remoteSlotPolicy?.ram_gb_per_slot || SLOT_RAM_GB)));
  return Math.max(1, Math.min((remoteSlotPolicy?.max_slots ?? SLOT_OVERRIDE) || Infinity, cpuSlots, ramSlots));
}
async function managedStates(targets) {
  const results = [];
  for (const target of targets) {
    const id = await findContainer(target);
    if (!id || !(await isRunning(id))) continue;
    const name = runnerName(target);
    let busy = true; // API uncertainty must never evict a running job.
    try { busy = await remoteRunnerBusy(target, name); }
    catch (error) { console.warn(`[fleet] runner status unknown for ${name}: ${error.message}`); }
    results.push({ target, id, name, busy });
  }
  return results;
}
async function removeIdleRunner(state) {
  if (await remoteRunnerBusy(state.target, state.name)) return false;
  // Recheck immediately before eviction; no forced interruption of known busy jobs.
  await exec('docker', ['stop', '-t', '30', state.id], 60000);
  await exec('docker', ['rm', state.id], 60000);
  await removeRemoteRunner(state.target, state.name);
  return true;
}
async function detectGpu() {
  if (/^(1|true|yes|on|gpu|nvidia)$/i.test(GPU_OVERRIDE)) return true;
  if (/^(0|false|no|off|none)$/i.test(GPU_OVERRIDE)) return false;
  try {
    const runtimes = await exec('docker', ['info', '--format', '{{json .Runtimes}}'], 15000);
    if (/nvidia/i.test(runtimes)) return true;
  } catch {}
  return false;
}
async function detectCapabilities() {
  const cpu = hostCpuCount();
  const memoryBytes = hostMemoryBytes();
  const ramGb = memoryBytes / (1024 ** 3);
  const gpu = await detectGpu();
  let size = CAPACITY_OVERRIDE;
  if (!['small', 'medium', 'large'].includes(size)) {
    if (cpu <= SMALL_MAX_CPU || ramGb <= SMALL_MAX_RAM_GB) size = 'small';
    else if (cpu >= LARGE_MIN_CPU && ramGb >= LARGE_MIN_RAM_GB) size = 'large';
    else size = 'medium';
  }
  const labels = new Set(csv(LABELS));
  labels.add(`neko-size-${size}`);
  labels.add('neko-any');
  if (size === 'small') labels.add('neko-lite');
  if (size === 'medium' || size === 'large') labels.add('neko-build');
  if (size === 'large') labels.add('neko-heavy');
  if (gpu) labels.add('neko-gpu');
  return {
    cpu, memory_bytes: memoryBytes, ram_gb: Number(ramGb.toFixed(1)), size, gpu,
    labels: [...labels],
    fingerprint: `${size}|${gpu ? 'gpu' : 'cpu'}|${[...labels].sort().join(',')}`,
  };
}
function targetKey(target) {
  return target.scope === 'organization' ? `org:${target.org.toLowerCase()}` : `repo:${target.repo.toLowerCase()}`;
}
function targetFromKey(key) {
  const value = String(key || '');
  if (value.startsWith('org:') && value.slice(4)) return { scope: 'organization', org: value.slice(4) };
  if (value.startsWith('repo:') && value.slice(5).includes('/')) return { scope: 'repository', repo: value.slice(5) };
  return null;
}
function runnerName(target) {
  const suffix = target.scope === 'organization' ? `org-${safe(target.org)}` : `repo-${safe(target.repo.replace('/', '-'))}`;
  return `${PREFIX}-${suffix}`.slice(0, 64);
}
function containerName(target) {
  const suffix = target.scope === 'organization' ? `org-${safe(target.org)}` : `repo-${safe(target.repo.replace('/', '-'))}`;
  return `neko-runner-${NODE_ID}-${suffix}`.toLowerCase().slice(0, 120);
}
async function existingRunnerFingerprint(id) {
  if (!id) return '';
  try { return (await exec('docker', ['inspect', '-f', '{{ index .Config.Labels "neko.runner.capability-fingerprint" }}', id], 15000)).trim(); }
  catch { return ''; }
}
async function findContainer(target) {
  const out = await exec('docker', ['ps', '-aq', '--filter', `label=neko.runner.node=${NODE_ID}`, '--filter', `label=neko.runner.target=${targetKey(target)}`], 15000);
  return out.trim().split('\n').filter(Boolean)[0] || '';
}
async function isRunning(id) {
  if (!id) return false;
  try { return (await exec('docker', ['inspect', '-f', '{{.State.Running}}', id], 15000)).trim() === 'true'; }
  catch { return false; }
}
async function ensureVolume(name) {
  try { await exec('docker', ['volume', 'inspect', name], 15000); }
  catch { await exec('docker', ['volume', 'create', name], 15000); }
}
async function ensureRunner(target, capabilities) {
  let id = await findContainer(target);
  const name = runnerName(target);
  if (id) {
    const fingerprint = await existingRunnerFingerprint(id);
    if (fingerprint !== capabilities.fingerprint) {
      console.log(`[fleet] recreating ${targetKey(target)}: capacity labels changed`);
      if (await remoteRunnerBusy(target, name)) {
        console.log(`[fleet] deferring image/label change for busy runner ${name}`);
        return;
      }
      await exec('docker', ['rm', '-f', id], 60000);
      await removeRemoteRunner(target, name);
      id = '';
    } else if (await isRunning(id)) {
      await syncLabels(target, name, capabilities.labels);
      return;
    } else {
      console.log(`[fleet] recreating stopped runner ${targetKey(target)} with fresh registration token`);
      await exec('docker', ['rm', '-f', id], 60000);
      await removeRemoteRunner(target, name);
      id = '';
    }
  }

  const prepared = await prepareRunner(target, name);
  const cname = containerName(target);
  console.log(`[fleet] creating GitHub runner for ${targetKey(target)}: ${name}`);

  const args = [
    'run', '-d', '--name', cname, '--restart', 'no',
    '--label', 'neko.runner.managed=true',
    '--label', `neko.runner.node=${NODE_ID}`,
    '--label', `neko.runner.target=${targetKey(target)}`,
    '--label', `neko.runner.scope=${target.scope}`,
    '--label', `neko.runner.name=${name}`,
    '--label', `neko.runner.capacity=${capabilities.size}`,
    '--label', `neko.runner.gpu=${capabilities.gpu ? 'true' : 'false'}`,
    '--label', `neko.runner.capability-fingerprint=${capabilities.fingerprint}`,
    '-e', 'RUNNER_AUTH_MODE=broker',
    '-e', `RUNNER_REGISTRATION_TOKEN=${prepared.registration_token}`,
    '-e', `RUNNER_CONFIG_URL=${prepared.config_url}`,
    '-e', `RUNNER_SCOPE=${target.scope}`,
    '-e', `RUNNER_NAME=${name}`,
    '-e', `LABELS=${capabilities.labels.join(',')}`,
    '-e', `RUNNER_UPDATE_ON_START=${UPDATE_ON_START}`,
    '-e', `ENABLE_MULTIARCH_ON_START=${ENABLE_MULTIARCH}`,
    '-e', `MULTIARCH_PLATFORMS=${MULTIARCH_PLATFORMS}`,
    '-v', '/var/run/docker.sock:/var/run/docker.sock',
    '-v', `${WORK_VOLUME}:/work`,
    '-v', `${DIAG_VOLUME}:/actions-runner/_diag`,
  ];
  if (target.scope === 'organization') args.push('-e', `GITHUB_ORG=${target.org}`);
  else args.push('-e', `REPO_URL=https://github.com/${target.repo}`);
  args.push(RUNNER_IMAGE);
  await exec('docker', args, 120000);

  for (let attempt = 0; attempt < 10; attempt++) {
    try { await syncLabels(target, name, capabilities.labels); break; }
    catch (err) {
      if (attempt === 9) throw err;
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }
}
async function removeUnknownRunners(desired, targetByKey) {
  const out = await exec('docker', ['ps', '-a', '--format', '{{.ID}} {{.Label "neko.runner.target"}} {{.Label "neko.runner.name"}}', '--filter', `label=neko.runner.node=${NODE_ID}`], 15000);
  for (const line of out.split('\n').filter(Boolean)) {
    const parts = line.split(' ');
    const id = parts.shift();
    const key = String(parts.shift() || '').trim().toLowerCase();
    const name = String(parts.join(' ') || '').trim();
    if (!key || desired.has(key)) continue;
    console.log(`[fleet] checking no-longer-managed runner ${key}`);
    const target = targetByKey.get(key) || targetFromKey(key);
    if (!target || !name) continue;
    try {
      if (await remoteRunnerBusy(target, name)) continue;
      await exec('docker', ['rm', '-f', id], 60000);
      await removeRemoteRunner(target, name);
    } catch (err) {
      console.warn(`[fleet] preserving ${name} on uncertain status: ${err.message}`);
    }
  }
}
async function reconcile() {
  if (stopping) return;
  try {
    const capabilities = await detectCapabilities();
    await refreshSlotPolicy();
    const targets = await discoverTargets();
    if (!targets.length) throw new Error('Agent discovered no GitHub runner targets');
    await Promise.all([ensureVolume(WORK_VOLUME), ensureVolume(DIAG_VOLUME)]);
    const desired = new Set(targets.map(targetKey));
    const targetByKey = new Map(targets.map(t => [targetKey(t), t]));
    await removeUnknownRunners(desired, targetByKey);
    const capacity = slotCapacity(capabilities);
    let states = await managedStates(targets);
    const busyStates = states.filter(s => s.busy);
    if (Date.now() - lastRotation >= ROTATE_MS) {
      lastRotation = Date.now();
      rotationCursor = (rotationCursor + 1) % targets.length;
    }
    // Keep busy jobs, then allocate remaining slots round-robin among scopes.
    const rotated = [...targets.slice(rotationCursor), ...targets.slice(0, rotationCursor)];
    const selected = new Set(busyStates.map(s => targetKey(s.target)));
    for (const target of rotated) {
      if (selected.size >= Math.max(capacity, busyStates.length)) break;
      selected.add(targetKey(target));
    }
    for (const state of states) {
      if (selected.has(targetKey(state.target)) || state.busy) continue;
      try { await removeIdleRunner(state); }
      catch (err) { console.warn(`[fleet] cannot evict ${state.name}: ${err.output || err.message}; reserving slot`); }
    }
    states = await managedStates(targets);
    let slotsRemaining = Math.max(0, capacity - states.length);
    for (const target of rotated) {
      if (!selected.has(targetKey(target))) continue;
      try {
        if (states.some(s => targetKey(s.target) === targetKey(target))) {
          await ensureRunner(target, capabilities);
        } else if (slotsRemaining > 0) {
          await ensureRunner(target, capabilities);
          slotsRemaining--;
        }
      } catch (err) { console.error(`[fleet] ${targetKey(target)}: ${err.output || err.message}`); }
    }
    console.log(`[fleet] slots: capacity=${capacity} active=${states.length} busy=${busyStates.length} reserved=${slotsRemaining}; round-robin cursor=${rotationCursor}`);
    const orgCount = targets.filter(v => v.scope === 'organization').length;
    const repoCount = targets.filter(v => v.scope === 'repository').length;
    console.log(`[fleet] reconciled ${targets.length} target(s): ${orgCount} org(s), ${repoCount} personal repo(s); node=${capabilities.size} cpu=${capabilities.cpu} ram=${capabilities.ram_gb}GB gpu=${capabilities.gpu}; slot capacity=${slotCapacity(capabilities)}`);
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
    ACCESS_TOKEN: '',
    GITHUB_APP_ID: '',
    GITHUB_APP_PRIVATE_KEY: '',
    GITHUB_APP_PRIVATE_KEY_BASE64: '',
    GITHUB_ORG: '',
    REPO_URL: '',
    RUNNER_SCOPE: 'organization',
    RUNNER_NAME: process.env.RUNNER_NAME || PREFIX,
  };
  child = spawn(process.execPath, ['/app/agent.js'], { stdio: 'inherit', env });
  console.log(`[fleet] dashboard heartbeat agent started pid=${child.pid}`);
  child.once('exit', (code, signal) => {
    child = null;
    if (stopping) return;
    console.error(`[fleet] heartbeat agent exited code=${code} signal=${signal || 'none'}; restarting in 2s`);
    setTimeout(startAgent, 2000);
  });
}
async function stopFleet() {
  try {
    const targets = await discoverTargets().catch(() => []);
    const out = await exec('docker', ['ps', '-a', '--format', '{{.ID}} {{.Label "neko.runner.target"}} {{.Label "neko.runner.name"}}', '--filter', `label=neko.runner.node=${NODE_ID}`], 15000);
    for (const line of out.split('\n').filter(Boolean)) {
      const parts = line.split(' ');
      const id = parts.shift();
      const key = String(parts.shift() || '');
      const name = String(parts.join(' ') || '');
      await exec('docker', ['stop', '-t', '30', id], 60000).catch(() => {});
      const target = targets.find(t => targetKey(t) === key) || targetFromKey(key);
      if (target && name) await removeRemoteRunner(target, name);
    }
  } catch {}
}
function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[fleet] ${signal}: stopping`);
  if (timer) clearTimeout(timer);
  if (child) child.kill('SIGTERM');
  // Do not terminate managed runners on supervisor restart: active GitHub jobs survive agent deployments.
  setTimeout(() => process.exit(0), 100).unref();
}

if (!/^https?:\/\//i.test(DASHBOARD_URL)) {
  console.error('ERROR: DASHBOARD_URL must be configured so the agent can report status to the dashboard');
  process.exit(1);
}
if (NODE_TOKEN.length < 32) {
  console.error('ERROR: DASHBOARD_NODE_SHARED_SECRET must be at least 32 characters');
  process.exit(1);
}
console.log(`[fleet] dashboard credential-lease mode enabled for node ${NODE_ID}; GitHub runner lifecycle is owned by this agent`);
Promise.all([getCredentialLease(), detectCapabilities()])
  .then(([, capabilities]) => {
    process.env.NODE_LABELS = capabilities.labels.join(',');
    console.log(`[fleet] detected node capacity: size=${capabilities.size} cpu=${capabilities.cpu} ram=${capabilities.ram_gb}GB gpu=${capabilities.gpu}; routing labels=${capabilities.labels.join(',')}`);
    startAgent();
    reconcile();
  })
  .catch(err => {
    console.error(`[fleet] capability detection failed: ${err.output || err.message}`);
    process.exit(1);
  });

process.once('SIGTERM', () => stop('SIGTERM'));
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGHUP', () => stop('SIGHUP'));
