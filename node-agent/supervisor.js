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

async function dashboardRunnerState() {
  if (!DASHBOARD_URL || !NODE_TOKEN || !RUNNER_NAME) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const r = await fetch(`${DASHBOARD_URL}/internal/nodes/runner-state?name=${encodeURIComponent(RUNNER_NAME)}`, {
      headers: { authorization: `Bearer ${NODE_TOKEN}`, 'user-agent': 'neko-node-supervisor/1.0' },
      signal: controller.signal,
    });
    if (!r.ok) throw new Error(`dashboard runner-state ${r.status}: ${(await r.text()).slice(0, 160)}`);
    return r.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function findRunnerContainer() {
  if (RUNNER_CONTAINER_NAME) {
    const exact = (await exec('docker', ['ps', '-q', '--filter', `name=^/${RUNNER_CONTAINER_NAME}$`], 15000)).trim().split('\n').filter(Boolean)[0];
    if (exact) return exact;
  }
  const args = ['ps', '-q'];
  if (RUNNER_CONTAINER_LABEL) args.push('--filter', `label=${RUNNER_CONTAINER_LABEL}`);
  if (RUNNER_NAME) args.push('--filter', `label=neko.runner.name=${RUNNER_NAME}`);
  return (await exec('docker', args, 15000)).trim().split('\n').filter(Boolean)[0] || '';
}

async function restartRunner(reason) {
  const now = Date.now();
  if (now - lastRecoveryAt < COOLDOWN_SECONDS * 1000) return;
  const container = await findRunnerContainer();
  if (!container) {
    console.error(`[supervisor] ${reason}, but no managed runner container matched ${RUNNER_NAME}`);
    return;
  }
  console.warn(`[supervisor] ${reason}; restarting runner container ${container}`);
  await exec('docker', ['restart', '-t', '15', container], 60000);
  lastRecoveryAt = Date.now();
  offlineSince = 0;
  console.warn(`[supervisor] runner container ${container} restarted`);
}

async function healthCheck() {
  if (stopping) return;
  try {
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
        await restartRunner(`GitHub runner has been ${status} for ${age}s`);
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
startAgent();
const healthTimer = setInterval(healthCheck, CHECK_SECONDS * 1000);
setTimeout(healthCheck, 5000);
process.once('SIGTERM', () => stop('SIGTERM'));
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGHUP', () => stop('SIGHUP'));
