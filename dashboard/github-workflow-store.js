'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const GITHUB_ORG = String(process.env.GITHUB_ORG || '').trim();
const GITHUB_TOKEN = process.env.GITHUB_DASHBOARD_TOKEN || process.env.ACCESS_TOKEN || '';
const APP_MODE = String(process.env.GITHUB_AUTH_MODE || '').toLowerCase() === 'app';
const APP_ID = String(process.env.GITHUB_APP_ID || '');
const APP_KEY = process.env.GITHUB_APP_PRIVATE_KEY_BASE64 ? Buffer.from(process.env.GITHUB_APP_PRIVATE_KEY_BASE64,'base64').toString('utf8') : String(process.env.GITHUB_APP_PRIVATE_KEY || '').replace(/\\n/g,'\n');
const ORG_INCLUDE = String(process.env.GITHUB_ORG_INCLUDE||'').toLowerCase().split(',').map(x=>x.trim()).filter(Boolean);
const ORG_EXCLUDE = String(process.env.GITHUB_ORG_EXCLUDE||'').toLowerCase().split(',').map(x=>x.trim()).filter(Boolean);

const DB_FILE = process.env.DASHBOARD_DB_FILE || '/data/dashboard.sqlite';
const CONFIG_REPOS = String(process.env.DASHBOARD_REPOS || '').split(',').map(v => v.trim()).filter(Boolean).map(v => v.includes('/') ? v.split('/').pop() : v);
const MAX_REPOS = Math.max(1, Math.min(Number(process.env.DASHBOARD_MAX_REPOS || 100), 500));
const SYNC_SECONDS = Math.max(60, Math.min(Number(process.env.DASHBOARD_GITHUB_WORKFLOW_SYNC_SECONDS || 180), 3600));
const RUNS_PER_REPO = Math.max(3, Math.min(Number(process.env.DASHBOARD_GITHUB_WORKFLOW_RUNS_PER_REPO || 10), 100));
const REPOS_PER_CYCLE = Math.max(1, Math.min(Number(process.env.DASHBOARD_GITHUB_WORKFLOW_REPOS_PER_CYCLE || 5), 50));
const JOB_DETAILS_PER_CYCLE = Math.max(0, Math.min(Number(process.env.DASHBOARD_GITHUB_WORKFLOW_JOBS_PER_CYCLE || 6), 50));
let rateLimitUntil = 0;
let repoCursor = 0;
let jobFetches = 0;
let initialJobBackfill = false;
const BACKFILL_ON_EMPTY_ONLY = process.env.DASHBOARD_WORKFLOW_BACKFILL_ON_EMPTY_ONLY !== 'false';
const API_VERSION = '2022-11-28';

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA synchronous=NORMAL;
  PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS github_live_repos (
    name TEXT PRIMARY KEY,
    last_seen_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS github_live_runs (
    repo TEXT NOT NULL,
    run_id INTEGER NOT NULL,
    status TEXT NOT NULL,
    conclusion TEXT,
    updated_at TEXT NOT NULL,
    json TEXT NOT NULL,
    PRIMARY KEY(repo, run_id)
  );
  CREATE INDEX IF NOT EXISTS idx_github_live_runs_updated ON github_live_runs(updated_at DESC);
  CREATE TABLE IF NOT EXISTS github_live_jobs (
    repo TEXT NOT NULL,
    run_id INTEGER NOT NULL,
    job_id INTEGER NOT NULL,
    status TEXT NOT NULL,
    conclusion TEXT,
    runner_name TEXT DEFAULT '',
    runner_group_name TEXT DEFAULT '',
    runner_type TEXT NOT NULL DEFAULT 'waiting',
    updated_at TEXT NOT NULL,
    json TEXT NOT NULL,
    PRIMARY KEY(repo, job_id)
  );
  CREATE INDEX IF NOT EXISTS idx_github_live_jobs_run ON github_live_jobs(repo,run_id);
  CREATE TABLE IF NOT EXISTS github_workflow_sync_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    last_attempt_at TEXT,
    last_success_at TEXT,
    last_error TEXT DEFAULT '',
    repos_synced INTEGER NOT NULL DEFAULT 0
  );
  INSERT OR IGNORE INTO github_workflow_sync_state(singleton) VALUES(1);
