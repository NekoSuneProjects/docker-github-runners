const fs = require('fs');
const path = require('path');
const os = require('os');

const DASHBOARD_URL = String(process.env.DASHBOARD_URL || '').replace(/\/+$/, '');
const NODE_TOKEN = process.env.DASHBOARD_NODE_SHARED_SECRET || '';
const INTERVAL_SECONDS = Math.max(10, Math.min(Number(process.env.NODE_HEARTBEAT_SECONDS || 15), 300));
const LOG_TAIL_BYTES = Math.max(8192, Math.min(Number(process.env.NODE_LOG_TAIL_BYTES || 131072), 524288));
const DIAG_DIR = process.env.RUNNER_DIAG_DIR || '/runner-diag';
const HOST_ROOT = process.env.NODE_HOST_ROOT || '/host';
const RUNNER_NAME = process.env.RUNNER_NAME || '';
const NODE_LOCATION = process.env.NODE_LOCATION || '';
const NODE_LABELS = (process.env.NODE_LABELS || process.env.LABELS || '')
  .split(',')
  .map(v => v.trim())
  .filter(Boolean)
  .slice(0, 30);
const AGENT_VERSION = '1.0.0';

let stopping = false;
let timer = null;
let requestController = null;

if (!/^https?:\/\//i.test(DASHBOARD_URL)) {
  console.error('ERROR: DASHBOARD_URL must be an http:// or https:// URL.');
  process.exit(1);
}

if (NODE_TOKEN.length < 32) {
  console.error('ERROR: DASHBOARD_NODE_SHARED_SECRET must be at least 32 characters.');
  process.exit(1);
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

function hostPath(relative) {
  return path.join(HOST_ROOT, relative.replace(/^\/+/, ''));
}

function hostHostname() {
  return process.env.NODE_HOSTNAME || readText(hostPath('etc/hostname')) || os.hostname();
}

function normalizeNodeId(value) {
  const normalized = String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return normalized || `node-${Date.now()}`;
}

const NODE_ID = normalizeNodeId(process.env.NODE_ID || RUNNER_NAME || hostHostname());
const NODE_NAME = String(process.env.NODE_NAME || RUNNER_NAME || hostHostname()).slice(0, 120);

function readOsRelease() {
  const content = readText(hostPath('etc/os-release'));
  const values = {};
  for (const line of content.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!match) continue;
    values[match[1]] = match[2].replace(/^"|"$/g, '');
  }
  return values.PRETTY_NAME || values.NAME || process.platform;
}

function readLoadAverage() {
  const content = readText(hostPath('proc/loadavg'));
  const parts = content.split(/\s+/);
  if (parts.length >= 3) return parts.slice(0, 3).map(value => Number(value) || 0);
  return os.loadavg();
}

function readUptime() {
  const content = readText(hostPath('proc/uptime'));
  if (content) {
    const value = Number(content.split(/\s+/)[0]);
    if (Number.isFinite(value)) return value;
  }
  return os.uptime();
}

function readMemory() {
  const content = readText(hostPath('proc/meminfo'));
  if (!content) {
    const total = os.totalmem();
    const free = os.freemem();
    return { total, free };
  }

  const values = {};
  for (const line of content.split('\n')) {
    const match = /^([^:]+):\s+(\d+)\s*kB/i.exec(line);
    if (match) values[match[1]] = Number(match[2]) * 1024;
  }

  const total = values.MemTotal || os.totalmem();
  const available = values.MemAvailable ?? values.MemFree ?? os.freemem();
  return { total, free: available };
}

function readCpuCount() {
  const content = readText(hostPath('proc/stat'));
  if (content) {
    const count = content.split('\n').filter(line => /^cpu\d+\s/.test(line)).length;
    if (count) return count;
  }
  return os.cpus().length;
}

function readKernel() {
  return readText(hostPath('proc/sys/kernel/osrelease')) || os.release();
}

async function latestRunnerLog() {
  try {
    const entries = await fs.promises.readdir(DIAG_DIR);
    const candidates = [];
    for (const file of entries) {
      const full = path.join(DIAG_DIR, path.basename(file));
      const stat = await fs.promises.stat(full).catch(() => null);
      if (stat?.isFile()) candidates.push({ file, full, stat });
    }
    candidates.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    if (!candidates.length) return { file: '', tail: '' };

    const latest = candidates[0];
    const start = Math.max(0, latest.stat.size - LOG_TAIL_BYTES);
    const length = latest.stat.size - start;
    const handle = await fs.promises.open(latest.full, 'r');
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      const tail = buffer.toString('utf8').replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, '');
      return { file: latest.file, tail };
    } finally {
      await handle.close();
    }
  } catch {
    return { file: '', tail: '' };
  }
}

async function collectPayload() {
  const [load1, load5, load15] = readLoadAverage();
  const memory = readMemory();
  const usedPercent = memory.total > 0
    ? Math.max(0, Math.min(100, ((memory.total - memory.free) / memory.total) * 100))
    : 0;
  const log = await latestRunnerLog();

  return {
    id: NODE_ID,
    name: NODE_NAME,
    location: NODE_LOCATION,
    runner_name: RUNNER_NAME,
    labels: NODE_LABELS,
    agent_version: AGENT_VERSION,
    hostname: hostHostname(),
    platform: readOsRelease(),
    arch: os.arch(),
    kernel: readKernel(),
    uptime_seconds: readUptime(),
    metrics: {
      load_1: load1 || 0,
      load_5: load5 || 0,
      load_15: load15 || 0,
      memory_total: memory.total,
      memory_free: memory.free,
      memory_used_percent: usedPercent,
      cpu_count: readCpuCount(),
    },
    log_file: log.file,
    log_tail: log.tail,
    sent_at: new Date().toISOString(),
  };
}

async function heartbeat() {
  if (stopping) return;
  try {
    const payload = await collectPayload();
    requestController = new AbortController();
    const timeout = setTimeout(() => requestController.abort(), 10000);
    timeout.unref();

    const response = await fetch(`${DASHBOARD_URL}/internal/nodes/heartbeat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${NODE_TOKEN}`,
        'user-agent': `neko-runner-node-agent/${AGENT_VERSION}`,
      },
      body: JSON.stringify(payload),
      signal: requestController.signal,
    });

    clearTimeout(timeout);
    requestController = null;
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`dashboard returned ${response.status}: ${body.slice(0, 200)}`);
    }

    console.log(
      `[${new Date().toISOString()}] heartbeat ok: ${NODE_ID} -> ${DASHBOARD_URL} ` +
      `(memory ${payload.metrics.memory_used_percent.toFixed(1)}%, load ${payload.metrics.load_1.toFixed(2)})`
    );
  } catch (err) {
    requestController = null;
    if (!stopping) console.error(`[${new Date().toISOString()}] heartbeat failed: ${err.message}`);
  } finally {
    if (!stopping) {
      timer = setTimeout(heartbeat, INTERVAL_SECONDS * 1000);
      timer.unref();
    }
  }
}

function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received: stopping node agent...`);
  if (timer) clearTimeout(timer);
  if (requestController) requestController.abort();
  setTimeout(() => process.exit(0), 100).unref();
}

process.once('SIGTERM', () => stop('SIGTERM'));
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGHUP', () => stop('SIGHUP'));

console.log('Neko Runner Node Agent starting...');
console.log(`Node ID: ${NODE_ID}`);
console.log(`Node name: ${NODE_NAME}`);
console.log(`Dashboard: ${DASHBOARD_URL}`);
console.log(`Heartbeat: every ${INTERVAL_SECONDS}s`);
heartbeat();
