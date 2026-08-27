'use strict';

const http = require('http');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { WebSocketServer, WebSocket } = require('ws');

const originalCreateServer = http.createServer.bind(http);
const DB_FILE = process.env.DASHBOARD_DB_FILE || '/data/dashboard.sqlite';
const SESSION_COOKIE = 'neko_runner_session';
const LOGIN_USER = process.env.DASHBOARD_USERNAME || '';
const LOGIN_PASS = process.env.DASHBOARD_PASSWORD || '';
const LOGIN_PASS_SHA256 = String(process.env.DASHBOARD_PASSWORD_SHA256 || '').trim().toLowerCase();
const SESSION_SECRET = process.env.DASHBOARD_SESSION_SECRET || '';
const WEBHOOK_SECRET = String(process.env.DASHBOARD_GITHUB_WEBHOOK_SECRET || '');
const NODE_OFFLINE_SECONDS = Math.max(15, Math.min(Number(process.env.DASHBOARD_NODE_OFFLINE_SECONDS || 45), 3600));
const WS_PING_SECONDS = Math.max(10, Math.min(Number(process.env.DASHBOARD_WS_PING_SECONDS || 30), 120));
const authConfigured = Boolean(LOGIN_USER && (LOGIN_PASS || LOGIN_PASS_SHA256));

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA busy_timeout=5000;');
const clients = new Set();
let lastRunnerHash = '';

