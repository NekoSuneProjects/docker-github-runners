(()=>{
const live={overview:null,nodes:null,controls:null};
let selectedRunner=null;
let activeDrawer='';
const $=id=>document.getElementById(id);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtBytes=n=>{n=Number(n)||0;for(const u of['B','KB','MB','GB','TB']){if(n<1024||u==='TB')return`${n<10&&u!=='B'?n.toFixed(1):Math.round(n)} ${u}`;n/=1024}};
const ago=v=>{if(!v)return'–';const t=Date.parse(v),s=Number.isFinite(t)?Math.max(0,Math.floor((Date.now()-t)/1000)):0;if(s<60)return`${s}s ago`;if(s<3600)return`${Math.floor(s/60)}m ago`;if(s<86400)return`${Math.floor(s/3600)}h ago`;return`${Math.floor(s/86400)}d ago`};
const elapsed=v=>{if(!v)return'–';let s=Math.max(0,Math.floor((Date.now()-Date.parse(v))/1000));const h=Math.floor(s/3600);s%=3600;const m=Math.floor(s/60);s%=60;return h?`${h}h ${m}m`:m?`${m}m ${s}s`:`${s}s`};
const badge=(status,conclusion)=>conclusion||status||'neutral';
async function api(url,opt={}){const r=await fetch(url,{credentials:'same-origin',cache:'no-store',...opt,headers:{...(opt.body?{'content-type':'application/json'}:{}),...(opt.headers||{})}});if(r.status===401){location='/login';throw Error('Authentication required')}if(!r.ok){let e;try{e=(await r.json()).error}catch{e=await r.text()}throw Error(e||`HTTP ${r.status}`)}return opt.text?r.text():r.json()}
const style=document.createElement('style');style.textContent=`
.runner-type{display:inline-flex;align-items:center;border:1px solid #34435c;border-radius:999px;padding:2px 6px;font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;margin-left:5px}.runner-type.self{color:#8be7b7;border-color:#315b49}.runner-type.public{color:#9fc0ff;border-color:#3b527e}.runner-type.external{color:#ffd47e;border-color:#66542a}.live-updated{animation:nekoLivePulse .45s ease}@keyframes nekoLivePulse{0%{box-shadow:0 0 0 0 rgba(111,154,255,.28)}100%{box-shadow:0 0 0 8px rgba(111,154,255,0)}}
 .runner[data-runner-expand]{cursor:pointer}.runner[data-runner-expand]:focus-visible{outline:2px solid #86b7ff}.runner-detail{margin-top:12px;padding:10px;border:1px solid #304462;border-radius:9px;background:#0a1627}.runner-detail-line{font-size:11px;margin:5px 0;overflow-wrap:anywhere}.runner-progress{height:7px;background:#23314a;border-radius:8px;overflow:hidden;margin-top:7px}.runner-progress>i{display:block;height:100%;background:#65b5f3}.runner-console{background:#050c15;border:1px solid #2c3e55;border-radius:8px;color:#c6ecce;font:11px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;padding:12px;max-height:300px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;margin-top:8px}
 .runner-indeterminate{position:relative;overflow:hidden}.runner-indeterminate>i{width:34%!important;position:absolute;left:0;animation:nekoIndeterminate 1.65s ease-in-out infinite}@keyframes nekoIndeterminate{0%{transform:translateX(-110%)}100%{transform:translateX(320%)}}@media(prefers-reduced-motion:reduce){.runner-indeterminate>i{animation:none;left:33%}}
`;document.head.appendChild(style);
function setStatus(t,on=true){if($('status'))$('status').textContent=t;if($('sideLive'))$('sideLive').textContent=t;if($('liveDot'))$('liveDot').classList.toggle('live',on)}
function typeLabel(t){return t==='self_hosted'?'Self-hosted':t==='github_hosted'?'GitHub-hosted':t==='external'?'External runner':t==='waiting'?'Waiting':'Unknown'}
function typeClass(t){return t==='self_hosted'?'self':t==='github_hosted'?'public':'external'}
function nodeByRunner(name){return(live.nodes?.nodes||[]).find(n=>n.runner_name===name)||null}
function jobsFor(runId){return live.overview?.jobs_by_run?.[String(runId)]||[]}
function activeJob(runId){const jobs=jobsFor(runId);return jobs.find(j=>j.status==='in_progress')||jobs.find(j=>j.status==='queued')||jobs.find(j=>j.runner_name)||jobs[0]||null}
function progress(run){const jobs=jobsFor(run.id),steps=jobs.flatMap(j=>(j.steps||[]).map(s=>({...s,job_name:j.name,runner_name:j.runner_name,runner_type:j.runner_type})));const total=steps.length,done=steps.filter(s=>s.status==='completed').length,current=steps.find(s=>s.status==='in_progress')||steps.find(s=>s.status==='queued')||null;let pct=total?Math.round(done/total*100):0;if(run.status==='completed'&&run.conclusion==='success')pct=100;return{jobs,total,done,current,pct,job:activeJob(run.id)}}
function pulse(el){if(!el)return;el.classList.remove('live-updated');void el.offsetWidth;el.classList.add('live-updated')}
function keyed(container,items,keyFn,makeFn,updateFn,existingKeyFn){if(!container)return;const old=new Map();for(const child of [...container.children]){let key=child.dataset.liveKey||existingKeyFn?.(child)||'';if(key){child.dataset.liveKey=String(key);old.set(String(key),child)}else if(child.classList.contains('empty'))child.remove()}for(const item of items){const key=String(keyFn(item));let el=old.get(key);if(!el){el=makeFn(item);el.dataset.liveKey=key;container.appendChild(el);pulse(el)}else old.delete(key);updateFn(el,item)}for(const el of old.values())el.remove()}
function liveBase(el,html){
 let base=el.querySelector(':scope > .live-base');
 if(!base){
  const extras=[...el.children].filter(x=>x.classList?.contains('neko-runner-extra')||x.classList?.contains('neko-row-workflow-controls'));
  el.innerHTML='<div class="live-base"></div>';base=el.querySelector(':scope > .live-base');
  for(const x of extras){x.querySelectorAll('[data-rc-bound],[data-wf-bound],[data-delete-bound]').forEach(b=>{delete b.dataset.rcBound;delete b.dataset.wfBound;delete b.dataset.deleteBound});el.appendChild(x)}
 }
 if(base.dataset.html!==html){
  const oldConsole=base.querySelector('.runner-console');
  const atBottom=!oldConsole||oldConsole.scrollHeight-oldConsole.scrollTop-oldConsole.clientHeight<=20;
  const oldScroll=oldConsole?.scrollTop||0;
  base.dataset.html=html;base.innerHTML=html;
  const next=base.querySelector('.runner-console');
  if(next){next.scrollTop=atBottom?next.scrollHeight:oldScroll}
  pulse(el);
 }
}
function nodeWorkflowsEnabled(){return live.nodes?.node_workflow_enabled!==false && live.overview?.node_workflow_enabled!==false}
function fleetContainers(){return (live.nodes?.nodes||[]).filter(n=>n.online).flatMap(n=>(n.fleet_runners||[]).filter(r=>r.running).map(r=>({...r,node_name:n.name})))}
function renderMetrics(){const o=live.overview?.summary||{},n=live.nodes?.summary||{},fleet=fleetContainers(),hasGitHub=fleet.length===0&&Number(o.runners_total||0)>0;if($('mRunners'))$('mRunners').textContent=hasGitHub?o.runners_total:fleet.length;if($('mRunnersSub'))$('mRunnersSub').textContent=hasGitHub?`${o.runners_online??0} online`:`${fleet.length} active containers`;if($('mBusy'))$('mBusy').textContent=fleet.length?fleet.filter(r=>r.job_state==='busy').length:(o.runners_busy??'–');if($('mNodes'))$('mNodes').textContent=n.total??'–';if($('mNodesSub'))$('mNodesSub').textContent=`${n.online??'–'} online`;if($('mClean'))$('mClean').textContent=fmtBytes(n.reclaimable_bytes);if($('mActive'))$('mActive').textContent=o.active_runs??'–';if($('mFailures'))$('mFailures').textContent=o.failed_24h??'–'}
function runnerInner(r){const work=(live.overview?.active_jobs||[]).find(j=>j.runner_name===r.name),node=nodeByRunner(r.name);return`<div class="runner-top"><div class="runner-name">${esc(r.name)}</div><span class="badge ${r.status==='online'?(r.busy?'busy':'idle'):'offline'}">${r.status==='online'?(r.busy?'busy':'idle'):'offline'}</span></div><div class="runner-labels">${esc(r.os)} • ${esc((r.labels||[]).join(', '))}<span class="runner-type self">Self-hosted</span></div>${work?`<div class="node-sub" style="margin-top:7px">${esc(work.repo)} • ${esc(work.name||'job')} • ${esc(node?.name||'node not matched')}</div>`:''}`}
function matchingJob(r){
 const norm=v=>String(v||'').toLowerCase().replace(/^neko-runner-/,'').replace(/[^a-z0-9]/g,'');
 const candidates=[r.container,r.name,r.target].filter(Boolean).map(norm);
 const jobs=live.overview?.active_jobs||[];
 return jobs.find(j=>j.runner_name&&candidates.includes(norm(j.runner_name)))||null;
}
function runnerDetail(r){
 const job=matchingJob(r);
 const run=(live.overview?.runs||[]).find(x=>String(x.id)===String(job?.run_id));
 const p=run?progress(run):null;
 const repo=job?.repo||r.job_repo||run?.repo||'Not yet reported';
 const node=(live.nodes?.nodes||[]).find(n=>(n.fleet_runners||[]).some(x=>x.container===r.container))||null;
 const url=run?.html_url||r.job_run_url||(job?.repo&&job?.run_id?'https://github.com/'+job.repo+'/actions/runs/'+job.run_id:'');
 const trusted=/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/\d+(?:\/.*)?$/.test(url);
 return `<div class="runner-detail" data-runner-detail>
 <b>Live runner activity</b>
 <div class="runner-detail-line" style="margin-top:10px"><b>Runner console</b> · Last actual output: ${r.console_last_output_at?ago(r.console_last_output_at):'timestamp unavailable'} · Heartbeat updates are not necessarily new log lines</div>
 <pre class="runner-console">${esc(r.console_tail||'Waiting for runner console output…')}</pre>
 <div class="runner-detail-line">Repository: <b>${esc(repo)}</b></div>
 <div class="runner-detail-line">Workflow: ${esc(run?.name||job?.workflow_name||r.job_workflow||'Not reported')}</div>
 <div class="runner-detail-line">Job: ${esc(job?.name||r.job_name||'Not reported')}</div>
 <div class="runner-detail-line">Branch: ${esc(run?.branch||job?.branch||r.job_branch||'Unknown')}</div><div class="runner-detail-line">Commit: ${esc(r.job_sha||'Unknown')} · Trigger: ${esc(r.job_event||'Unknown')} · Actor: ${esc(r.job_actor||'Unknown')}</div>
 <div class="runner-detail-line">Node: ${esc(r.node_name||'Unknown')} · Container: ${esc(r.container||r.name)}</div>
 <div class="runner-detail-line">Runner target: ${esc(r.target||r.name||'Unspecified')} · Status: ${esc(r.job_state||r.status||'Unknown')}</div>
 ${node?`<div class="runner-detail-line">Node load: ${Number(node.metrics?.load_1||0).toFixed(2)} · Memory: ${Number(node.metrics?.memory_used_percent||0).toFixed(0)}% · Cleanable: ${fmtBytes(node.storage?.reclaimable_bytes)}</div>`:'' }
 ${p&&p.total?`<div class="runner-detail-line">Progress: ${p.done}/${p.total} steps (${p.pct}%)</div><div class="runner-progress"><i style="width:${p.pct}%"></i></div><div class="runner-detail-line">Current step: ${esc(p.current?.name||'Awaiting update')}</div>`: '<div class="runner-detail-line">Step progress unavailable until GitHub sends job step details.</div>'}
 ${trusted?`<div class="runner-detail-line"><a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open GitHub workflow run ↗</a></div>`:''}
 </div>`;
}
function openRunner(key){
 selectedRunner=key;activeDrawer='runner';
 drawerOpen('Runner activity','Live node agent · self-hosted', '<div id="runnerDrawerContent"></div>');
 refreshRunnerDrawer();
}
function refreshRunnerDrawer(){
 if(activeDrawer!=='runner'||!selectedRunner||!$('drawer')?.classList.contains('open'))return;
 const r=fleetContainers().find(x=>'node:'+x.container===selectedRunner)||
   (live.overview?.runners||[]).find(x=>'github:'+x.name===selectedRunner);
 const content=$('runnerDrawerContent');
 if(!content)return;
 if(!r){content.innerHTML='<div class="empty">Runner no longer online. Waiting for a fresh heartbeat.</div>';return}
 const job=matchingJob(r);
 const run=(live.overview?.runs||[]).find(x=>String(x.id)===String(job?.run_id));
 const node=(live.nodes?.nodes||[]).find(n=>(n.fleet_runners||[]).some(x=>x.container===r.container))||null;
 const header=String(r.target||r.name||r.container);
 $('drawerTitle').textContent=header;
 $('drawerMeta').textContent=(node?.name||r.node_name||'Self-hosted')+' · '+(r.job_state==='busy'?'Busy':r.job_state==='idle'?'Idle':'Running');
 const inner=runnerDetail(r);
 if(content.dataset.html!==inner){
  const prev=content.querySelector('.runner-console');
  const atBottom=!prev||prev.scrollHeight-prev.scrollTop-prev.clientHeight<=24;
  const oldTop=prev?.scrollTop||0;
  const oldDrawerScroll=$('drawerBody')?.scrollTop||0;
  content.dataset.html=inner;content.innerHTML=inner;
  const next=content.querySelector('.runner-console');
  if(next)next.scrollTop=atBottom?next.scrollHeight:oldTop;
  if($('drawerBody'))$('drawerBody').scrollTop=oldDrawerScroll;
 }
}
function renderRunners(){
 const github=live.overview?.runners||[],fleet=fleetContainers(),c=$('runnerList');
 if(!c)return;
 const known=new Set(github.map(r=>String(r.name||'').toLowerCase()));
 const extras=fleet.filter(r=>!known.has(String(r.target||'').toLowerCase())&&!known.has(String(r.container||'').toLowerCase()));
 const items=fleet.length?fleet.map(r=>({...r,_source:'node'})):github.map(r=>({...r,_source:'github'}));
 if(!items.length){c.innerHTML='<div class="empty">No runner containers reported by connected nodes.</div>';return}
 keyed(c,items,r=>r._source==='github'?'github:'+r.name:'node:'+r.container,()=>{const e=document.createElement('article');e.className='runner';e.tabIndex=0;e.setAttribute('role','button');e.addEventListener('click',ev=>{if(ev.target.closest('a,button,input'))return;openRunner(e.dataset.liveKey)});e.addEventListener('keydown',ev=>{if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();e.click()}});return e},(e,r)=>{
  const current=matchingJob(r);
  const html=r._source==='github'?runnerInner(r):`<div class="runner-top"><div class="runner-name">${esc(r.target||r.container)}</div><span class="badge ${r.job_state==='busy'?'busy':'online'}">${r.job_state==='busy'?'Busy':r.job_state==='idle'?'Idle':'Running'}</span></div><div class="runner-labels">${esc(r.node_name)} • ${esc(r.scope||'runner')} • ${esc(r.container)}</div><div class="node-sub">${r.job_state==='busy'?'Current job: '+esc(r.job_name||'Unknown')+(r.job_repo?' • '+esc(r.job_repo):''):r.job_state==='idle'?'Listener idle':'Container running; job state unknown'} • node-reported</div>`;
  e.dataset.runnerExpand='true';
  liveBase(e,html+'<div class="node-sub" style="margin-top:7px">Click to open live runner details →</div>');
 },child=>child.querySelector('.runner-name')?.textContent?.trim());
 refreshRunnerDrawer();
}

function workflowCells(run){const p=progress(run),j=p.job,rt=(j?.runner_name&&(/^(?:de-vps-\d+-(?:org|repo)-|neko-runner-)/i.test(j.runner_name)))?'self_hosted':j?.runner_type||'waiting',runner=j?.runner_name||(run.status==='completed'?(run.conclusion==='cancelled'?'Cancelled before runner assignment':'Unassigned'):'Waiting'),node=j?.runner_name?nodeByRunner(j.runner_name):null;return`<td><b>${esc(run.repo)}</b></td><td>${esc(run.display_title||run.name)}<div class="node-sub">#${esc(run.run_number)}${p.total?` • ${p.pct}%`:''}</div></td><td>${esc(run.branch||'–')}</td><td><span class="badge ${badge(run.status,run.conclusion)}">${esc(run.conclusion==='failure'?'FAILED':run.conclusion==='cancelled'?'CANCELLED':run.conclusion==='success'?'SUCCESS':run.conclusion||run.status)}</span></td><td>${esc(runner)}${j?`<span class="runner-type ${typeClass(rt)}">${typeLabel(rt)}</span>`:''}${node?`<div class="node-sub">Node: ${esc(node.name)}</div>`:rt==='github_hosted'?'<div class="node-sub">GitHub public infrastructure</div>':''}</td><td>${esc(run.actor||'unknown')}</td><td><span title="${esc(run.created_at||'')}">${run.created_at?new Date(run.created_at).toLocaleString(): '–'}</span></td><td><span title="${esc(run.updated_at||'')}">${run.updated_at?new Date(run.updated_at).toLocaleString():'–'}</span></td>`}
function renderWorkflows(){
 const c=$('workflowRows');if(!c)return;
 const remote=[...(live.overview?.runs||[])].sort((a,b)=>(Date.parse(b.created_at||b.updated_at||0)||0)-(Date.parse(a.created_at||a.updated_at||0)||0)||Number(b.id||0)-Number(a.id||0));
 const norm=v=>String(v||'').toLowerCase().replace(/^neko-runner-/,'').replace(/[^a-z0-9]/g,'');
 const remoteBusy=new Set((live.overview?.active_jobs||[]).filter(j=>j.status==='in_progress').map(j=>norm(j.runner_name)).filter(Boolean));
 const liveLocal=nodeWorkflowsEnabled()?fleetContainers().filter(r=>r.job_state==='busy'&&!remoteBusy.has(norm(r.container))):[];
 const stored=nodeWorkflowsEnabled()?(live.nodes?.node_workflow_history||live.overview?.node_workflow_history||[]):[];
 const historical=stored.filter(r=>!remoteBusy.has(norm(r.container))&&!liveLocal.some(x=>x.container===r.container&&x.job_started_at===r.job_started_at)).map(r=>({...r,history_archived:true}));
 const local=[...liveLocal,...historical];
 if(!remote.length&&!local.length){
  const reason=live.overview?.workflow_sync?.last_error||'No workflows synchronized and no busy node runners currently reported.';
  c.innerHTML='<tr><td colspan="8" class="empty">'+esc(reason)+'</td></tr>';return;
 }
 c.querySelectorAll('tr.empty-row, tr:not([data-live-key]):not([data-workflow])').forEach(el=>el.remove());
 const rows=[
  ...remote.map(r=>({key:'remote:'+r.repo+'|'+r.id,type:'remote',value:r,time:Date.parse(r.created_at||r.updated_at||0)||0})),
  ...local.map(r=>({key:'local:'+r.container+':'+(r.job_started_at||''),type:'local',value:r,time:Date.parse(r.job_started_at||r.history_updated_at||0)||0}))
 ].sort((a,b)=>b.time-a.time||b.key.localeCompare(a.key));
 // keyed preserves existing DOM nodes; explicitly reinsert them in sorted order.
 keyed(c,rows,x=>x.key,()=>{const el=document.createElement('tr');el.className='workflow-row';return el},(el,x)=>{
  if(x.type==='remote'){
   const r=x.value;el.dataset.workflow=r.repo+'|'+r.id;el.onclick=()=>openBuild(el.dataset.workflow);
   const html=workflowCells(r);if(el.dataset.baseHtml!==html){el.dataset.baseHtml=html;el.innerHTML=html}return;
  }
  const r=x.value;el.dataset.workflow='';el.onclick=()=>openRunner('node:'+r.container);
  const started=r.job_started_at||'';const updated=r.history_updated_at||r.console_last_output_at||'';
  const completed=r.history_status==='completed';
  const localRepo=r.job_repo||(r.scope==='repository'&&String(r.target||'').startsWith('repo:')?r.target.slice(5):'');
  const html='<td><b>'+esc(localRepo||'Not reported by node')+'</b><div class="node-sub">Local agent</div></td>'+
   '<td>'+esc(r.job_workflow||r.job_name||'Active self-hosted job')+'</td>'+
   '<td>'+esc(r.job_branch||'Unknown')+'</td>'+
   '<td><span class="badge '+(completed?'success':'busy')+'">'+(completed?'COMPLETED':r.history_archived?'LAST SEEN BUSY':'IN PROGRESS')+'</span></td>'+
   '<td>'+esc(r.container)+'<div class="node-sub">'+esc(r.node_name||'')+'</div></td>'+
   '<td>'+esc(r.job_actor||'Unknown')+'</td>'+
   '<td>'+esc(started?new Date(started).toLocaleString():'Not reported')+'</td>'+
   '<td>'+esc(updated?new Date(updated).toLocaleString():'Not reported')+'</td>';
  if(el.dataset.baseHtml!==html){el.dataset.baseHtml=html;el.innerHTML=html}
 },el=>el.dataset.liveKey);
 for(const item of rows){const el=[...c.children].find(e=>e.dataset.liveKey===item.key);if(el)c.appendChild(el)}
}

function buildInner(run){
 const p=progress(run),j=p.job,node=nodeByRunner(j?.runner_name),rt=j?.runner_type||'waiting';
 const unknown=!p.total&&run.status!=='completed';
 const running=run.status==='in_progress';
 const current=p.current?.name||(run.status==='queued'?'Waiting for runner':running?'Running job · awaiting step details':'Waiting for live step');
 const stepLabel=unknown?(run.conclusion==='cancelled'?'Cancelled · no completed step timeline':running?'Step details unavailable · build running':'Step details unavailable'):`${p.done}/${p.total} steps complete`;
 const pctLabel=unknown?'—':p.pct+'%';
 return`<div class="build-top"><div style="min-width:0"><div class="build-name">${esc(run.display_title||run.name)}</div><div class="build-meta">${esc(run.repo)} • ${esc(run.branch||'–')} • #${esc(run.run_number)} • ${elapsed(run.created_at)}</div></div><span class="badge ${badge(run.status,run.conclusion)}">${esc(run.conclusion||run.status)}</span></div><div class="progress-wrap"><div class="progress-row"><span>${stepLabel}</span><b>${pctLabel}</b></div><div class="progress ${unknown&&running?'runner-indeterminate':''}"><i style="width:${unknown?(running?34:0):p.pct}%"></i></div></div><div class="current-step"><b>Current:</b> ${esc(current)}</div><div class="build-detail-grid"><div class="tiny"><span>Runner</span><b>${esc(j?.runner_name||'Waiting')} ${j?`<span class="runner-type ${typeClass(rt)}">${typeLabel(rt)}</span>`:''}</b></div><div class="tiny"><span>Node</span><b>${esc(node?.name||(rt==='github_hosted'?'GitHub public infrastructure':'Not matched'))}</b></div><div class="tiny"><span>Job</span><b>${esc(j?.name||'Waiting')}</b></div></div>`;
}
function renderActive(){
 const c=$('activeBuilds');if(!c)return;
 const runs=(live.overview?.runs||[]).filter(r=>['queued','in_progress','waiting','pending','requested'].includes(String(r.status)));
 const fleet=nodeWorkflowsEnabled()?fleetContainers().filter(r=>r.job_state==='busy'):[];
 const known=new Set((live.overview?.active_jobs||[]).map(j=>String(j.runner_name||'').toLowerCase().replace(/^neko-runner-/,'').replace(/[^a-z0-9]/g,'')));
 const local=fleet.filter(r=>!known.has(String(r.container||'').toLowerCase().replace(/^neko-runner-/,'').replace(/[^a-z0-9]/g,'')));
 if(!runs.length&&!local.length){c.innerHTML='<div class="empty">No active workflows or busy agent runners reported.</div>';return}
 const rows=[
 ...runs.map(r=>({key:'github:'+r.repo+':'+r.id,type:'github',value:r})),
 ...local.map(r=>({key:'agent:'+r.container,type:'agent',value:r}))
 ];
 keyed(c,rows,x=>x.key,()=>{const e=document.createElement('article');e.className='build-card';return e},(e,x)=>{
  if(x.type==='github'){const r=x.value;e.dataset.run=r.repo+'|'+r.id;e.onclick=()=>openBuild(e.dataset.run);liveBase(e,buildInner(r));return}
  const r=x.value;e.dataset.run='';e.onclick=()=>openRunner('node:'+r.container);
  liveBase(e,`<div class="build-top"><div><div class="build-name">${esc(r.job_name||'Active runner job')}</div><div class="build-meta">${esc(r.job_repo||r.target||'Repository not reported')} • ${esc(r.job_branch||'Branch unknown')} • ${esc(r.node_name||'Agent')}</div></div><span class="badge busy">BUSY</span></div><div class="node-sub">Workflow: ${esc(r.job_workflow||'Not reported')} • Commit: ${esc(r.job_sha?r.job_sha.slice(0,12):'Unknown')} • Trigger: ${esc(r.job_event||'Unknown')} • Actor: ${esc(r.job_actor||'Unknown')}</div><div class="node-sub" style="margin-top:8px">Live node data · Click for runner console and progress →</div>`);
 },el=>el.dataset.liveKey)
}
function nodeInner(n){const st=n.storage||{},m=n.metrics||{},runners=Array.isArray(n.fleet_runners)?n.fleet_runners:[];return`<div class="node-head"><div style="min-width:0"><div class="node-name">${esc(n.name)}</div><div class="node-sub">${esc(n.runner_name||n.hostname)} • ${esc(n.arch||'–')} • seen ${ago(n.last_seen)}</div></div><span class="badge ${n.online?'online':'offline'}">${n.online?'ONLINE':'OFFLINE'}</span></div><div class="node-stats"><div class="node-stat"><span>Memory</span><b>${Number(m.memory_used_percent||0).toFixed(0)}%</b></div><div class="node-stat"><span>Load</span><b>${Number(m.load_1||0).toFixed(2)}</b></div><div class="node-stat"><span>Cleanable</span><b>${fmtBytes(st.reclaimable_bytes)}</b></div></div><div class="node-sub" style="margin-top:10px">${n.online?runners.length+' active runner container(s)':'Node offline'} · View runner details in GitHub self-hosted runners below.</div>`}
function renderNodeCards(nodes){for(const id of['overviewNodes','allNodes']){const c=$(id);if(!c)continue;if(!nodes.length){c.innerHTML='<div class="empty">No node agents connected.</div>';continue}keyed(c,nodes,n=>n.id,()=>{const e=document.createElement('article');e.className='node-card';return e},(e,n)=>{e.dataset.node=n.id;liveBase(e,nodeInner(n))},child=>child.dataset.node)}}
function storageHTML(n){const st=n.storage||{};return`<div class="node-head"><div><div class="node-name">${esc(n.name)}</div><div class="node-sub">${esc(n.runner_name||n.hostname)} • ${n.online?'online':'offline'}</div></div><span class="badge ${n.online?'online':'offline'}">${n.online?'online':'offline'}</span></div><div class="storage-big">${fmtBytes(st.reclaimable_bytes)}</div><div class="node-sub">Docker ${fmtBytes(st.docker_reclaimable_bytes)} • Logs ${fmtBytes(st.runner_logs_bytes)}</div><div class="storage-actions"><label class="switch"><input type="checkbox" data-live-auto="${esc(n.id)}" ${n.auto_cleanup?'checked':''}> Auto-clean after job</label><label class="switch"><input type="checkbox" data-live-vol="${esc(n.id)}" ${n.include_volumes?'checked':''}> Include volumes</label></div><div class="storage-actions"><button class="btn small" data-live-save="${esc(n.id)}">Save</button><button class="btn danger small" data-live-clean="${esc(n.id)}">Clean now</button></div>${n.last_cleanup_at?`<div class="node-sub" style="margin-top:8px">Last cleanup ${ago(n.last_cleanup_at)} • freed ${fmtBytes(n.last_cleanup_reclaimed_bytes)}</div>`:''}<div class="node-sub" data-live-storage-msg="${esc(n.id)}"></div>`}
function renderStorage(nodes){const c=$('storageCards');if(!c)return;keyed(c,nodes,n=>n.id,()=>{const e=document.createElement('article');e.className='storage-card';return e},(e,n)=>{const html=storageHTML(n);if(e.dataset.html!==html&&![...e.querySelectorAll('input')].includes(document.activeElement)){e.dataset.html=html;e.innerHTML=html;pulse(e)}},child=>{const name=child.querySelector('.node-name')?.textContent?.trim();return nodes.find(n=>n.name===name)?.id||''});bindStorage()}
function bindStorage(){document.querySelectorAll('[data-live-save]').forEach(b=>{if(b.dataset.bound)return;b.dataset.bound='1';b.addEventListener('click',async e=>{e.stopPropagation();const id=b.dataset.liveSave,a=document.querySelector(`[data-live-auto="${CSS.escape(id)}"]`),v=document.querySelector(`[data-live-vol="${CSS.escape(id)}"]`),m=document.querySelector(`[data-live-storage-msg="${CSS.escape(id)}"]`);b.disabled=true;if(m)m.textContent='Saving…';try{await api('/api/node/settings',{method:'POST',body:JSON.stringify({id,auto_cleanup:Boolean(a?.checked),include_volumes:Boolean(v?.checked)})});if(m)m.textContent='Saved'}catch(err){if(m)m.textContent=`Error: ${err.message}`}finally{b.disabled=false}})});document.querySelectorAll('[data-live-clean]').forEach(b=>{if(b.dataset.bound)return;b.dataset.bound='1';b.addEventListener('click',async e=>{e.stopPropagation();const id=b.dataset.liveClean,m=document.querySelector(`[data-live-storage-msg="${CSS.escape(id)}"]`);if(!confirm('Queue safe cleanup for this node?'))return;b.disabled=true;if(m)m.textContent='Queueing cleanup…';try{await api('/api/node/cleanup',{method:'POST',body:JSON.stringify({id})});if(m)m.textContent='Cleanup queued'}catch(err){if(m)m.textContent=`Error: ${err.message}`}finally{b.disabled=false}})})}
function renderNodes(){const nodes=live.nodes?.nodes||[];renderNodeCards(nodes);renderStorage(nodes)}
function emitData(){window.dispatchEvent(new CustomEvent('neko-live-data',{detail:{overview:live.overview,nodes:live.nodes,controls:live.controls}}))}
function renderAll(){renderMetrics();renderRunners();renderWorkflows();renderActive();renderNodes();emitData()}
function mergeWorkflows(w){if(!live.overview)live.overview={runners:[],runs:[],active_jobs:[],jobs_by_run:{},summary:{}};live.overview.runs=w.runs||[];live.overview.active_jobs=w.active_jobs||[];live.overview.jobs_by_run=w.jobs_by_run||{};live.overview.repos=[...new Set((w.runs||[]).map(r=>r.repo))];live.overview.summary={...(live.overview.summary||{}),active_runs:(w.runs||[]).filter(r=>['queued','in_progress','waiting','pending','requested'].includes(String(r.status))).length,failed_24h:(w.runs||[]).filter(r=>r.conclusion==='failure'&&Date.parse(r.updated_at||r.created_at)>=Date.now()-86400000).length}}
function drawerOpen(title,meta,body){if(!body.includes('id="runnerDrawerContent"')){activeDrawer='other';selectedRunner=null;}if($('drawerTitle'))$('drawerTitle').textContent=title;if($('drawerMeta'))$('drawerMeta').textContent=meta;if($('drawerBody'))$('drawerBody').innerHTML=body;$('drawerBackdrop')?.classList.add('open');$('drawer')?.classList.add('open')}
let selectedBuildKey='';
function refreshBuildDrawer(){if(!selectedBuildKey||!$('drawer')?.classList.contains('open'))return;const key=selectedBuildKey;const body=$('drawerBody');const scroll=body?.scrollTop||0;const log=$('liveLogs');const existingLog=log?.textContent||'';const logsLoaded=!!log&&existingLog!=='Logs load on demand.'&&existingLog!=='Loading…';openBuild(key);if(logsLoaded&&$('liveLogs'))$('liveLogs').textContent=existingLog;if(body)body.scrollTop=scroll;}
function drawerClose(){selectedBuildKey='';activeDrawer='';selectedRunner=null;$('drawerBackdrop')?.classList.remove('open');$('drawer')?.classList.remove('open')}
function openBuild(key){if(!key)return;selectedBuildKey=key;const [repo,id]=String(key).split('|'),run=(live.overview?.runs||[]).find(r=>String(r.id)===String(id)&&r.repo===repo);if(!run)return;const p=progress(run),jobs=jobsFor(run.id),j=p.job,rt=j?.runner_type||'waiting',node=nodeByRunner(j?.runner_name);const blocks=jobs.map(job=>`<section class="job-block"><div class="job-head"><div><b>${esc(job.name)}</b><div class="job-runner">Runner: ${esc(job.runner_name||'waiting')} <span class="runner-type ${typeClass(job.runner_type)}">${typeLabel(job.runner_type)}</span></div></div><span class="badge ${badge(job.status,job.conclusion)}">${esc(job.conclusion||job.status)}</span></div>${(job.steps||[]).map(s=>`<div class="step ${esc(s.status)} ${esc(s.conclusion||'')}"><span class="step-icon">${s.conclusion==='success'?'✓':s.conclusion==='failure'?'×':s.status==='in_progress'?'•':'○'}</span><span class="step-name">${esc(s.name)}</span><span class="badge ${badge(s.status,s.conclusion)}">${esc(s.conclusion||s.status)}</span></div>`).join('')}</section>`).join('');drawerOpen(run.display_title||run.name,`${run.repo} • ${run.branch||'–'} • #${run.run_number}`,`<div class="info-grid"><div class="info"><span>Progress</span><b>${p.pct}% • ${p.done}/${p.total||0} steps</b></div><div class="info"><span>Runner type</span><b>${typeLabel(rt)}</b></div><div class="info"><span>Runner</span><b>${esc(j?.runner_name||'Waiting')}</b></div><div class="info"><span>Node</span><b>${esc(node?.name||(rt==='github_hosted'?'GitHub public infrastructure':'Not matched'))}</b></div><div class="info"><span>Current</span><b>${esc(p.current?.name||run.conclusion||run.status)}</b></div><div class="info"><span>Elapsed</span><b>${elapsed(run.created_at)}</b></div></div>${blocks||'<div class="empty">No cached jobs yet.</div>'}<button class="btn" id="liveLoadLogs">Load logs</button><div class="log" id="liveLogs" style="margin-top:9px">Logs load on demand.</div>`);$('liveLoadLogs')?.addEventListener('click',async()=>{const el=$('liveLogs');el.textContent='Loading…';try{el.textContent=await api(`/api/run-logs?repo=${encodeURIComponent(repo)}&id=${encodeURIComponent(id)}`,{text:true})}catch(err){el.textContent=err.message}})}
function openNode(id){selectedBuildKey='';const n=(live.nodes?.nodes||[]).find(x=>x.id===id);if(!n)return;const st=n.storage||{},m=n.metrics||{};drawerOpen(n.name,`${n.id} • ${n.hostname||''} • ${n.platform||''}`,`<div class="info-grid"><div class="info"><span>Runner</span><b>${esc(n.runner_name||'–')}</b></div><div class="info"><span>Status</span><b>${n.online?(n.runner_busy?'Busy':'Online / idle'):'Offline'}</b></div><div class="info"><span>Memory</span><b>${Number(m.memory_used_percent||0).toFixed(1)}%</b></div><div class="info"><span>Load</span><b>${Number(m.load_1||0).toFixed(2)}</b></div><div class="info"><span>Cleanable</span><b>${fmtBytes(st.reclaimable_bytes)}</b></div><div class="info"><span>Last heartbeat</span><b>${new Date(n.last_seen).toLocaleString()}</b></div></div><div class="notice">Node health is pushed over WebSocket. SQLite runner logs and cleanup history remain stored centrally.</div>`)}
$('drawerClose')?.addEventListener('click',drawerClose);$('drawerBackdrop')?.addEventListener('click',drawerClose);
function connect(){const scheme=location.protocol==='https:'?'wss':'ws',ws=new WebSocket(`${scheme}://${location.host}/ws`);ws.addEventListener('open',()=>{setStatus('Live WebSocket',true);const auto=$('auto');if(auto){auto.checked=false;auto.disabled=true;auto.dispatchEvent(new Event('change'))}});ws.addEventListener('message',e=>{let m;try{m=JSON.parse(e.data)}catch{return}if(m.type==='snapshot'){live.overview=m.data.overview;live.nodes=m.data.nodes;live.controls=m.data.controls;renderAll();refreshBuildDrawer();return}if(m.type==='nodes'){live.nodes=m.data;renderMetrics();renderNodes();renderRunners();renderActive();renderWorkflows();emitData();return}if(m.type==='controls'){live.controls=m.data;emitData();return}if(m.type==='runners'){if(!live.overview)live.overview={summary:{}};live.overview.runners=m.data.runners||[];live.overview.summary={...(live.overview.summary||{}),runners_total:live.overview.runners.length,runners_online:live.overview.runners.filter(r=>r.status==='online').length,runners_busy:live.overview.runners.filter(r=>r.busy).length};renderMetrics();renderRunners();emitData();return}if(m.type==='workflows'){mergeWorkflows(m.data);renderMetrics();renderWorkflows();renderActive();renderRunners();refreshBuildDrawer();emitData();return}if(m.type==='webhook-deliveries'){window.dispatchEvent(new CustomEvent('neko-webhook-deliveries',{detail:m.data}));return}if(m.type==='github-webhook')setStatus(`Live • GitHub ${m.data.event}`,true)});ws.addEventListener('close',()=>{setStatus('WebSocket reconnecting…',false);setTimeout(connect,3000)});ws.addEventListener('error',()=>setStatus('WebSocket reconnecting…',false));window.addEventListener('beforeunload',()=>{try{ws.close()}catch{}},{once:true})}
const auto=$('auto');if(auto){auto.checked=false;auto.disabled=true;const label=auto.closest('label');if(label)label.style.display='none'}if($('refresh'))$('refresh').title='Manual full sync only';connect();
})();
