const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const originalCreateServer = http.createServer.bind(http);
const clients = new Set();
const runnerStateCache = new Map();
const SESSION_COOKIE = 'neko_runner_session';
const LOGIN_USER = process.env.DASHBOARD_USERNAME || '';
const LOGIN_PASS = process.env.DASHBOARD_PASSWORD || '';
const LOGIN_PASS_SHA256 = String(process.env.DASHBOARD_PASSWORD_SHA256 || '').trim().toLowerCase();
const SESSION_SECRET = process.env.DASHBOARD_SESSION_SECRET || '';
const NODE_SHARED_SECRET = process.env.DASHBOARD_NODE_SHARED_SECRET || '';
const GITHUB_ORG = process.env.GITHUB_ORG || '';
const GITHUB_TOKEN = process.env.GITHUB_DASHBOARD_TOKEN || process.env.ACCESS_TOKEN || '';
const DB_FILE = process.env.DASHBOARD_DB_FILE || '/data/dashboard.sqlite';
const API_VERSION = '2022-11-28';
const authConfigured = Boolean(LOGIN_USER && (LOGIN_PASS || LOGIN_PASS_SHA256));
const LIVE_GITHUB_SECONDS = Math.max(5, Math.min(Number(process.env.DASHBOARD_LIVE_GITHUB_SECONDS || process.env.DASHBOARD_REFRESH_SECONDS || 10), 120));
const SSE_KEEPALIVE_SECONDS = Math.max(5, Math.min(Number(process.env.DASHBOARD_SSE_KEEPALIVE_SECONDS || 15), 60));

