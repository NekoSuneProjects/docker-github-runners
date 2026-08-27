const http = require('http');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const originalCreateServer = http.createServer.bind(http);
const DB_FILE = process.env.DASHBOARD_DB_FILE || '/data/dashboard.sqlite';
const SESSION_COOKIE = 'neko_runner_session';
const LOGIN_USER = process.env.DASHBOARD_USERNAME || '';
const LOGIN_PASS = process.env.DASHBOARD_PASSWORD || '';
const LOGIN_PASS_SHA256 = String(process.env.DASHBOARD_PASSWORD_SHA256 || '').trim().toLowerCase();
const SESSION_SECRET = process.env.DASHBOARD_SESSION_SECRET || '';
const NODE_SHARED_SECRET = process.env.DASHBOARD_NODE_SHARED_SECRET || '';
const GITHUB_ORG = String(process.env.GITHUB_ORG || '').trim();
const GITHUB_TOKEN = process.env.GITHUB_DASHBOARD_TOKEN || process.env.ACCESS_TOKEN || '';
const NODE_OFFLINE_SECONDS = Math.max(15, Math.min(Number(process.env.DASHBOARD_NODE_OFFLINE_SECONDS || 45), 3600));
const API_VERSION = '2022-11-28';
const authConfigured = Boolean(LOGIN_USER && (LOGIN_PASS || LOGIN_PASS_SHA256));

