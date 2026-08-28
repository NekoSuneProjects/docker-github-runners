(()=>{
let state={overview:null,nodes:null};
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot',"'":'&#39;'}[c]));
const ago=v=>{const t=Date.parse(v||'');if(!Number.isFinite(t))return'';const s=Math.max(0,Math.floor((Date.now()-t)/1000));if(s<60)return`${s}s ago`;if(s<3600)return`${Math.floor(s/60)}m ago`;return`${Math.floor(s/3600)}h ago`};
const repoName=v=>String(v||'').trim().replace(/^https:\/\/github\.com\//i,'').replace(/\.git$/i,'').split('/').filter(Boolean).pop()||'';
function nodes(){return state.nodes?.nodes||[]}
function nodeByRunner(name){return nodes().find(n=>n.runner_name===name)||null}
function githubRunner(name){return(state.overview?.runners||[]).find(r=>r.name===name)||null}
function activeApiWorkload(name){return(state.overview?.active_jobs||[]).find(j=>j.runner_name===name)||null}
function localHtml(node,busy){const w=node?.current_workload||{};if(w.active){const repo=w.repository||'Repository resolving…';const job=w.job||'GitHub Actions job';const when=w.started_at?` • started ${ago(w.started_at)}`:'';return`<div class="neko-workload-label">Current repository / workload</div><div class="neko-workload-repo">${esc(repo)}</div><div class="neko-workload-title">${esc(job)}</div><div class="neko-workload-meta">local runner detection • ${esc(w.confidence||'unknown')} confidence${when}</div>`}if(busy)return`<div class="neko-workload-label">Current repository / workload</div><div class="neko-workload-title">Busy — resolving repository/job from runner diagnostics…</div><div class="neko-workload-meta">GitHub says this runner is busy; local workload metadata has not arrived yet.</div>`;return''}
function patchCard(card,node,runnerName){const box=card.querySelector('.neko-workload');if(!box)return;const api=activeApiWorkload(runnerName);if(api)return;const gr=githubRunner(runnerName);const busy=node?.runner_busy===true||gr?.busy===true;const html=localHtml(node,busy);if(html){if(box.dataset.nekoLocalHtml!==html){box.dataset.nekoLocalHtml=html;box.dataset.nekoLocal='1';box.dataset.html='';box.innerHTML=html}}else if(box.dataset.nekoLocal==='1'){delete box.dataset.nekoLocal;delete box.dataset.nekoLocalHtml;box.dataset.html='';queueMicrotask(()=>window.NekoRunnerControls?.render?.())}}
function localWorkflowRows(){
  const apiActive=new Set((state.overview?.runs||[]).filter(r=>['queued','in_progress','waiting','pending','requested'].includes(String(r.status))).map(r=>String(r.repo||'').toLowerCase()));
  const grouped=new Map();
  for(const node of nodes()){
    const w=node?.current_workload||{};
    if(!w.active||!w.repository)continue;
    const short=repoName(w.repository),key=short.toLowerCase();
    if(!short||apiActive.has(key))continue;
    const existing=grouped.get(key)||{repo:short,full:w.repository,job:w.job||'GitHub Actions job',started_at:w.started_at||w.detected_at||node.last_seen,runners:[],nodes:[]};
    if(node.runner_name&&!existing.runners.includes(node.runner_name))existing.runners.push(node.runner_name);
    if(node.name&&!existing.nodes.includes(node.name))existing.nodes.push(node.name);
    if(!existing.job&&w.job)existing.job=w.job;
    grouped.set(key,existing);
  }
  return [...grouped.values()];
}
function patchWorkflowRows(){
  const body=document.getElementById('workflowRows');if(!body)return;
  const q=String(document.getElementById('workflowFilter')?.value||'').trim().toLowerCase();
  const desired=new Map();
  for(const item of localWorkflowRows()){
    const hay=`${item.repo} ${item.full} ${item.job} ${item.runners.join(' ')} ${item.nodes.join(' ')}`.toLowerCase();
    if(q&&!hay.includes(q))continue;
    const key=item.repo.toLowerCase();
    desired.set(key,item);
  }
  for(const row of [...body.querySelectorAll('tr.neko-local-workflow')])if(!desired.has(row.dataset.localRepo||''))row.remove();
  for(const [key,item] of desired){
    let row=body.querySelector(`tr.neko-local-workflow[data-local-repo="${CSS.escape(key)}"]`);
    const runner=item.runners.join(', ')||'Self-hosted runner';
    const node=item.nodes.join(', ');
    const html=`<td><b>${esc(item.repo)}</b><div class="node-sub">LOCAL LIVE</div></td><td>${esc(item.job)}<div class="node-sub">Runner-reported workload • syncing GitHub details…</div></td><td>–</td><td><span class="badge in_progress">RUNNING</span></td><td>${esc(runner)}${node?`<div class="node-sub">Node: ${esc(node)}</div>`:''}</td><td>–</td><td>${ago(item.started_at)||'now'}</td>`;
    if(!row){row=document.createElement('tr');row.className='workflow-row neko-local-workflow';row.dataset.localRepo=key;row.innerHTML=html;body.prepend(row)}else if(row.dataset.localHtml!==html){row.innerHTML=html}
    row.dataset.localHtml=html;
  }
}
function patch(){document.querySelectorAll('#runnerList .runner').forEach(card=>{const name=card.querySelector('.runner-name')?.textContent?.trim();if(name)patchCard(card,nodeByRunner(name),name)});document.querySelectorAll('.node-card[data-node]').forEach(card=>{const node=nodes().find(n=>n.id===card.dataset.node);if(node)patchCard(card,node,node.runner_name)});patchWorkflowRows()}
window.addEventListener('neko-live-data',e=>{state={overview:e.detail?.overview||state.overview,nodes:e.detail?.nodes||state.nodes};setTimeout(patch,0)});
document.getElementById('workflowFilter')?.addEventListener('input',()=>setTimeout(patchWorkflowRows,0));
const observer=new MutationObserver(()=>setTimeout(patch,0));observer.observe(document.body,{subtree:true,childList:true});
})();
