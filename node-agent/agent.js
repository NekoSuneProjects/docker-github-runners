const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const DASHBOARD_URL = String(process.env.DASHBOARD_URL || '').replace(/\/+$/, '');
const NODE_TOKEN = process.env.DASHBOARD_NODE_SHARED_SECRET || '';
const INTERVAL_SECONDS = Math.max(10, Math.min(Number(process.env.NODE_HEARTBEAT_SECONDS || 15), 300));
const LOG_TAIL_BYTES = Math.max(8192, Math.min(Number(process.env.NODE_LOG_TAIL_BYTES || 131072), 524288));
const DIAG_DIR = process.env.RUNNER_DIAG_DIR || '/runner-diag';
const HOST_ROOT = process.env.NODE_HOST_ROOT || '/host';
const RUNNER_NAME = process.env.RUNNER_NAME || '';
const RUNNER_SCOPE = process.env.RUNNER_SCOPE || 'organization';
const GITHUB_ORG = process.env.GITHUB_ORG || '';
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || '';
const REPO_URL = process.env.REPO_URL || '';
const NODE_LOCATION = process.env.NODE_LOCATION || '';
const NODE_LABELS = String(process.env.NODE_LABELS || process.env.LABELS || '').split(',').map(v => v.trim()).filter(Boolean).slice(0, 30);
const AGENT_VERSION = '2.0.0';
let stopping = false, timer = null, requestController = null, cleanupResult = null, cleaning = false;

if (!/^https?:\/\//i.test(DASHBOARD_URL)) { console.error('ERROR: DASHBOARD_URL must be http:// or https://'); process.exit(1); }
if (NODE_TOKEN.length < 32) { console.error('ERROR: DASHBOARD_NODE_SHARED_SECRET must be at least 32 characters'); process.exit(1); }

function readText(file) { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; } }
function hostPath(relative) { return path.join(HOST_ROOT, relative.replace(/^\/+/, '')); }
function hostname() { return process.env.NODE_HOSTNAME || readText(hostPath('etc/hostname')) || os.hostname(); }
function nodeId(v) { const s = String(v || '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80); return s || `node-${Date.now()}`; }
const NODE_ID = nodeId(process.env.NODE_ID || RUNNER_NAME || hostname());
const NODE_NAME = String(process.env.NODE_NAME || RUNNER_NAME || hostname()).slice(0, 120);
function osRelease() { const values = {}; for (const line of readText(hostPath('etc/os-release')).split('\n')) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line); if (m) values[m[1]] = m[2].replace(/^"|"$/g, ''); } return values.PRETTY_NAME || values.NAME || process.platform; }
function loadavg() { const p = readText(hostPath('proc/loadavg')).split(/\s+/); return p.length >= 3 ? p.slice(0, 3).map(v => Number(v) || 0) : os.loadavg(); }
function uptime() { const n = Number(readText(hostPath('proc/uptime')).split(/\s+/)[0]); return Number.isFinite(n) ? n : os.uptime(); }
function memory() { const text = readText(hostPath('proc/meminfo')), values = {}; for (const line of text.split('\n')) { const m = /^([^:]+):\s+(\d+)\s*kB/i.exec(line); if (m) values[m[1]] = Number(m[2]) * 1024; } return { total: values.MemTotal || os.totalmem(), free: values.MemAvailable ?? values.MemFree ?? os.freemem() }; }
function cpuCount() { const text = readText(hostPath('proc/stat')); const n = text.split('\n').filter(v => /^cpu\d+\s/.test(v)).length; return n || os.cpus().length; }
function kernel() { return readText(hostPath('proc/sys/kernel/osrelease')) || os.release(); }
function exec(command, args, timeout = 120000) { return new Promise((resolve, reject) => execFile(command, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => err ? reject(Object.assign(err, { output: `${stdout || ''}\n${stderr || ''}`.trim() })) : resolve(String(stdout || '') + String(stderr || '')))); }
function parseBytes(text) { const m = String(text || '').trim().match(/^([0-9.]+)\s*([kmgtp]?b)/i); if (!m) return 0; const powers = { b:0,kb:1,mb:2,gb:3,tb:4,pb:5 }; return Number(m[1]) * 1024 ** powers[m[2].toLowerCase()]; }

