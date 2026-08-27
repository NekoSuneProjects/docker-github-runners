const { spawn, execFile } = require('child_process');

const DASHBOARD_URL = String(process.env.DASHBOARD_URL || '').replace(/\/+$/, '');
const NODE_TOKEN = process.env.DASHBOARD_NODE_SHARED_SECRET || '';
const RUNNER_NAME = String(process.env.RUNNER_NAME || '').trim();
const CHECK_SECONDS = Math.max(15, Math.min(Number(process.env.NODE_RUNNER_HEALTHCHECK_SECONDS || 30), 300));
const OFFLINE_SECONDS = Math.max(30, Math.min(Number(process.env.NODE_RUNNER_OFFLINE_RECOVERY_SECONDS || 120), 3600));
const AUTO_RECOVER_OFFLINE = !/^(0|false|no|off)$/i.test(process.env.NODE_AUTO_RECOVER_OFFLINE || 'true');
const COOLDOWN_SECONDS = Math.max(120, Math.min(Number(process.env.NODE_RUNNER_OFFLINE_RECOVERY_COOLDOWN_SECONDS || 600), 86400));
const RUNNER_CONTAINER_NAME = String(process.env.NODE_RUNNER_CONTAINER_NAME || '').trim();
const RUNNER_CONTAINER_LABEL = String(process.env.NODE_RUNNER_CONTAINER_LABEL || 'neko.runner.managed=true').trim();

let child = null;
let stopping = false;
let offlineSince = 0;
let lastRecoveryAt = 0;
let lastState = '';
let lastDesiredState = '';
let restartTimer = null;

function exec(command, args, timeout = 60000) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { output: `${stdout || ''}\n${stderr || ''}`.trim() }));
      resolve(String(stdout || '') + String(stderr || ''));
    });
  });
}

function startAgent() {
  if (stopping || child) return;
  child = spawn(process.execPath, ['/app/agent.js'], { stdio: 'inherit', env: process.env });
  console.log(`[supervisor] node agent started pid=${child.pid}`);
  child.once('exit', (code, signal) => {
    child = null;
    if (stopping) return;
    console.error(`[supervisor] node agent exited code=${code} signal=${signal || 'none'}; restarting in 2s`);
    restartTimer = setTimeout(startAgent, 2000);
  });
}

