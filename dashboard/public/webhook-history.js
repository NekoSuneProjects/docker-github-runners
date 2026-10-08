(()=>{
'use strict';
const $=id=>document.getElementById(id);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let deliveries=[];
let chosen=null;
const style=document.createElement('style');
style.textContent='.webhook-row{cursor:pointer}.webhook-row:hover{background:rgba(100,190,150,.09)}.webhook-json{max-height:55vh;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;background:#080f18;color:#c8f4d7;padding:14px;border:1px solid #305344;border-radius:8px;font:11px/1.6 ui-monospace,monospace}.webhook-kv{display:grid;grid-template-columns:minmax(110px,1fr) 2fr;gap:7px;padding:7px;border-bottom:1px solid #253447;font-size:12px;overflow-wrap:anywhere}.webhook-kv span{color:#94a4b8}.webhook-json-controls{display:flex;gap:8px;margin:10px 0;flex-wrap:wrap}';
document.head.appendChild(style);
function friendly(value){if(value===null)return 'null';if(typeof value==='object')return JSON.stringify(value);return String(value)}
function flatten(value,prefix='',out=[],depth=0){
 if(depth>4||out.length>=90)return out;
 if(value&&typeof value==='object'){
  for(const [k,v] of Object.entries(value)){
   if(out.length>=90)break;
   const key=prefix?prefix+'.'+k:k;
   if(v&&typeof v==='object'&& !Array.isArray(v))flatten(v,key,out,depth+1);
   else if(Array.isArray(v))out.push([key,'Array ('+v.length+' items)']);
   else out.push([key,friendly(v).slice(0,500)]);
  }
 }
 return out;
}
function render(){
 const rows=$('webhookRows');if(!rows)return;
 const query=String($('webhookFilter')?.value||'').toLowerCase();
 const found=deliveries.filter(d=>([d.event,d.action,d.repository,d.sender,d.delivery_id,JSON.stringify(d.payload)].join(' ').toLowerCase().includes(query)));
 if(!found.length){rows.innerHTML='<tr><td colspan="7" class="empty">'+(deliveries.length?'No matching deliveries.':'No verified webhook deliveries saved yet.')+'</td></tr>';return}
 rows.innerHTML=found.map(d=>'<tr class="webhook-row" data-webhook-id="'+d.id+'"><td>'+esc(new Date(d.received_at).toLocaleString())+'</td><td><b>'+esc(d.event)+'</b></td><td>'+esc(d.action||'—')+'</td><td>'+esc(d.repository||'—')+'</td><td>'+esc(d.sender||'—')+'</td><td><span class="badge online">'+esc(d.status)+'</span></td><td>View JSON →</td></tr>').join('');
 for(const row of rows.querySelectorAll('[data-webhook-id]'))row.addEventListener('click',()=>openDelivery(Number(row.dataset.webhookId)));
}
function openDelivery(id){
 const d=deliveries.find(x=>x.id===id);if(!d)return;
 chosen=d;
 const details=flatten(d.payload).map(([k,v])=>'<div class="webhook-kv"><span>'+esc(k)+'</span><b>'+esc(v)+'</b></div>').join('');
 const panel=$('drawerBody');
 $('drawerTitle').textContent=d.event+(d.action?' · '+d.action:'');
 $('drawerMeta').textContent=(d.repository||'Unknown repository')+' · '+new Date(d.received_at).toLocaleString();
 panel.innerHTML='<div class="webhook-json-controls"><button class="btn small" id="webhookCopy">Copy redacted JSON</button><button class="btn small" id="webhookToggle">Raw JSON</button></div><div id="webhookParsed">'+(details||'<div class="empty">No fields.</div>')+'</div><pre id="webhookRaw" class="webhook-json" hidden></pre>';
 $('webhookRaw').textContent=JSON.stringify(d.payload,null,2);
 $('webhookCopy').addEventListener('click',()=>navigator.clipboard?.writeText(JSON.stringify(d.payload,null,2)));
 $('webhookToggle').addEventListener('click',()=>{const raw=$('webhookRaw'),parsed=$('webhookParsed');raw.hidden=!raw.hidden;parsed.hidden=!raw.hidden;$('webhookToggle').textContent=raw.hidden?'Raw JSON':'Extracted fields'});
 $('drawerBackdrop')?.classList.add('open');
 $('drawer')?.classList.add('open');
}
document.addEventListener('input',e=>{if(e.target?.id==='webhookFilter')render()});
window.addEventListener('message',()=>{});
window.addEventListener('neko-webhook-deliveries',e=>{deliveries=Array.isArray(e.detail?.deliveries)?e.detail.deliveries:[];render()});
fetch('/api/github/webhook-deliveries',{credentials:'same-origin',cache:'no-store'}).then(r=>r.ok?r.json():Promise.reject(Error('HTTP '+r.status))).then(x=>{deliveries=x.deliveries||[];render()}).catch(err=>{if($('webhookRows'))$('webhookRows').innerHTML='<tr><td colspan="7" class="empty">'+esc(err.message)+'</td></tr>'});
})();
