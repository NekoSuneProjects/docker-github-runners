'use strict';

const fs = require('fs');

function patchFile(file, replacements) {
  let source = fs.readFileSync(file, 'utf8');
  for (const [from, to, label] of replacements) {
    if (!source.includes(from)) throw new Error(`${file}: workload patch failed at ${label}`);
    source = source.replace(from, to);
  }
  fs.writeFileSync(file, source);
}

patchFile('/app/server.js', [
  [
    '`);\n\nfunction securityHeaders()',
    "`);\ntry { db.exec(\"ALTER TABLE nodes ADD COLUMN workload_json TEXT DEFAULT '{}'\"); } catch {}\n\nfunction securityHeaders()",
    'nodes workload column',
  ],
  [
    'last_cleanup_reclaimed_bytes: Number(row.last_cleanup_reclaimed_bytes || 0) };',
    "last_cleanup_reclaimed_bytes: Number(row.last_cleanup_reclaimed_bytes || 0), current_workload: parseJson(row.workload_json, {}) };",
    'public node workload',
  ],
]);

patchFile('/app/server-websocket.js', [
  [
    "const WEBHOOK_SECRET = String(process.env.DASHBOARD_GITHUB_WEBHOOK_SECRET || '');",
    "const WEBHOOK_SECRET = String(process.env.DASHBOARD_GITHUB_WEBHOOK_SECRET || '');\nconst NODE_SHARED_SECRET = String(process.env.DASHBOARD_NODE_SHARED_SECRET || '');",
    'node secret',
  ],
  [
    "function authenticated(req){if(!authConfigured)return true;const token=cookies(req)[SESSION_COOKIE];if(!token)return false;const i=token.lastIndexOf('.');if(i<=0)return false;const payload=token.slice(0,i),sig=token.slice(i+1);if(!equal(sig,sign(payload)))return false;try{const d=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));return d.u===LOGIN_USER&&Number.isFinite(d.exp)&&d.exp>Math.floor(Date.now()/1000)}catch{return false}}",
    "function authenticated(req){if(!authConfigured)return true;const token=cookies(req)[SESSION_COOKIE];if(!token)return false;const i=token.lastIndexOf('.');if(i<=0)return false;const payload=token.slice(0,i),sig=token.slice(i+1);if(!equal(sig,sign(payload)))return false;try{const d=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));return d.u===LOGIN_USER&&Number.isFinite(d.exp)&&d.exp>Math.floor(Date.now()/1000)}catch{return false}}\nfunction nodeAuthorized(req){const h=String(req.headers.authorization||'');return Boolean(NODE_SHARED_SECRET&&h.startsWith('Bearer ')&&equal(h.slice(7),NODE_SHARED_SECRET))}",
    'node authorization',
  ],
  [
    "include_volumes:Boolean(r.include_volumes),last_cleanup_at:r.last_cleanup_at,\n    last_cleanup_reclaimed_bytes:Number(r.last_cleanup_reclaimed_bytes||0),",
    "include_volumes:Boolean(r.include_volumes),last_cleanup_at:r.last_cleanup_at,\n    last_cleanup_reclaimed_bytes:Number(r.last_cleanup_reclaimed_bytes||0),current_workload:parseJson(r.workload_json,{}),",
    'websocket node workload',
  ],
  [
    "if(url.pathname==='/api/github/webhook'&&req.method==='POST'){",
    `if(url.pathname==='/internal/nodes/workload'&&req.method==='POST'){
      if(!nodeAuthorized(req))return json(res,401,{error:'Invalid node token'});
      try{
        const raw=await readBody(req,131072);const body=JSON.parse(raw.toString('utf8')||'{}');
        const id=String(body.node_id||'').trim();
        if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id))return json(res,400,{error:'Invalid node id'});
        const w=body.workload&&typeof body.workload==='object'?body.workload:{};
        const safe={
          active:Boolean(w.active),repository:String(w.repository||'').slice(0,220),job:String(w.job||'').slice(0,240),
          started_at:w.started_at?String(w.started_at).slice(0,64):null,repository_last_run_at:w.repository_last_run_at?String(w.repository_last_run_at).slice(0,64):null,
          source:String(w.source||'runner-local').slice(0,40),confidence:String(w.confidence||'low').slice(0,20),detected_at:String(w.detected_at||new Date().toISOString()).slice(0,64)
        };
        const result=db.prepare('UPDATE nodes SET workload_json=? WHERE id=?').run(JSON.stringify(safe),id);
        if(!result.changes)return json(res,404,{error:'Node not found'});
        setTimeout(broadcastNodes,10);
        return json(res,200,{ok:true,node_id:id,current_workload:safe});
      }catch(err){return json(res,400,{error:err.message||'Invalid workload payload'})}
    }
    if(url.pathname==='/api/github/webhook'&&req.method==='POST'){`,
    'workload endpoint',
  ],
]);

console.log('[dashboard-build] node workload persistence/WebSocket patch applied');
