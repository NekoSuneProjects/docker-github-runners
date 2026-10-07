'use strict';

const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');

const DASHBOARD_URL = String(process.env.DASHBOARD_URL || '').replace(/\/+$/, '');
const NODE_TOKEN = String(process.env.DASHBOARD_NODE_SHARED_SECRET || '');

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

const CAPACITY_OVERRIDE = String(process.env.NODE_CAPACITY_CLASS || 'auto').trim().toLowerCase();
const GPU_OVERRIDE = String(process.env.NODE_GPU || 'auto').trim().toLowerCase();
const SMALL_MAX_CPU = Math.max(1, Number(process.env.NODE_SMALL_MAX_CPU || 2));
const SMALL_MAX_RAM_GB = Math.max(1, Number(process.env.NODE_SMALL_MAX_RAM_GB || 4));
const LARGE_MIN_CPU = Math.max(2, Number(process.env.NODE_LARGE_MIN_CPU || 8));
const LARGE_MIN_RAM_GB = Math.max(4, Number(process.env.NODE_LARGE_MIN_RAM_GB || 16));

let child = null;
let stopping = false;
let timer = null;

function csv(value) {
  return String(value || '').split(',').map(v => v.trim()).filter(Boolean);
}

function safe(value) {
  return String(value || '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70);
}

function readHostText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

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

async function broker(pathname, options = {}) {
  const r = await fetch(`${DASHBOARD_URL}${pathname}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${NODE_TOKEN}`,
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      'User-Agent': 'neko-runner-fleet-worker/2.0',
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await r.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch {}

  if (!r.ok) {
    throw new Error(`dashboard broker ${r.status}: ${data.error || text.slice(0, 300) || r.statusText}`);
  }
  return data;
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
    cpu,
    memory_bytes: memoryBytes,
    ram_gb: Number(ramGb.toFixed(1)),
    size,
    gpu,
    labels: [...labels],
    fingerprint: `${size}|${gpu ? 'gpu' : 'cpu'}|${[...labels].sort().join(',')}`,
  };
}

function targetKey(target) {
  return target.scope === 'organization'
    ? `org:${target.org.toLowerCase()}`
    : `repo:${target.repo.toLowerCase()}`;
}

function targetFromKey(key) {
  const value = String(key || '');
  if (value.startsWith('org:') && value.slice(4)) return { scope:'organization', org:value.slice(4) };
  if (value.startsWith('repo:') && value.slice(5).includes('/')) return { scope:'repository', repo:value.slice(5) };
  return null;
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

async function discoverTargets() {
  const data = await broker('/internal/runner-broker/targets');
  return Array.isArray(data.targets) ? data.targets : [];
}

async function existingRunnerFingerprint(id) {
  if (!id) return '';
  try {
    return (await exec('docker', [
      'inspect', '-f',
      '{{ index .Config.Labels "neko.runner.capability-fingerprint" }}',
      id,
    ], 15000)).trim();
  } catch {
    return '';
  }
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

async function syncLabels(target, name, labels) {
  await broker('/internal/runner-broker/labels', {
    method: 'PUT',
    body: { target, runner_name: name, labels },
  });
}

async function removeRemoteRunner(target, name) {
  await broker('/internal/runner-broker/remove', {
    method: 'POST',
    body: { target, runner_name: name },
  }).catch(err => console.warn(`[fleet] remote remove ${targetKey(target)}: ${err.message}`));
}

async function ensureRunner(target, capabilities) {
  let id = await findContainer(target);
  const name = runnerName(target);

  if (id) {
    const fingerprint = await existingRunnerFingerprint(id);
    if (fingerprint !== capabilities.fingerprint) {
      console.log(`[fleet] recreating ${targetKey(target)}: capacity labels changed (${fingerprint || 'legacy'} -> ${capabilities.fingerprint})`);
      await exec('docker', ['rm', '-f', id], 60000);
      await removeRemoteRunner(target, name);
      id = '';
    } else if (await isRunning(id)) {
      await syncLabels(target, name, capabilities.labels);
      return;
    } else {
      console.log(`[fleet] recreating stopped broker-managed runner ${targetKey(target)} with a fresh registration token`);
      await exec('docker', ['rm', '-f', id], 60000);
      await removeRemoteRunner(target, name);
      id = '';
    }
  }

  const prepared = await broker('/internal/runner-broker/prepare', {
    method: 'POST',
    body: { target, runner_name: name },
  });

  if (!prepared.registration_token || !prepared.config_url) {
    throw new Error(`dashboard did not return a registration token for ${targetKey(target)}`);
  }

  const cname = containerName(target);
  console.log(`[fleet] creating broker-managed runner for ${targetKey(target)}: ${name}`);

  const args = [
    'run', '-d',
    '--name', cname,
    '--restart', 'no',
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
    '-e', 'NODE_SHARED_JOB_LOCK=true',
    '-e', 'NODE_SHARED_LOCK_DIR=/runner-lock',
    '-e', `NODE_SHARED_LOCK_STALE_SECONDS=${LOCK_STALE_SECONDS}`,
    '-v', '/var/run/docker.sock:/var/run/docker.sock',
    '-v', `${WORK_VOLUME}:/work`,
    '-v', `${DIAG_VOLUME}:/actions-runner/_diag`,
    '-v', `${LOCK_VOLUME}:/runner-lock`,
  ];

  if (target.scope === 'organization') args.push('-e', `GITHUB_ORG=${target.org}`);
  else args.push('-e', `REPO_URL=https://github.com/${target.repo}`);

  args.push(RUNNER_IMAGE);
  await exec('docker', args, 120000);

  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await syncLabels(target, name, capabilities.labels);
      break;
    } catch (err) {
      if (attempt === 9) throw err;
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }
}

async function removeUnknownRunners(desired, targetByKey) {
  const out = await exec('docker', [
    'ps', '-a',
    '--format', '{{.ID}} {{.Label "neko.runner.target"}} {{.Label "neko.runner.name"}}',
    '--filter', `label=neko.runner.node=${NODE_ID}`,
  ], 15000);

  for (const line of out.split('\n').filter(Boolean)) {
    const parts = line.split(' ');
    const id = parts.shift();
    const key = String(parts.shift() || '').trim().toLowerCase();
    const name = String(parts.join(' ') || '').trim();
    if (!key || desired.has(key)) continue;

    console.log(`[fleet] removing no-longer-managed runner ${key}`);
    await exec('docker', ['rm', '-f', id], 60000).catch(() => {});

    const target = targetByKey.get(key) || targetFromKey(key);
    if (target && name) await removeRemoteRunner(target, name);
  }
}

async function reconcile() {
  if (stopping) return;
  try {
    const capabilities = await detectCapabilities();
    const targets = await discoverTargets();
    if (!targets.length) throw new Error('Dashboard returned no GitHub runner targets');

    await Promise.all([
      ensureVolume(WORK_VOLUME),
      ensureVolume(DIAG_VOLUME),
      ensureVolume(LOCK_VOLUME),
    ]);

    const desired = new Set(targets.map(targetKey));
    const targetByKey = new Map(targets.map(t => [targetKey(t), t]));
    await removeUnknownRunners(desired, targetByKey);

    for (const target of targets) {
      try {
        await ensureRunner(target, capabilities);
      } catch (err) {
        console.error(`[fleet] ${targetKey(target)}: ${err.output || err.message}`);
      }
    }

    const orgCount = targets.filter(v => v.scope === 'organization').length;
    const repoCount = targets.filter(v => v.scope === 'repository').length;
    console.log(`[fleet] reconciled ${targets.length} target(s): ${orgCount} org(s), ${repoCount} personal repo(s); node=${capabilities.size} cpu=${capabilities.cpu} ram=${capabilities.ram_gb}GB gpu=${capabilities.gpu}; shared concurrency=1`);
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
    const out = await exec('docker', [
      'ps', '-a',
      '--format', '{{.ID}} {{.Label "neko.runner.target"}} {{.Label "neko.runner.name"}}',
      '--filter', `label=neko.runner.node=${NODE_ID}`,
    ], 15000);

    for (const line of out.split('\n').filter(Boolean)) {
      const parts = line.split(' ');
      const id = parts.shift();
      const key = String(parts.shift() || '');
      const name = String(parts.join(' ') || '');
      await exec('docker', ['stop', '-t', '30', id], 60000).catch(() => {});

      try {
        const targets = await discoverTargets();
        const target = targets.find(t => targetKey(t) === key);
        if (target && name) await removeRemoteRunner(target, name);
      } catch {}
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

if (!/^https?:\/\//i.test(DASHBOARD_URL)) {
  console.error('ERROR: DASHBOARD_URL must be configured for broker-managed fleet mode');
  process.exit(1);
}
if (NODE_TOKEN.length < 32) {
  console.error('ERROR: DASHBOARD_NODE_SHARED_SECRET must be at least 32 characters');
  process.exit(1);
}

console.log(`[fleet] dashboard-broker mode enabled for node ${NODE_ID}; no GitHub long-lived credentials are stored on this node`);

detectCapabilities()
  .then(capabilities => {
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
