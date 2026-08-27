(()=>{
const STYLE=`
.neko-runner-extra{margin-top:10px;padding-top:10px;border-top:1px solid #263247;display:grid;gap:8px}.neko-workload{background:#0b1220;border:1px solid #23324a;border-radius:9px;padding:9px}.neko-workload-label{font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:#7f91aa;margin-bottom:4px}.neko-workload-repo{font-size:13px;font-weight:800;color:#9fb7ff}.neko-workload-title{font-size:12px;font-weight:700;margin-top:2px}.neko-workload-meta{font-size:10px;color:#8fa0b8;margin-top:3px}.neko-control-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.neko-control-btn{border:1px solid #33425a;background:#172033;color:#e8edf7;border-radius:7px;padding:6px 9px;font:600 10px system-ui;cursor:pointer}.neko-control-btn:hover{border-color:#61769a}.neko-control-btn.stop{color:#ffabb4;border-color:#633b45;background:#25151b}.neko-control-btn.start{color:#77e5ae;border-color:#315b49;background:#10231c}.neko-control-btn.restart{color:#ffd879;border-color:#64552b;background:#241f10}.neko-control-state{font-size:10px;color:#8fa0b8}.neko-control-state.stopped{color:#ff8793}.neko-repo-cell b{display:inline-block;background:#16243c;border:1px solid #2d4267;border-radius:6px;padding:4px 7px;color:#a9c3ff}.neko-runner-node{font-size:9px;color:#8fa0b8;margin-top:3px}.neko-node-inline{margin-top:8px}.neko-action-msg{font-size:10px;color:#83d9ff}
`;
const style=document.createElement('style');style.textContent=STYLE;document.head.appendChild(style);
let state={overview:null,nodes:null,controls:null};
let busy=false;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function j(url,opt={}){const r=await fetch(url,{credentials:'same-origin',cache:'no-store',...opt,headers:{...(opt.body?{'content-type':'application/json'}:{}),...(opt.headers||{})}});if(r.status===401){location='/login';throw Error('Authentication required')}if(!r.ok){let e;try{e=(await r.json()).error}catch{e=await r.text()}throw Error(e||`HTTP ${r.status}`)}return r.json()}
function maps(){
 const runs=new Map((state.overview?.runs||[]).map(r=>[String(r.id),r]));
 const workload=new Map();
 for(const job of state.overview?.active_jobs||[]){if(!job.runner_name)continue;const run=runs.get(String(job.run_id));workload.set(job.runner_name,{repo:job.repo,workflow:run?.display_title||run?.name||'Workflow',branch:run?.branch||'–',job:job.name,status:job.status,run_id:job.run_id,url:run?.html_url||''})}
 const nodesByRunner=new Map((state.nodes?.nodes||[]).filter(n=>n.runner_name).map(n=>[n.runner_name,n]));
 const nodesById=new Map((state.nodes?.nodes||[]).map(n=>[n.id,n]));
 const controls=new Map((state.controls?.controls||[]).map(c=>[c.runner_name,c]));
 return{workload,nodesByRunner,nodesById,controls};
}
function workloadHtml(w){return w?`<div class="neko-workload"><div class="neko-workload-label">Current repository / job</div><div class="neko-workload-repo">${esc(w.repo)}</div><div class="neko-workload-title">${esc(w.workflow)}</div><div class="neko-workload-meta">branch ${esc(w.branch)} • job ${esc(w.job)} • ${esc(w.status)}</div></div>`:`<div class="neko-workload"><div class="neko-workload-label">Current repository / job</div><div class="neko-workload-title">Idle — no repository assigned</div></div>`}
function buttonsHtml(node,runner,control,w){if(!node)return`<div class="neko-control-state">No node agent matches this runner, so remote controls are unavailable.</div>`;const stopped=control?.desired_state==='stopped';return`<div class="neko-control-row"><button class="neko-control-btn ${stopped?'start':'stop'}" data-runner-action="${stopped?'start':'stop'}" data-node-id="${esc(node.id)}" data-runner="${esc(runner)}">${stopped?'▶ Start runner':'■ Stop runner'}</button><button class="neko-control-btn restart" data-runner-action="restart" data-node-id="${esc(node.id)}" data-runner="${esc(runner)}">↻ Restart</button><span class="neko-control-state ${stopped?'stopped':''}">${stopped?'Stopped by dashboard':'Managed / running'}</span></div><div class="neko-action-msg" data-msg-for="${esc(node.id)}"></div>`}
function enhance(){
 const m=maps();
 document.querySelectorAll('#runnerList .runner').forEach(card=>{
   const name=card.querySelector('.runner-name')?.textContent?.trim();if(!name)return;
   let extra=card.querySelector('.neko-runner-extra');if(!extra){extra=document.createElement('div');extra.className='neko-runner-extra';card.appendChild(extra)}
   const node=m.nodesByRunner.get(name),control=m.controls.get(name),w=m.workload.get(name);
   extra.innerHTML=workloadHtml(w)+buttonsHtml(node,name,control,w);
 });
 document.querySelectorAll('.node-card[data-node]').forEach(card=>{
   const node=m.nodesById.get(card.dataset.node);if(!node)return;
   let extra=card.querySelector('.neko-runner-extra');if(!extra){extra=document.createElement('div');extra.className='neko-runner-extra neko-node-inline';card.appendChild(extra)}
   const w=m.workload.get(node.runner_name),control=m.controls.get(node.runner_name);
   extra.innerHTML=workloadHtml(w)+buttonsHtml(node,node.runner_name,control,w);
 });
 document.querySelectorAll('#workflowRows tr').forEach(row=>{
   const cells=row.querySelectorAll('td');if(!cells.length)return;cells[0].classList.add('neko-repo-cell');
   const runner=cells[4]?.textContent?.trim();if(runner&&runner!=='–'&&!cells[4].querySelector('.neko-runner-node')){const node=m.nodesByRunner.get(runner);if(node){const d=document.createElement('div');d.className='neko-runner-node';d.textContent=`Node: ${node.name}`;cells[4].appendChild(d)}}
 });
 bindButtons();
}
function bindButtons(){document.querySelectorAll('[data-runner-action]').forEach(btn=>{if(btn.dataset.bound)return;btn.dataset.bound='1';btn.addEventListener('click',async e=>{e.preventDefault();e.stopPropagation();const action=btn.dataset.runnerAction,nodeId=btn.dataset.nodeId,runner=btn.dataset.runner;const w=maps().workload.get(runner);if(action==='stop'){const msg=w?`Stop ${runner}?\n\nIt is currently running ${w.repo} / ${w.workflow}. Stopping the runner can interrupt or fail that GitHub job.`:`Stop ${runner}?`;if(!confirm(msg))return}else if(action==='restart'&&w){if(!confirm(`Restart ${runner}?\n\nIt is currently running ${w.repo} / ${w.workflow}. Restarting can interrupt the active job.`))return}btn.disabled=true;const msg=document.querySelector(`[data-msg-for="${CSS.escape(nodeId)}"]`);if(msg)msg.textContent=`Sending ${action}…`;try{await j('/api/node/runner-control',{method:'POST',body:JSON.stringify({node_id:nodeId,action})});if(msg)msg.textContent=`${action} command accepted.`;setTimeout(load,700)}catch(err){if(msg)msg.textContent=`Error: ${err.message}`}finally{btn.disabled=false}})})}
async function load(){if(busy)return;busy=true;try{const[o,n,c]=await Promise.all([j('/api/overview'),j('/api/nodes'),j('/api/runner-controls')]);state={overview:o,nodes:n,controls:c};enhance()}catch(err){console.error('[runner-controls]',err)}finally{busy=false}}
const observer=new MutationObserver(()=>{if(state.overview)enhance()});observer.observe(document.body,{childList:true,subtree:true});
setInterval(load,10000);setTimeout(load,400);
})();