`);

let syncing = null;
let lastHash = '';

let jwtCache={token:'',until:0};
let installationsCache={rows:[],until:0};
const tokenCache=new Map();
function appJwt(){
 if(jwtCache.until>Date.now()+60000)return jwtCache.token;
 if(!APP_ID||!APP_KEY)throw Error('GitHub App ID/private key missing for workflow history');
 const now=Math.floor(Date.now()/1000),head=Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT'})).toString('base64url'),payload=Buffer.from(JSON.stringify({iat:now-60,exp:now+540,iss:APP_ID})).toString('base64url'),input=head+'.'+payload;
 const token=input+'.'+crypto.sign('RSA-SHA256',Buffer.from(input),APP_KEY).toString('base64url');jwtCache={token,until:(now+540)*1000};return token;
}
async function githubRequest(apiPath,token){
 const r=await fetch('https://api.github.com'+apiPath,{headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':API_VERSION,'User-Agent':'neko-runner-dashboard-workflow-store/2.0',Authorization:'Bearer '+token},redirect:'follow'});
 if(!r.ok){const body=await r.text().catch(()=> '');if(r.status===429 || (r.status===403 && /rate.limit|quota|requests are paused/i.test(body))){const retry=Number(r.headers.get('retry-after')||0);rateLimitUntil=Math.max(rateLimitUntil,Date.now()+Math.max(60,retry||300)*1000);throw Error('GitHub workflow API quota exhausted; paused until '+new Date(rateLimitUntil).toISOString())}throw Error('GitHub workflow sync '+r.status+': '+body.slice(0,250))}
 return r.json();
}
async function appInstallations(){
 if(installationsCache.until>Date.now())return installationsCache.rows;
 const rows=[];for(let page=1;page<=20;page++){const data=await githubRequest('/app/installations?per_page=100&page='+page,appJwt());if(!Array.isArray(data))throw Error('GitHub App installations response invalid');rows.push(...data);if(data.length<100)break}
 installationsCache={rows,until:Date.now()+300000};return rows;
}
async function installationToken(installation){
 const id=Number(installation.id),cached=tokenCache.get(id);
 if(cached&&cached.until>Date.now()+60000)return cached.token;
 const r=await fetch('https://api.github.com/app/installations/'+id+'/access_tokens',{method:'POST',headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':API_VERSION,'User-Agent':'neko-runner-dashboard-workflow-store/2.0',Authorization:'Bearer '+appJwt()}});
 if(!r.ok)throw Error('GitHub installation token '+r.status+': '+(await r.text()).slice(0,200));
 const data=await r.json();if(!data.token)throw Error('GitHub installation token missing');
 const until=Date.parse(data.expires_at)||Date.now()+3000000;tokenCache.set(id,{token:data.token,until});return data.token;
}
async function installForRepo(fullRepo){
 const owner=fullRepo.split('/')[0].toLowerCase();
 const installations=await appInstallations();
 const match=installations.find(i=>String(i.account?.login||'').toLowerCase()===owner);
 if(!match)throw Error('No GitHub App installation for '+owner);
 return installationToken(match);
}
async function gh(apiPath){
 let token=GITHUB_TOKEN;
 if(APP_MODE){
  if(apiPath.startsWith('/repos/')){const m=apiPath.match(/^\/repos\/([^/]+)\/([^/]+)/);if(!m)throw Error('Invalid repository API path');token=await installForRepo(decodeURIComponent(m[1])+'/'+decodeURIComponent(m[2]));}
  else token=appJwt();
 }
 if(!token)throw Error('GitHub workflow history needs valid GitHub credentials');
 return githubRequest(apiPath,token);
}
function normalizeRun(run, repo) {
  return {
    id: Number(run.id), repo,
    name: run.name || 'Workflow',
    display_title: run.display_title || run.name || 'Workflow run',
    run_number: run.run_number,
    status: run.status || 'unknown', conclusion: run.conclusion || null,
    branch: run.head_branch || '', actor: run.actor?.login || 'unknown',
    created_at: run.created_at, updated_at: run.updated_at, html_url: run.html_url,
  };
}
function runnerType(job) {
  const name = String(job.runner_name || '');
  const group = String(job.runner_group_name || '');
  if (!name) return 'waiting';
  const known = db.prepare('SELECT github_id FROM github_runners WHERE name=?').get(name);
  if (known || /^neko-runner[-_]/i.test(name) || /self[- ]hosted/i.test(group)) return 'self_hosted';
  if (/github actions/i.test(group) || /^github actions\b/i.test(name) || /^hosted agent\b/i.test(name) || /^github[- ]hosted$/i.test(name)) return 'github_hosted';
  return 'external';
}
function normalizeJob(job, repo, runId) {
  const type = runnerType(job);
  return {
    id: Number(job.id), run_id: Number(runId), repo,
    name: job.name || 'Job', status: job.status || 'unknown', conclusion: job.conclusion || null,
    runner_name: job.runner_name || '', runner_group_name: job.runner_group_name || '', runner_type: type,
    started_at: job.started_at || null, completed_at: job.completed_at || null,
    steps: (job.steps || []).map(s => ({ number: s.number, name: s.name, status: s.status, conclusion: s.conclusion, started_at: s.started_at || null, completed_at: s.completed_at || null })),
  };
}
// APP_WORKFLOW_DISCOVERY_V2: discover repositories across all App installations.
async function reposToSync(){
 if(APP_MODE){
  const installations=await appInstallations(),repos=[];
  for(const inst of installations){
   const login=String(inst.account?.login||'');
   if(inst.account?.type==='Organization' && ((ORG_INCLUDE.length&&!ORG_INCLUDE.includes(login.toLowerCase()))||ORG_EXCLUDE.includes(login.toLowerCase())))continue;
   try {
    const token=await installationToken(inst);
    for(let page=1;page<=20;page++){
     const response=await githubRequest('/installation/repositories?per_page=100&page='+page,token);
     const batch=response.repositories||[];repos.push(...batch.filter(r=>!r.archived).map(r=>r.full_name));
     if(batch.length<100)break;
    }
   }catch(err){console.warn('[workflow-store] discovery '+login+': '+err.message)}
  }
  const fromFleet=db.prepare('SELECT fleet_runners_json FROM nodes').all().flatMap(row=>{try{return JSON.parse(row.fleet_runners_json||'[]')}catch{return[]}}).map(r=>String(r.target||'').replace(/^repo:/,'')).filter(r=>r.includes('/'));
  const stored=db.prepare('SELECT name FROM github_live_repos ORDER BY last_seen_at DESC LIMIT ?').all(MAX_REPOS).map(r=>r.name);
  return [...new Set([...fromFleet,...repos,...stored].map(r=>r.includes('/')?r:GITHUB_ORG+'/'+r))].slice(0,MAX_REPOS);
 }
 if(CONFIG_REPOS.length)return CONFIG_REPOS.slice(0,MAX_REPOS).map(r=>r.includes('/')?r:GITHUB_ORG+'/'+r);
 const stored=db.prepare('SELECT name FROM github_live_repos ORDER BY last_seen_at DESC LIMIT ?').all(MAX_REPOS).map(r=>r.name);
 if(stored.length)return stored.map(r=>r.includes('/')?r:GITHUB_ORG+'/'+r);
 const data=await gh('/orgs/'+encodeURIComponent(GITHUB_ORG)+'/repos?per_page=100&type=all&sort=pushed');
 return data.slice(0,MAX_REPOS).map(r=>r.full_name);
}
function upsertRepos(repos, now) {
  const stmt = db.prepare('INSERT INTO github_live_repos(name,last_seen_at) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET last_seen_at=excluded.last_seen_at');
  for (const repo of repos) stmt.run(repo, now);
}
function upsertRun(run) {
  db.prepare(`INSERT INTO github_live_runs(repo,run_id,status,conclusion,updated_at,json) VALUES(?,?,?,?,?,?)
    ON CONFLICT(repo,run_id) DO UPDATE SET status=excluded.status,conclusion=excluded.conclusion,updated_at=excluded.updated_at,json=excluded.json`)
    .run(run.repo, run.id, run.status, run.conclusion, run.updated_at || new Date().toISOString(), JSON.stringify(run));
}
function upsertJob(job) {
  // Initial workflow_job deliveries contain steps:[]; never let that erase a
  // timeline previously fetched from the Jobs API or a completed delivery.
  const old=db.prepare('SELECT json FROM github_live_jobs WHERE repo=? AND job_id=?').get(job.repo,job.id);
  if(old){
    const previous=JSON.parse(old.json);
    if((!job.steps||!job.steps.length)&&previous.steps?.length)job.steps=previous.steps;
  }
  db.prepare(`INSERT INTO github_live_jobs(repo,run_id,job_id,status,conclusion,runner_name,runner_group_name,runner_type,updated_at,json) VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(repo,job_id) DO UPDATE SET run_id=excluded.run_id,status=excluded.status,conclusion=excluded.conclusion,runner_name=excluded.runner_name,runner_group_name=excluded.runner_group_name,runner_type=excluded.runner_type,updated_at=excluded.updated_at,json=excluded.json`)
    .run(job.repo, job.run_id, job.id, job.status, job.conclusion, job.runner_name, job.runner_group_name, job.runner_type, new Date().toISOString(), JSON.stringify(job));
}
function snapshot() {
  const runs = db.prepare(`SELECT json FROM github_live_runs ORDER BY datetime(json_extract(json, '$.created_at')) DESC, run_id DESC LIMIT 500`).all().map(r => JSON.parse(r.json));
  const jobs = db.prepare('SELECT json FROM github_live_jobs ORDER BY datetime(updated_at) DESC LIMIT 2000').all().map(r => JSON.parse(r.json));
  const activeJobs = jobs.filter(j => ['queued','in_progress','waiting','pending'].includes(String(j.status)));
  const byRun = {};
  for (const job of jobs) (byRun[String(job.run_id)] ||= []).push(job);
  const state = db.prepare('SELECT last_success_at,last_error,repos_synced FROM github_workflow_sync_state WHERE singleton=1').get() || {};
  return { runs, jobs_by_run: byRun, active_jobs: activeJobs, sync: state };
}
function emitIfChanged(reason) {
  const snap = snapshot();
  const hash = crypto.createHash('sha256').update(JSON.stringify({runs:snap.runs,jobs:snap.jobs_by_run})).digest('hex');
  if (hash !== lastHash) {
    lastHash = hash;
    process.emit('neko:workflow-sync', { reason, snapshot: snap, at: new Date().toISOString() });
  }
  return snap;
}
async function syncRepo(repo) {
  const fullRepo = repo.includes('/') ? repo : `${GITHUB_ORG}/${repo}`;
  const [owner,name] = fullRepo.split('/');
  const data = await gh(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/runs?per_page=${RUNS_PER_REPO}`);
  const runs = (data.workflow_runs || []).map(r => normalizeRun(r, repo));
  for (const run of runs) upsertRun(run);

  for (const run of runs) {
    if(jobFetches>=JOB_DETAILS_PER_CYCLE)break;
    const active = ['queued','in_progress','waiting','pending','requested'].includes(String(run.status));
    const jobState = db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN status<>'completed' THEN 1 ELSE 0 END) AS unfinished FROM github_live_jobs WHERE repo=? AND run_id=?`).get(repo, run.id) || {};
    const haveJobs = Number(jobState.total || 0) > 0;
    const unfinished = Number(jobState.unfinished || 0) > 0;
    // Completed runs with a fully completed cached job timeline never need to be
    // fetched again. If a run just completed while its cached job still says
    // in_progress/queued, fetch it one final time to close the timeline cleanly.
    if (!active && haveJobs && !unfinished) continue;
    if (!active && !haveJobs && !initialJobBackfill) continue; // First fill captures runner type, later sync saves API calls.
    jobFetches++;
    try {
      const jobs = await gh(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/runs/${run.id}/jobs?per_page=100`);
      for (const job of jobs.jobs || []) upsertJob(normalizeJob(job, repo, run.id));
    } catch (err) {
      console.warn(`[workflow-store] jobs ${repo}#${run.id}: ${err.message}`);
    }
  }
}
async function sync(reason='periodic', onlyRepo='') {
  if (!APP_MODE && (!GITHUB_ORG || !GITHUB_TOKEN)) return snapshot();
  if (syncing) return syncing;
  if(rateLimitUntil>Date.now())return snapshot();
  if (!onlyRepo && BACKFILL_ON_EMPTY_ONLY && reason==='periodic' && Number(db.prepare('SELECT COUNT(*) AS n FROM github_live_runs').get().n) > 0) return snapshot();
  syncing = (async () => {
    const attempt = new Date().toISOString();
    db.prepare('UPDATE github_workflow_sync_state SET last_attempt_at=?,last_error=? WHERE singleton=1').run(attempt, '');
    try {
      const repos = onlyRepo ? [onlyRepo.includes('/')?onlyRepo:GITHUB_ORG+'/'+onlyRepo] : await reposToSync();
      upsertRepos(repos, attempt);
      initialJobBackfill = Number(db.prepare('SELECT COUNT(*) AS n FROM github_live_runs').get().n) === 0;
      const ordered=[...repos].sort((a,b)=>Number(b.toLowerCase().startsWith('nekosuneprojects/'))-Number(a.toLowerCase().startsWith('nekosuneprojects/')));
      const selected=onlyRepo?repos:Array.from({length:Math.min(REPOS_PER_CYCLE,ordered.length)},(_,i)=>ordered[(repoCursor+i)%ordered.length]);
      if(!onlyRepo && repos.length)repoCursor=(repoCursor+selected.length)%repos.length;
      jobFetches=0;
      for (const repo of selected) {
        if(rateLimitUntil>Date.now())break;
        try { await syncRepo(repo); }
        catch (err) { console.warn(`[workflow-store] ${repo}: ${err.message}`); if(rateLimitUntil>Date.now())break; }
      }
      const now = new Date().toISOString();
      db.prepare('UPDATE github_workflow_sync_state SET last_success_at=?,last_error=?,repos_synced=? WHERE singleton=1').run(now, rateLimitUntil>Date.now()?'GitHub API quota paused until '+new Date(rateLimitUntil).toISOString():'', selected.length);
      const snap = emitIfChanged(reason);
      console.log(`[workflow-store] sync ${reason}: scanned=${selected.length}/${repos.length} runs=${snap.runs.length} active_jobs=${snap.active_jobs.length}`);
      return snap;
    } catch (err) {
      db.prepare('UPDATE github_workflow_sync_state SET last_error=? WHERE singleton=1').run(err.message);
      console.warn(`[workflow-store] sync failed: ${err.message}; retaining SQLite workflow state.`);
      return snapshot();
    }
  })().finally(() => { syncing = null; });
  return syncing;
}