function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function parseCookies(req) {
  const result = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try { result[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch {}
  }
  return result;
}
function sign(value) { return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url'); }
function authenticated(req) {
  if (!authConfigured) return true;
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return false;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return false;
  const payload = token.slice(0, dot), signature = token.slice(dot + 1);
  if (!constantTimeEqual(signature, sign(payload))) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.u === LOGIN_USER && Number.isFinite(data.exp) && data.exp > Math.floor(Date.now() / 1000);
  } catch { return false; }
}
function nodeAuthorized(req) {
  const header = String(req.headers.authorization || '');
  return Boolean(NODE_SHARED_SECRET && header.startsWith('Bearer ') && constantTimeEqual(header.slice(7), NODE_SHARED_SECRET));
}
function writeJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-length':Buffer.byteLength(body) });
  res.end(body);
}
function writeText(res, status, value) {
  const body = String(value ?? '');
  res.writeHead(status, { 'content-type':'text/plain; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-length':Buffer.byteLength(body) });
  res.end(body);
}
async function githubRaw(apiPath) {
  const headers = { Accept:'application/vnd.github+json','X-GitHub-Api-Version':API_VERSION,'User-Agent':'neko-runner-dashboard-realtime/4.0' };
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  return fetch(`https://api.github.com${apiPath}`, { headers, redirect:'follow' });
}
async function runnerState(name) {
  const key = String(name || '').trim();
  if (!key) return { found:false,status:'missing',busy:null,name:'' };
  const cached = runnerStateCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;
  if (!GITHUB_ORG || !GITHUB_TOKEN) throw new Error('Dashboard GitHub runner lookup is not configured');
  const response = await githubRaw(`/orgs/${encodeURIComponent(GITHUB_ORG)}/actions/runners?per_page=100`);
  if (!response.ok) throw new Error(`GitHub runner lookup ${response.status}`);
  const data = await response.json();
  const runner = (data.runners || []).find(v => v.name === key);
  const value = runner ? { found:true,name:runner.name,status:runner.status||'unknown',busy:typeof runner.busy==='boolean'?runner.busy:null } : { found:false,name:key,status:'missing',busy:null };
  runnerStateCache.set(key,{ value,expires:Date.now()+5000 });
  return value;
}
function latestArchivedNodeLog(runnerNames) {
  if (!fs.existsSync(DB_FILE)) return null;
  let db;
  try {
    db = new DatabaseSync(DB_FILE);
    const stmt = db.prepare(`SELECT n.id AS node_id,n.name AS node_name,n.runner_name,l.created_at,l.file_name,l.content FROM nodes n JOIN node_logs l ON l.node_id=n.id WHERE n.runner_name=? ORDER BY l.id DESC LIMIT 1`);
    for (const name of runnerNames) { const row = stmt.get(name); if (row?.content) return row; }
  } catch (err) { console.error(`[logs] SQLite fallback failed: ${err.message}`); }
  finally { try { db?.close(); } catch {} }
  return null;
}
async function unzipLogs(buffer) {
  const tmp = path.join(os.tmpdir(),`neko-live-logs-${process.pid}-${Date.now()}.zip`);
  await fs.promises.writeFile(tmp,buffer);
  try {
    return await new Promise((resolve,reject)=>execFile('unzip',['-p',tmp],{maxBuffer:24*1024*1024},(err,stdout,stderr)=>err?reject(new Error(stderr||err.message)):resolve(String(stdout||'').replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g,'').slice(-8*1024*1024))));
  } finally { fs.promises.unlink(tmp).catch(()=>{}); }
}
async function handleRunLogs(req,res,url) {
  if (!authenticated(req)) return writeJson(res,401,{error:'Authentication required'});
  const repo = String(url.searchParams.get('repo')||'').trim(), runId = String(url.searchParams.get('id')||'').trim();
  if (!repo || !runId) return writeJson(res,400,{error:'repo and id required'});
  let run=null,jobs=[];
  try {
    const [runResponse,jobsResponse]=await Promise.all([
      githubRaw(`/repos/${encodeURIComponent(GITHUB_ORG)}/${encodeURIComponent(repo)}/actions/runs/${encodeURIComponent(runId)}`),
      githubRaw(`/repos/${encodeURIComponent(GITHUB_ORG)}/${encodeURIComponent(repo)}/actions/runs/${encodeURIComponent(runId)}/jobs?per_page=100`)
    ]);
    if (runResponse.ok) run=await runResponse.json();
    if (jobsResponse.ok) jobs=(await jobsResponse.json()).jobs||[];
  } catch (err) { console.error(`[logs] run metadata lookup failed: ${err.message}`); }
  try {
    const archive=await githubRaw(`/repos/${encodeURIComponent(GITHUB_ORG)}/${encodeURIComponent(repo)}/actions/runs/${encodeURIComponent(runId)}/logs`);
    if (archive.ok) return writeText(res,200,(await unzipLogs(Buffer.from(await archive.arrayBuffer())))||'GitHub returned an empty workflow log archive.');
    if (archive.status!==404) return writeText(res,200,`GitHub workflow logs are temporarily unavailable (HTTP ${archive.status}).\nRun status: ${run?.status||'unknown'} / ${run?.conclusion||'no conclusion'}`);
  } catch (err) { console.error(`[logs] GitHub archive fetch failed: ${err.message}`); }
  const runnerNames=[...new Set(jobs.map(j=>j.runner_name).filter(Boolean))];
  const fallback=latestArchivedNodeLog(runnerNames);
  if (fallback) return writeText(res,200,`[GitHub archived logs unavailable]\nGitHub no longer has a downloadable workflow log blob for this run.\nRun: ${repo} #${run?.run_number||runId}\nStatus: ${run?.status||'unknown'} / ${run?.conclusion||'no conclusion'}\nRunner: ${fallback.runner_name}\nFallback node: ${fallback.node_name} (${fallback.node_id})\nArchived at: ${fallback.created_at}\nSource: ${fallback.file_name||'runner console'}\n\nNOTE: This is the latest SQLite-archived runner console from that node, so it can contain lines before or after this exact workflow run.\n${'-'.repeat(78)}\n\n${fallback.content}`);
  return writeText(res,200,`[GitHub archived logs unavailable]\nGitHub returned 404/missing blob for this workflow run.\nRun status: ${run?.status||'unknown'} / ${run?.conclusion||'no conclusion'}\nAssigned runner(s): ${runnerNames.join(', ')||'not available from GitHub'}\n\nNo matching SQLite node-console snapshot was found. Open Build Nodes and select the runner node to inspect its archived console history.`);
}
function sendEvent(res,event,data={}) { if (res.destroyed||res.writableEnded) return false; try { res.write(`event: ${event}\n`);res.write(`data: ${JSON.stringify(data)}\n\n`);return true; } catch { return false; } }
function broadcast(event,data={}) { for (const res of [...clients]) if (!sendEvent(res,event,data)) clients.delete(res); }
function handleEvents(req,res) {
  if (!authenticated(req)) return writeJson(res,401,{error:'Authentication required'});
  res.writeHead(200,{ 'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache, no-transform',connection:'keep-alive','x-accel-buffering':'no','x-content-type-options':'nosniff','referrer-policy':'no-referrer' });
  if (typeof res.flushHeaders==='function') res.flushHeaders();
  res.write('retry: 3000\n\n');clients.add(res);sendEvent(res,'ready',{at:new Date().toISOString(),github_refresh_seconds:LIVE_GITHUB_SECONDS});
  const remove=()=>clients.delete(res);req.once('close',remove);res.once('close',remove);res.once('error',remove);
}
http.createServer=function patchedCreateServer(listener){return originalCreateServer(async(req,res)=>{
  let url;try{url=new URL(req.url,'http://localhost')}catch{url=new URL('http://localhost/')};const pathname=url.pathname;
  if(pathname==='/api/events'&&req.method==='GET')return handleEvents(req,res);
  if(pathname==='/internal/nodes/runner-state'&&req.method==='GET'){if(!nodeAuthorized(req))return writeJson(res,401,{error:'Invalid node token'});try{return writeJson(res,200,await runnerState(url.searchParams.get('name')))}catch(err){return writeJson(res,502,{error:err.message})}}
  if(pathname==='/api/run-logs'&&req.method==='GET')return handleRunLogs(req,res,url);
  const liveEvent=pathname==='/internal/nodes/heartbeat'&&req.method==='POST'?'nodes':pathname==='/api/node/settings'&&req.method==='POST'?'nodes':pathname==='/api/node/cleanup'&&req.method==='POST'?'nodes':null;
  if(liveEvent)res.once('finish',()=>{if(res.statusCode>=200&&res.statusCode<300)broadcast(liveEvent,{at:new Date().toISOString(),source:pathname})});
  return listener(req,res);
})};
const githubTimer=setInterval(()=>{runnerStateCache.clear();broadcast('github',{at:new Date().toISOString()})},LIVE_GITHUB_SECONDS*1000);githubTimer.unref();
const keepaliveTimer=setInterval(()=>{for(const res of [...clients]){if(res.destroyed||res.writableEnded)clients.delete(res);else try{res.write(`: keepalive ${Date.now()}\n\n`)}catch{clients.delete(res)}}},SSE_KEEPALIVE_SECONDS*1000);keepaliveTimer.unref();
for(const signal of ['SIGTERM','SIGINT','SIGHUP'])process.on(signal,()=>{clearInterval(githubTimer);clearInterval(keepaliveTimer);for(const res of [...clients])try{sendEvent(res,'shutdown',{at:new Date().toISOString()});res.end()}catch{}clients.clear()});
console.log(`Realtime SSE: enabled (GitHub tick ${LIVE_GITHUB_SECONDS}s, keepalive ${SSE_KEEPALIVE_SECONDS}s)`);
console.log('GitHub log fallback: SQLite node console enabled');
console.log('Runner health endpoint: enabled for authenticated node agents');
require('./server.js');