const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA foreign_keys=ON;
  CREATE TABLE IF NOT EXISTS runner_controls (
    node_id TEXT PRIMARY KEY,
    runner_name TEXT NOT NULL,
    desired_state TEXT NOT NULL DEFAULT 'running',
    pending_action TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_runner_controls_runner ON runner_controls(runner_name);
`);

function equal(a,b){const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&crypto.timingSafeEqual(x,y)}
function cookies(req){const out={};for(const part of String(req.headers.cookie||'').split(';')){const i=part.indexOf('=');if(i<=0)continue;try{out[part.slice(0,i).trim()]=decodeURIComponent(part.slice(i+1).trim())}catch{}}return out}
function sign(v){return crypto.createHmac('sha256',SESSION_SECRET).update(v).digest('base64url')}
function authenticated(req){if(!authConfigured)return true;const token=cookies(req)[SESSION_COOKIE];if(!token)return false;const i=token.lastIndexOf('.');if(i<=0)return false;const payload=token.slice(0,i),sig=token.slice(i+1);if(!equal(sig,sign(payload)))return false;try{const d=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));return d.u===LOGIN_USER&&Number.isFinite(d.exp)&&d.exp>Math.floor(Date.now()/1000)}catch{return false}}
function nodeAuthorized(req){const h=String(req.headers.authorization||'');return Boolean(NODE_SHARED_SECRET&&h.startsWith('Bearer ')&&equal(h.slice(7),NODE_SHARED_SECRET))}
function json(res,status,value){const body=JSON.stringify(value);res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-length':Buffer.byteLength(body)});res.end(body)}
function readJson(req){return new Promise((resolve,reject)=>{let n=0,s='';req.on('data',c=>{n+=c.length;if(n>32768){reject(new Error('Request too large'));req.destroy();return}s+=c});req.on('end',()=>{try{resolve(JSON.parse(s||'{}'))}catch{reject(new Error('Invalid JSON'))}});req.on('error',reject)})}
function safeId(v){const s=String(v||'').trim();if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(s))throw new Error('Invalid node id');return s}
function safeRepo(v){const s=String(v||'').trim();if(!/^[A-Za-z0-9_.-]{1,100}$/.test(s))throw new Error('Invalid repository name');return s}
function safeRunId(v){const s=String(v||'').trim();if(!/^\d{1,24}$/.test(s))throw new Error('Invalid workflow run id');return s}
function controlForRunner(name){const row=db.prepare('SELECT node_id,runner_name,desired_state,pending_action,updated_at FROM runner_controls WHERE runner_name=?').get(String(name||''));return row||{node_id:null,runner_name:String(name||''),desired_state:'running',pending_action:null,updated_at:null}}
function controls(){return db.prepare(`SELECT c.node_id,c.runner_name,c.desired_state,c.pending_action,c.updated_at,n.name AS node_name,n.last_seen FROM runner_controls c LEFT JOIN nodes n ON n.id=c.node_id ORDER BY c.runner_name COLLATE NOCASE`).all()}

async function githubWorkflowAction(repo,runId,action){
  if(!GITHUB_ORG||!GITHUB_TOKEN)throw Object.assign(new Error('Dashboard GitHub token is not configured'),{status:503});
  const endpoint=action==='cancel'?'cancel':action==='force_cancel'?'force-cancel':action==='rerun'?'rerun':null;
  if(!endpoint)throw Object.assign(new Error('action must be cancel, force_cancel or rerun'),{status:400});
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),20000);
  timeout.unref?.();
  try{
    const r=await fetch(`https://api.github.com/repos/${encodeURIComponent(GITHUB_ORG)}/${encodeURIComponent(repo)}/actions/runs/${encodeURIComponent(runId)}/${endpoint}`,{
      method:'POST',
      headers:{Authorization:`Bearer ${GITHUB_TOKEN}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':API_VERSION,'User-Agent':'neko-runner-dashboard-control/1.0'},
      signal:controller.signal,
    });
    const body=await r.text().catch(()=> '');
    if(!r.ok){
      let message=`GitHub ${r.status}`;
      try{const parsed=JSON.parse(body);if(parsed.message)message+=`: ${parsed.message}`}catch{if(body)message+=`: ${body.slice(0,300)}`}
      if(r.status===403)message+=' — dashboard token needs Actions: write permission for this repository.';
      if(r.status===409)message+=' — GitHub cannot perform that action in the run current state.';
      throw Object.assign(new Error(message),{status:r.status});
    }
    return {ok:true,repo,run_id:runId,action,status:r.status};
  }finally{clearTimeout(timeout)}
}

function deleteOfflineNode(nodeId){
  const node=db.prepare('SELECT id,name,runner_name,last_seen FROM nodes WHERE id=?').get(nodeId);
  if(!node)throw Object.assign(new Error('Node not found'),{status:404});
  const seen=Date.parse(node.last_seen||'');
  const age=Number.isFinite(seen)?Math.max(0,Math.floor((Date.now()-seen)/1000)):Infinity;
  if(age<=NODE_OFFLINE_SECONDS)throw Object.assign(new Error(`Node is still online or was seen ${age}s ago. Wait until it is offline before deleting it.`),{status:409});

  db.exec('BEGIN IMMEDIATE');
  try{
    db.prepare('DELETE FROM runner_controls WHERE node_id=?').run(nodeId);
    db.prepare('DELETE FROM node_logs WHERE node_id=?').run(nodeId);
    db.prepare('DELETE FROM cleanup_commands WHERE node_id=?').run(nodeId);
    db.prepare('DELETE FROM nodes WHERE id=?').run(nodeId);
    db.exec('COMMIT');
  }catch(err){
    try{db.exec('ROLLBACK')}catch{}
    throw err;
  }
  return {ok:true,node_id:nodeId,node_name:node.name,runner_name:node.runner_name,offline_seconds:age};
}

http.createServer=function controlCreateServer(listener){
  return originalCreateServer(async(req,res)=>{
    let url;try{url=new URL(req.url,'http://localhost')}catch{url=new URL('http://localhost/')}
    const p=url.pathname;
    try{
      if(p==='/api/runner-controls'&&req.method==='GET'){
        if(!authenticated(req))return json(res,401,{error:'Authentication required'});
        return json(res,200,{controls:controls()});
      }
      if(p==='/api/node/runner-control'&&req.method==='POST'){
        if(!authenticated(req))return json(res,401,{error:'Authentication required'});
        const body=await readJson(req),nodeId=safeId(body.node_id),action=String(body.action||'').toLowerCase();
        if(!['start','stop','restart'].includes(action))return json(res,400,{error:'action must be start, stop or restart'});
        const node=db.prepare('SELECT id,name,runner_name FROM nodes WHERE id=?').get(nodeId);
        if(!node)return json(res,404,{error:'Node not found'});
        if(!node.runner_name)return json(res,409,{error:'Node has no runner name configured'});
        const desired=action==='stop'?'stopped':'running';
        const pending=action==='restart'?'restart':null;
        const now=new Date().toISOString();
        db.prepare(`INSERT INTO runner_controls(node_id,runner_name,desired_state,pending_action,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(node_id) DO UPDATE SET runner_name=excluded.runner_name,desired_state=excluded.desired_state,pending_action=excluded.pending_action,updated_at=excluded.updated_at`).run(nodeId,node.runner_name,desired,pending,now);
        return json(res,200,{ok:true,node_id:nodeId,node_name:node.name,runner_name:node.runner_name,desired_state:desired,pending_action:pending});
      }
      if(p==='/api/workflow/action'&&req.method==='POST'){
        if(!authenticated(req))return json(res,401,{error:'Authentication required'});
        const body=await readJson(req),repo=safeRepo(body.repo),runId=safeRunId(body.run_id),action=String(body.action||'').toLowerCase();
        const result=await githubWorkflowAction(repo,runId,action);
        return json(res,200,result);
      }
      if(p==='/api/node/delete'&&req.method==='POST'){
        if(!authenticated(req))return json(res,401,{error:'Authentication required'});
        const body=await readJson(req),nodeId=safeId(body.node_id);
        return json(res,200,deleteOfflineNode(nodeId));
      }
      if(p==='/internal/nodes/runner-control'&&req.method==='GET'){
        if(!nodeAuthorized(req))return json(res,401,{error:'Invalid node token'});
        return json(res,200,controlForRunner(url.searchParams.get('name')));
      }
      if(p==='/internal/nodes/runner-control-ack'&&req.method==='POST'){
        if(!nodeAuthorized(req))return json(res,401,{error:'Invalid node token'});
        const body=await readJson(req),runner=String(body.runner_name||'').trim(),action=String(body.action||'').trim();
        if(action==='restart'&&runner)db.prepare("UPDATE runner_controls SET pending_action=NULL,updated_at=? WHERE runner_name=? AND pending_action='restart'").run(new Date().toISOString(),runner);
        return json(res,200,{ok:true});
      }
    }catch(err){return json(res,Number(err.status)||400,{error:err.message||'Dashboard control error'})}
    return listener(req,res);
  });
};

for(const signal of ['SIGTERM','SIGINT','SIGHUP'])process.once(signal,()=>{try{db.close()}catch{}});
console.log('Runner control API: enabled');
console.log('Workflow actions: cancel / force-cancel / rerun enabled');
console.log(`Offline node deletion: enabled after ${NODE_OFFLINE_SECONDS}s offline`);
require('./server-realtime.js');