async function dockerStorage() {
  try {
    const out = await exec('docker', ['system', 'df', '--format', '{{json .}}'], 20000);
    let total = 0, reclaimable = 0;
    for (const line of out.split('\n').filter(Boolean)) {
      try { const row = JSON.parse(line); total += parseBytes(row.Size); reclaimable += parseBytes(String(row.Reclaimable || '').split(' ')[0]); } catch {}
    }
    return { docker_total_bytes: Math.round(total), docker_reclaimable_bytes: Math.round(reclaimable) };
  } catch { return { docker_total_bytes: 0, docker_reclaimable_bytes: 0 }; }
}
async function diagStats() {
  let bytes = 0, latest = null;
  try {
    for (const file of await fs.promises.readdir(DIAG_DIR)) {
      const full = path.join(DIAG_DIR, path.basename(file)), stat = await fs.promises.stat(full).catch(() => null);
      if (!stat?.isFile()) continue;
      bytes += stat.size;
      if (!latest || stat.mtimeMs > latest.stat.mtimeMs) latest = { file, full, stat };
    }
  } catch {}
  if (!latest) return { bytes, file: '', tail: '' };
  const start = Math.max(0, latest.stat.size - LOG_TAIL_BYTES), length = latest.stat.size - start, handle = await fs.promises.open(latest.full, 'r');
  try { const buffer = Buffer.alloc(length); await handle.read(buffer, 0, length, start); return { bytes, file: latest.file, tail: buffer.toString('utf8').replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, '') }; } finally { await handle.close(); }
}
async function runnerBusy() {
  if (!ACCESS_TOKEN || !RUNNER_NAME) return null;
  let endpoint;
  if (/^(organization|org)$/i.test(RUNNER_SCOPE) && GITHUB_ORG) endpoint = `/orgs/${encodeURIComponent(GITHUB_ORG)}/actions/runners?per_page=100`;
  else if (/^(repository|repo)$/i.test(RUNNER_SCOPE) && REPO_URL) { const repo = REPO_URL.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, ''); endpoint = `/repos/${repo}/actions/runners?per_page=100`; }
  else return null;
  try {
    const r = await fetch(`https://api.github.com${endpoint}`, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'neko-node-agent/2.0' } });
    if (!r.ok) return null; const data = await r.json(), runner = (data.runners || []).find(v => v.name === RUNNER_NAME); return runner ? Boolean(runner.busy) : null;
  } catch { return null; }
}
async function payload() {
  const [l1,l5,l15] = loadavg(), mem = memory(), docker = await dockerStorage(), diag = await diagStats(), busy = await runnerBusy();
  const memPct = mem.total ? ((mem.total - mem.free) / mem.total) * 100 : 0;
  return { id:NODE_ID,name:NODE_NAME,location:NODE_LOCATION,runner_name:RUNNER_NAME,labels:NODE_LABELS,agent_version:AGENT_VERSION,hostname:hostname(),platform:osRelease(),arch:os.arch(),kernel:kernel(),uptime_seconds:uptime(),runner_busy:busy,metrics:{load_1:l1||0,load_5:l5||0,load_15:l15||0,memory_total:mem.total,memory_free:mem.free,memory_used_percent:Math.max(0,Math.min(100,memPct)),cpu_count:cpuCount()},storage:{...docker,runner_logs_bytes:diag.bytes,reclaimable_bytes:docker.docker_reclaimable_bytes+diag.bytes},log_file:diag.file,log_tail:diag.tail,cleanup_result:cleanupResult,sent_at:new Date().toISOString() };
}
async function clearRunnerLogs() {
  let cleared = 0;
  try {
    for (const file of await fs.promises.readdir(DIAG_DIR)) {
      const full = path.join(DIAG_DIR, path.basename(file)), stat = await fs.promises.stat(full).catch(() => null);
      if (!stat?.isFile()) continue;
      cleared += stat.size;
      // Truncate instead of unlinking. The GitHub runner and tee may still have
      // these files open; truncation releases blocks while preserving handles.
      await fs.promises.truncate(full, 0).catch(() => {});
    }
  } catch {}
  return cleared;
}
async function runCleanup(action) {
  if (cleaning || !action?.id) return; cleaning = true;
  console.log(`[cleanup] starting ${action.id} (${action.reason || 'requested'}) volumes=${Boolean(action.include_volumes)}`);
  const beforeDocker = await dockerStorage(), outputs = [];
  let success = true;
  try { outputs.push(await exec('docker', ['buildx', 'prune', '-af'], 10 * 60 * 1000)); } catch (e) { outputs.push(`buildx prune warning: ${e.output || e.message}`); }
  try { const args = ['system','prune','-af']; if (action.include_volumes) args.push('--volumes'); outputs.push(await exec('docker', args, 10 * 60 * 1000)); } catch (e) { success = false; outputs.push(`system prune failed: ${e.output || e.message}`); }
  const clearedLogs = await clearRunnerLogs(), afterDocker = await dockerStorage();
  const reclaimed = Math.max(0, beforeDocker.docker_total_bytes - afterDocker.docker_total_bytes) + clearedLogs;
  cleanupResult = { command_id: action.id, success, reclaimed_bytes: Math.round(reclaimed), output: outputs.join('\n').slice(-16000), completed_at: new Date().toISOString() };
  console.log(`[cleanup] finished ${action.id}; reclaimed about ${Math.round(reclaimed / 1024 / 1024)} MiB`);
  cleaning = false;
}
async function heartbeat() {
  if (stopping) return;
  try {
    const body = await payload();
    requestController = new AbortController(); const timeout = setTimeout(() => requestController.abort(), 15000); timeout.unref();
    const r = await fetch(`${DASHBOARD_URL}/internal/nodes/heartbeat`, { method:'POST', headers:{'content-type':'application/json',authorization:`Bearer ${NODE_TOKEN}`,'user-agent':`neko-runner-node-agent/${AGENT_VERSION}`}, body:JSON.stringify(body), signal:requestController.signal });
    clearTimeout(timeout); requestController = null;
    if (!r.ok) throw Error(`dashboard ${r.status}: ${(await r.text()).slice(0,200)}`);
    const response = await r.json();
    if (cleanupResult) cleanupResult = null;
    console.log(`[${new Date().toISOString()}] heartbeat ok ${NODE_ID}; cleanable ${Math.round((body.storage.reclaimable_bytes||0)/1024/1024)} MiB; busy=${body.runner_busy}`);
    if (response.action?.type === 'cleanup') setImmediate(() => runCleanup(response.action));
  } catch (e) { requestController = null; if (!stopping) console.error(`[heartbeat] ${e.message}`); }
  finally { if (!stopping) { timer = setTimeout(heartbeat, INTERVAL_SECONDS * 1000); timer.unref(); } }
}
function stop(signal) { if (stopping) return; stopping = true; if (timer) clearTimeout(timer); if (requestController) requestController.abort(); console.log(`${signal}: node agent stopped`); setTimeout(() => process.exit(0), cleaning ? 3000 : 100).unref(); }
process.once('SIGTERM',()=>stop('SIGTERM'));process.once('SIGINT',()=>stop('SIGINT'));process.once('SIGHUP',()=>stop('SIGHUP'));
console.log(`Neko Runner Node Agent ${AGENT_VERSION}: ${NODE_ID} -> ${DASHBOARD_URL}`); heartbeat();