function equal(a,b){const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&crypto.timingSafeEqual(x,y)}
function cookies(req){const out={};for(const part of String(req.headers.cookie||'').split(';')){const i=part.indexOf('=');if(i<=0)continue;try{out[part.slice(0,i).trim()]=decodeURIComponent(part.slice(i+1).trim())}catch{}}return out}
function sign(v){return crypto.createHmac('sha256',SESSION_SECRET).update(v).digest('base64url')}
function authenticated(req){if(!authConfigured)return true;const token=cookies(req)[SESSION_COOKIE];if(!token)return false;const i=token.lastIndexOf('.');if(i<=0)return false;const payload=token.slice(0,i),sig=token.slice(i+1);if(!equal(sig,sign(payload)))return false;try{const d=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));return d.u===LOGIN_USER&&Number.isFinite(d.exp)&&d.exp>Math.floor(Date.now()/1000)}catch{return false}}
function parseJson(v,f){try{return JSON.parse(v)}catch{return f}}
function nodeOnline(lastSeen){const t=Date.parse(lastSeen||'');return Number.isFinite(t)&&Date.now()-t<=NODE_OFFLINE_SECONDS*1000}
function json(res,status,value){const body=JSON.stringify(value);res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-length':Buffer.byteLength(body)});res.end(body)}
function readBody(req,max=1024*1024){return new Promise((resolve,reject)=>{let n=0;const chunks=[];req.on('data',c=>{n+=c.length;if(n>max){reject(new Error('Request too large'));req.destroy();return}chunks.push(c)});req.on('end',()=>resolve(Buffer.concat(chunks)));req.on('error',reject)})}

function nodeSnapshot(){
  let rows=[];try{rows=db.prepare('SELECT * FROM nodes ORDER BY name COLLATE NOCASE').all()}catch{}
  const nodes=rows.map(r=>({
    id:r.id,name:r.name,location:r.location,runner_name:r.runner_name,
    labels:parseJson(r.labels_json,[]),agent_version:r.agent_version,hostname:r.hostname,
    platform:r.platform,arch:r.arch,kernel:r.kernel,uptime_seconds:Number(r.uptime_seconds||0),
    metrics:parseJson(r.metrics_json,{}),storage:parseJson(r.storage_json,{}),log_file:r.log_file,
    sent_at:r.sent_at,last_seen:r.last_seen,online:nodeOnline(r.last_seen),
    runner_busy:r.runner_busy===null?null:Boolean(r.runner_busy),auto_cleanup:Boolean(r.auto_cleanup),
    include_volumes:Boolean(r.include_volumes),last_cleanup_at:r.last_cleanup_at,
    last_cleanup_reclaimed_bytes:Number(r.last_cleanup_reclaimed_bytes||0),
  }));
  return {nodes,summary:{total:nodes.length,online:nodes.filter(n=>n.online).length,reclaimable_bytes:nodes.reduce((a,n)=>a+Number(n.storage?.reclaimable_bytes||0),0)}};
}
function runnerSnapshot(){
  let rows=[];try{rows=db.prepare('SELECT * FROM github_runners ORDER BY api_present DESC, CASE status WHEN \'online\' THEN 0 ELSE 1 END, name COLLATE NOCASE').all()}catch{}
  return rows.map(r=>({
    id:Number(r.github_id),name:r.name,os:r.os||'unknown',status:r.api_present?(r.status||'offline'):'offline',
    busy:r.api_present?Boolean(r.busy):false,labels:parseJson(r.labels_json,[]),api_present:Boolean(r.api_present),
    first_seen_at:r.first_seen_at,last_seen_api_at:r.last_seen_api_at,last_full_sync_at:r.last_full_sync_at,
    runner_type:'self_hosted',
  }));
}
function controlSnapshot(){try{return db.prepare('SELECT node_id,runner_name,desired_state,pending_action,updated_at FROM runner_controls ORDER BY runner_name COLLATE NOCASE').all()}catch{return[]}}
function workflowSnapshot(){return globalThis.__NEKO_WORKFLOW_STORE__?.snapshot?.()||{runs:[],jobs_by_run:{},active_jobs:[],sync:{}}}
function overviewSnapshot(){
  const runners=runnerSnapshot(),wf=workflowSnapshot();
  const runs=wf.runs||[];const oneDay=Date.now()-86400000;
  return {
    generated_at:new Date().toISOString(),runners,runs,active_jobs:wf.active_jobs||[],repos:[...new Set(runs.map(r=>r.repo))],
    jobs_by_run:wf.jobs_by_run||{},
    summary:{
      runners_total:runners.length,runners_online:runners.filter(r=>r.status==='online').length,
      runners_busy:runners.filter(r=>r.busy).length,
      active_runs:runs.filter(r=>['queued','in_progress','waiting','pending','requested'].includes(String(r.status))).length,
      failed_24h:runs.filter(r=>r.conclusion==='failure'&&Date.parse(r.updated_at||r.created_at)>=oneDay).length,
    },
  };
}
function fullSnapshot(){return {overview:overviewSnapshot(),nodes:nodeSnapshot(),controls:{controls:controlSnapshot()},at:new Date().toISOString()}}
function send(ws,type,data){if(ws.readyState!==WebSocket.OPEN)return;try{ws.send(JSON.stringify({type,data,at:new Date().toISOString()}))}catch{}}
function broadcast(type,data){for(const ws of clients)send(ws,type,data)}
function broadcastNodes(){broadcast('nodes',nodeSnapshot())}
function broadcastControls(){broadcast('controls',{controls:controlSnapshot()})}
function broadcastRunners(){broadcast('runners',{runners:runnerSnapshot()})}

function runnerHash(){return crypto.createHash('sha256').update(JSON.stringify(runnerSnapshot())).digest('hex')}

async function handleWebhook(req,res){
  if(!WEBHOOK_SECRET)return json(res,404,{error:'GitHub webhook endpoint is disabled'});
  const body=await readBody(req);
  const supplied=String(req.headers['x-hub-signature-256']||'');
  const expected='sha256='+crypto.createHmac('sha256',WEBHOOK_SECRET).update(body).digest('hex');
  if(!equal(supplied,expected))return json(res,401,{error:'Invalid GitHub webhook signature'});
  let payload;try{payload=JSON.parse(body.toString('utf8')||'{}')}catch{return json(res,400,{error:'Invalid webhook JSON'})}
  const event=String(req.headers['x-github-event']||'unknown');
  if(['workflow_job','workflow_run','check_run','ping'].includes(event)){
    process.emit('neko:github-webhook',payload);
    broadcast('github-webhook',{event,repository:payload?.repository?.name||'',action:payload?.action||''});
  }
  return json(res,202,{ok:true,event});
}

http.createServer=function websocketCreateServer(listener){
  const server=originalCreateServer(async(req,res)=>{
    let url;try{url=new URL(req.url,'http://localhost')}catch{url=new URL('http://localhost/')}
    if(url.pathname==='/api/github/webhook'&&req.method==='POST'){
      try{return await handleWebhook(req,res)}catch(err){return json(res,400,{error:err.message})}
    }
    const pushNodes=['/internal/nodes/heartbeat','/api/node/settings','/api/node/cleanup','/api/node/delete'].includes(url.pathname);
    const pushControls=['/api/node/runner-control','/internal/nodes/runner-control-ack'].includes(url.pathname);
    if(pushNodes||pushControls){res.once('finish',()=>{if(res.statusCode>=200&&res.statusCode<300){if(pushNodes)setTimeout(broadcastNodes,25);if(pushControls)setTimeout(broadcastControls,25)}})}
    return listener(req,res);
  });

  const wss=new WebSocketServer({noServer:true});
  server.on('upgrade',(req,socket,head)=>{
    let url;try{url=new URL(req.url,'http://localhost')}catch{return socket.destroy()}
    if(url.pathname!=='/ws')return socket.destroy();
    if(!authenticated(req))return socket.destroy();
    wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));
  });
  wss.on('connection',ws=>{
    ws.isAlive=true;clients.add(ws);
    ws.on('pong',()=>{ws.isAlive=true});
    ws.on('close',()=>clients.delete(ws));
    ws.on('error',()=>clients.delete(ws));
    send(ws,'snapshot',fullSnapshot());
  });
  server.once('close',()=>{for(const ws of clients){try{ws.close(1001,'server stopping')}catch{}}clients.clear();try{wss.close()}catch{}});
  return server;
};

process.on('neko:workflow-sync',evt=>broadcast('workflows',evt.snapshot||workflowSnapshot()));
process.on('neko:github-cache-updated',evt=>broadcast('cache-updated',evt));

const runnerWatcher=setInterval(()=>{const h=runnerHash();if(h!==lastRunnerHash){lastRunnerHash=h;broadcastRunners()}},5000);runnerWatcher.unref();
const pingTimer=setInterval(()=>{for(const ws of [...clients]){if(ws.isAlive===false){clients.delete(ws);try{ws.terminate()}catch{};continue}ws.isAlive=false;try{ws.ping()}catch{}}},WS_PING_SECONDS*1000);pingTimer.unref();

for(const signal of ['SIGTERM','SIGINT','SIGHUP'])process.once(signal,()=>{try{clearInterval(runnerWatcher);clearInterval(pingTimer);db.close()}catch{}});
console.log(`[websocket] live dashboard enabled on /ws; ping=${WS_PING_SECONDS}s webhook=${WEBHOOK_SECRET?'enabled':'disabled'}`);