// Only poll jobs already known from signed webhooks. GitHub does not send
// per-step webhook updates: live steps are exposed by the authenticated Jobs API.
const STEP_POLL_MS=Math.max(30000,Math.min(Number(process.env.DASHBOARD_GITHUB_STEP_POLL_SECONDS||60)*1000,300000));
const STEP_POLL_LIMIT=Math.max(1,Math.min(Number(process.env.DASHBOARD_GITHUB_STEP_POLL_JOBS||2),5));
let stepPolling=false,stepCursor=0;
async function refreshActiveSteps(){
 if(stepPolling||rateLimitUntil>Date.now())return;
 const running=db.prepare("SELECT repo,run_id,job_id,json FROM github_live_jobs WHERE status='in_progress' ORDER BY updated_at DESC LIMIT 30").all();
 if(!running.length)return;
 stepPolling=true;
 try{
  const count=Math.min(STEP_POLL_LIMIT,running.length);
  for(let i=0;i<count;i++){
   const row=running[(stepCursor+i)%running.length];
   try{
    const [owner,repo]=row.repo.split('/');
    if(!owner||!repo)continue;
    // Unique query per poll bypasses the general metadata cache's 300s TTL.
    // Rate is bounded by STEP_POLL_MS and STEP_POLL_LIMIT.
    const data=await gh(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/jobs/${row.job_id}?neko_step_refresh=${Math.floor(Date.now()/STEP_POLL_MS)}`);
    if(Number(data.id)!==Number(row.job_id))continue;
    upsertJob(normalizeJob(data,row.repo,row.run_id));
   }catch(err){
    console.warn('[workflow-store] live steps '+row.repo+'#'+row.job_id+': '+err.message);
    if(rateLimitUntil>Date.now())break;
   }
  }
  stepCursor=(stepCursor+count)%running.length;
  emitIfChanged('live-step-poll');
 }finally{stepPolling=false}
}
const stepTimer=setInterval(()=>refreshActiveSteps().catch(err=>console.warn('[workflow-store] step poll: '+err.message)),STEP_POLL_MS);
stepTimer.unref();
setTimeout(() => sync('startup').catch(() => {}), 2500).unref();
const timer = setInterval(() => sync('periodic').catch(() => {}), SYNC_SECONDS * 1000);
timer.unref();

process.on('neko:github-webhook', payload => {
  const repo = String(payload?.repository?.full_name || '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return;
  // Signed GitHub workflow_job webhook contains the job owner, runner name,
  // workflow run ID and job timeline. Do not waste API requests to retrieve it.
  if (payload.workflow_job?.id && payload.workflow_job?.run_id) {
    try {
      const eventJob=payload.workflow_job;
      const job = normalizeJob(eventJob, repo, eventJob.run_id);
      upsertJob(job);
      // workflow_job can arrive without a workflow_run delivery. Store a
      // provisional run so Workflows and active runner matching still work.
      const exists=db.prepare('SELECT 1 FROM github_live_runs WHERE repo=? AND run_id=?').get(repo,job.run_id);
      if(!exists){
        upsertRun({
          id:job.run_id,repo,
          name:payload.workflow?.name||payload.workflow_name||'GitHub Actions',
          display_title:payload.workflow?.name||payload.workflow_name||job.name,
          run_number:Number(payload.run_number||0),
          status:job.status==='completed'?'completed':job.status==='in_progress'?'in_progress':'queued',
          conclusion:job.conclusion||null,
          branch:payload.workflow_job?.head_branch||payload.repository?.default_branch||'',
          actor:payload.sender?.login||'unknown',
          created_at:payload.workflow_job?.created_at||new Date().toISOString(),
          updated_at:new Date().toISOString(),
          html_url:'https://github.com/'+repo+'/actions/runs/'+job.run_id
        });
      }else{
        const current=db.prepare('SELECT json FROM github_live_runs WHERE repo=? AND run_id=?').get(repo,job.run_id);
        if(current){
          const run=JSON.parse(current.json);
          if(job.status==='in_progress'&&run.status==='queued')run.status='in_progress';
          if(job.status==='completed'&&run.status!=='completed')run.updated_at=new Date().toISOString();
          upsertRun(run);
        }
      }
      emitIfChanged('workflow-job-webhook');
    } catch (err) { console.warn('[workflow-store] workflow_job webhook: '+err.message); }
    return;
  }
  if (payload.workflow_run?.id) {
    try {
      upsertRun(normalizeRun(payload.workflow_run, repo));
      emitIfChanged('workflow-run-webhook');
    } catch (err) { console.warn('[workflow-store] workflow_run webhook: '+err.message); }
  }
});
process.on('neko:runner-sync', () => {
  const rows = db.prepare('SELECT repo,run_id,json FROM github_live_jobs').all();
  for (const row of rows) {
    const job = JSON.parse(row.json);
    const type = runnerType(job);
    if (job.runner_type !== type) { job.runner_type = type; upsertJob(job); }
  }
  emitIfChanged('runner-classification');
});

for (const signal of ['SIGTERM','SIGINT','SIGHUP']) process.once(signal, () => { try { clearInterval(timer); db.close(); } catch {} });

globalThis.__NEKO_WORKFLOW_STORE__ = { snapshot, sync };
console.log(`[workflow-store] SQLite workflow state enabled: sync=${SYNC_SECONDS}s runs/repo=${RUNS_PER_REPO}`);