async function dashboardJson(pathname, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const r = await fetch(`${DASHBOARD_URL}${pathname}`, {
      ...options,
      headers: {
        authorization: `Bearer ${NODE_TOKEN}`,
        'user-agent': 'neko-node-supervisor/1.1',
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });
    if (!r.ok) throw new Error(`dashboard ${pathname} ${r.status}: ${(await r.text()).slice(0, 180)}`);
    return r.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function dashboardRunnerState() {
  if (!DASHBOARD_URL || !NODE_TOKEN || !RUNNER_NAME) return null;
  return dashboardJson(`/internal/nodes/runner-state?name=${encodeURIComponent(RUNNER_NAME)}`);
}

async function dashboardControlState() {
  if (!DASHBOARD_URL || !NODE_TOKEN || !RUNNER_NAME) return { desired_state: 'running', pending_action: null };
  return dashboardJson(`/internal/nodes/runner-control?name=${encodeURIComponent(RUNNER_NAME)}`);
}

async function ackControl(action) {
  try {
    await dashboardJson('/internal/nodes/runner-control-ack', {
      method: 'POST',
      body: JSON.stringify({ runner_name: RUNNER_NAME, action }),
    });
  } catch (err) {
    console.error(`[supervisor] control ack failed: ${err.message}`);
  }
}

async function findRunnerContainer(includeStopped = true) {
  if (RUNNER_CONTAINER_NAME) {
    const exact = (await exec('docker', [includeStopped ? 'ps' : 'ps', includeStopped ? '-aq' : '-q', '--filter', `name=^/${RUNNER_CONTAINER_NAME}$`], 15000)).trim().split('\n').filter(Boolean)[0];
    if (exact) return exact;
  }
  const args = ['ps', includeStopped ? '-aq' : '-q'];
  if (RUNNER_CONTAINER_LABEL) args.push('--filter', `label=${RUNNER_CONTAINER_LABEL}`);
  if (RUNNER_NAME) args.push('--filter', `label=neko.runner.name=${RUNNER_NAME}`);
  return (await exec('docker', args, 15000)).trim().split('\n').filter(Boolean)[0] || '';
}

async function containerRunning(container) {
  if (!container) return false;
  try {
    return (await exec('docker', ['inspect', '-f', '{{.State.Running}}', container], 15000)).trim() === 'true';
  } catch { return false; }
}

async function ensureStopped(reason) {
  const container = await findRunnerContainer(true);
  if (!container) {
    console.error(`[supervisor] ${reason}, but no managed runner container matched ${RUNNER_NAME}`);
    return;
  }
  if (!(await containerRunning(container))) return;
  console.warn(`[supervisor] ${reason}; stopping runner container ${container}`);
  await exec('docker', ['stop', '-t', '15', container], 60000);
  console.warn(`[supervisor] runner ${RUNNER_NAME} stopped by dashboard control`);
}

async function ensureStarted(reason) {
  const container = await findRunnerContainer(true);
  if (!container) {
    console.error(`[supervisor] ${reason}, but no managed runner container matched ${RUNNER_NAME}`);
    return false;
  }
  if (await containerRunning(container)) return true;
  console.warn(`[supervisor] ${reason}; starting runner container ${container}`);
  await exec('docker', ['start', container], 60000);
  offlineSince = 0;
  console.warn(`[supervisor] runner ${RUNNER_NAME} started`);
  return true;
}

async function restartRunner(reason, respectCooldown = true) {
  const now = Date.now();
  if (respectCooldown && now - lastRecoveryAt < COOLDOWN_SECONDS * 1000) return;
  const container = await findRunnerContainer(true);
  if (!container) {
    console.error(`[supervisor] ${reason}, but no managed runner container matched ${RUNNER_NAME}`);
    return;
  }
  console.warn(`[supervisor] ${reason}; restarting runner container ${container}`);
  if (await containerRunning(container)) await exec('docker', ['restart', '-t', '15', container], 60000);
  else await exec('docker', ['start', container], 60000);
  lastRecoveryAt = Date.now();
  offlineSince = 0;
  console.warn(`[supervisor] runner container ${container} restarted`);
}

async function applyManualControl(control) {
  const desired = control?.desired_state === 'stopped' ? 'stopped' : 'running';
  if (desired !== lastDesiredState) {
    console.log(`[supervisor] dashboard desired runner state: ${desired}`);
    lastDesiredState = desired;
  }

  if (control?.pending_action === 'restart') {
    await restartRunner('dashboard requested restart', false);
    await ackControl('restart');
  }

  if (desired === 'stopped') {
    offlineSince = 0;
    await ensureStopped('dashboard requested stop');
    return false;
  }

  await ensureStarted('dashboard requested running state');
  return true;
}

async function healthCheck() {
  if (stopping) return;
  try {
    const control = await dashboardControlState();
    const shouldMonitor = await applyManualControl(control);
    if (!shouldMonitor) return;

    const state = await dashboardRunnerState();
    if (!state) return;
    const status = state.found ? String(state.status || 'unknown') : 'missing';
    if (status !== lastState) {
      console.log(`[supervisor] GitHub runner ${RUNNER_NAME}: ${status}${state.busy === true ? ' / busy' : state.busy === false ? ' / idle' : ''}`);
      lastState = status;
    }

    if (status === 'online') {
      offlineSince = 0;
      return;
    }

    if (status === 'offline' || status === 'missing') {
      if (!offlineSince) offlineSince = Date.now();
      const age = Math.floor((Date.now() - offlineSince) / 1000);
      if (AUTO_RECOVER_OFFLINE && age >= OFFLINE_SECONDS) {
        await restartRunner(`GitHub runner has been ${status} for ${age}s`, true);
      }
    }
  } catch (err) {
    if (!stopping) console.error(`[supervisor] health check: ${err.output || err.message}`);
  }
}

function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[supervisor] ${signal}: stopping`);
  if (restartTimer) clearTimeout(restartTimer);
  clearInterval(healthTimer);
  if (child) child.kill('SIGTERM');
  const force = setTimeout(() => {
    if (child) child.kill('SIGKILL');
    process.exit(0);
  }, 5000);
  force.unref();
  if (!child) process.exit(0);
  else child.once('exit', () => process.exit(0));
}

console.log(`[supervisor] runner recovery: ${AUTO_RECOVER_OFFLINE ? 'enabled' : 'disabled'}; offline threshold=${OFFLINE_SECONDS}s; check=${CHECK_SECONDS}s`);
console.log('[supervisor] dashboard runner controls: start / stop / restart enabled');
startAgent();
const healthTimer = setInterval(healthCheck, CHECK_SECONDS * 1000);
setTimeout(healthCheck, 3000);
process.once('SIGTERM', () => stop('SIGTERM'));
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGHUP', () => stop('SIGHUP'));
