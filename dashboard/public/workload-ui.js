(()=>{
let state={overview:null,nodes:null};
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ago=v=>{const t=Date.parse(v||'');if(!Number.isFinite(t))return'';const s=Math.max(0,Math.floor((Date.now()-t)/1000));if(s<60)return`${s}s ago`;if(s<3600)return`${Math.floor(s/60)}m ago`;return`${Math.floor(s/3600)}h ago`};
function nodes(){return state.nodes?.nodes||[]}
function nodeByRunner(name){return nodes().find(n=>n.runner_name===name)||null}
function githubRunner(name){return(state.overview?.runners||[]).find(r=>r.name===name)||null}
function activeApiWorkload(name){return(state.overview?.active_jobs||[]).find(j=>j.runner_name===name)||null}
function localHtml(node,busy){const w=node?.current_workload||{};if(w.active){const repo=w.repository||'Repository resolving…';const job=w.job||'GitHub Actions job';const when=w.started_at?` • started ${ago(w.started_at)}`:'';return`<div class="neko-workload-label">Current repository / workload</div><div class="neko-workload-repo">${esc(repo)}</div><div class="neko-workload-title">${esc(job)}</div><div class="neko-workload-meta">local runner detection • ${esc(w.confidence||'unknown')} confidence${when}</div>`}if(busy)return`<div class="neko-workload-label">Current repository / workload</div><div class="neko-workload-title">Busy — resolving repository/job from runner diagnostics…</div><div class="neko-workload-meta">GitHub says this runner is busy; local workload metadata has not arrived yet.</div>`;return''}
function patchCard(card,node,runnerName){const box=card.querySelector('.neko-workload');if(!box)return;const api=activeApiWorkload(runnerName);if(api)return;const gr=githubRunner(runnerName);const busy=node?.runner_busy===true||gr?.busy===true;const html=localHtml(node,busy);if(html){if(box.dataset.nekoLocalHtml!==html){box.dataset.nekoLocalHtml=html;box.dataset.nekoLocal='1';box.dataset.html='';box.innerHTML=html}}else if(box.dataset.nekoLocal==='1'){delete box.dataset.nekoLocal;delete box.dataset.nekoLocalHtml;box.dataset.html='';queueMicrotask(()=>window.NekoRunnerControls?.render?.())}}
function patch(){document.querySelectorAll('#runnerList .runner').forEach(card=>{const name=card.querySelector('.runner-name')?.textContent?.trim();if(name)patchCard(card,nodeByRunner(name),name)});document.querySelectorAll('.node-card[data-node]').forEach(card=>{const node=nodes().find(n=>n.id===card.dataset.node);if(node)patchCard(card,node,node.runner_name)})}
window.addEventListener('neko-live-data',e=>{state={overview:e.detail?.overview||state.overview,nodes:e.detail?.nodes||state.nodes};setTimeout(patch,0)});
const observer=new MutationObserver(()=>setTimeout(patch,0));observer.observe(document.body,{subtree:true,childList:true});
})();
