(()=>{
  const descriptor=Object.getOwnPropertyDescriptor(Element.prototype,'innerHTML');
  if(!descriptor?.get||!descriptor?.set||window.__nekoSmoothRefreshInstalled)return;
  window.__nekoSmoothRefreshInstalled=true;

  const targets=new Set(['activeBuilds','overviewNodes','allNodes','storageCards','runnerList','workflowRows']);
  const nativeGet=descriptor.get;
  const nativeSet=descriptor.set;

  const css=document.createElement('style');
  css.textContent=`
    #activeBuilds,#overviewNodes,#allNodes,#storageCards,#runnerList,#workflowRows{transition:opacity .12s ease}
    .neko-smooth-enter{animation:nekoSmoothEnter .16s ease-out both}
    .neko-smooth-leave{pointer-events:none;animation:nekoSmoothLeave .14s ease-in both}
    .neko-smooth-updated{animation:nekoSmoothPulse .22s ease-out}
    @keyframes nekoSmoothEnter{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
    @keyframes nekoSmoothLeave{from{opacity:1}to{opacity:0}}
    @keyframes nekoSmoothPulse{0%{filter:brightness(1.06)}100%{filter:none}}
    @media (prefers-reduced-motion:reduce){.neko-smooth-enter,.neko-smooth-leave,.neko-smooth-updated{animation:none!important}}
  `;
  document.head.appendChild(css);

  function keyFor(el,index){
    if(!(el instanceof Element))return`node:${index}`;
    if(el.matches('[data-run]'))return`run:${el.getAttribute('data-run')}`;
    if(el.matches('[data-workflow]'))return`workflow:${el.getAttribute('data-workflow')}`;
    if(el.matches('[data-node]'))return`node:${el.getAttribute('data-node')}`;
    if(el.classList.contains('runner'))return`runner:${el.querySelector('.runner-name')?.textContent?.trim()||index}`;
    if(el.classList.contains('storage-card')){
      const id=el.querySelector('[data-save-storage]')?.getAttribute('data-save-storage')||el.querySelector('[data-clean-storage]')?.getAttribute('data-clean-storage');
      return`storage:${id||index}`;
    }
    if(el.classList.contains('empty'))return'empty';
    return`${el.tagName}:${index}:${el.id||el.className||''}`;
  }

  function parseChildren(container,html){
    let temp;
    if(container.tagName==='TBODY'){
      const table=document.createElement('table');
      temp=document.createElement('tbody');
      table.appendChild(temp);
    }else{
      temp=document.createElement(container.tagName||'div');
    }
    nativeSet.call(temp,String(html));
    return[...temp.children];
  }

  function copyAttrs(dst,src){
    for(const a of [...dst.attributes])if(!src.hasAttribute(a.name))dst.removeAttribute(a.name);
    for(const a of [...src.attributes])dst.setAttribute(a.name,a.value);
  }

  function inputState(root){
    const map=new Map();
    root.querySelectorAll('input,select,textarea').forEach((el,i)=>{
      const key=el.id||el.getAttribute('data-auto')||el.getAttribute('data-vol')||el.name||`${el.tagName}:${i}`;
      map.set(key,{value:el.value,checked:el.checked,selectedIndex:el.selectedIndex,focused:document.activeElement===el});
    });
    return map;
  }

  function restoreInputs(root,state){
    root.querySelectorAll('input,select,textarea').forEach((el,i)=>{
      const key=el.id||el.getAttribute('data-auto')||el.getAttribute('data-vol')||el.name||`${el.tagName}:${i}`;
      const old=state.get(key);
      if(!old)return;
      if(old.focused||el.matches(':focus')){
        if('checked'in el)el.checked=old.checked;
        if('value'in el)el.value=old.value;
        if('selectedIndex'in el&&old.selectedIndex>=0)el.selectedIndex=old.selectedIndex;
        queueMicrotask(()=>el.focus({preventScroll:true}));
      }
    });
  }

  function patchElement(current,incoming){
    const before=nativeGet.call(current);
    const controls=current.querySelector(':scope > .neko-runner-extra');
    const workflowControls=current.querySelector('.neko-row-workflow-controls');
    const runnerNode=current.querySelector('.neko-runner-node');
    const fields=inputState(current);

    if(controls)controls.remove();
    if(workflowControls)workflowControls.remove();
    if(runnerNode)runnerNode.remove();

    copyAttrs(current,incoming);
    nativeSet.call(current,nativeGet.call(incoming));

    if(controls)current.appendChild(controls);
    if(workflowControls){
      const cell=current.querySelectorAll('td')[1]||current;
      cell.appendChild(workflowControls);
    }
    if(runnerNode){
      const cell=current.querySelectorAll('td')[4]||current;
      cell.appendChild(runnerNode);
    }
    restoreInputs(current,fields);

    if(before!==nativeGet.call(current)){
      current.classList.remove('neko-smooth-updated');
      void current.offsetWidth;
      current.classList.add('neko-smooth-updated');
      setTimeout(()=>current.classList.remove('neko-smooth-updated'),260);
    }
  }

  function reconcile(container,html){
    const incoming=parseChildren(container,html);
    const existing=[...container.children];

    if(!existing.length||existing.every(x=>x.classList?.contains('empty'))&&incoming.some(x=>!x.classList?.contains('empty'))){
      nativeSet.call(container,String(html));
      [...container.children].forEach(x=>x.classList?.add('neko-smooth-enter'));
      return;
    }

    const oldByKey=new Map(existing.map((el,i)=>[keyFor(el,i),el]));
    const keep=new Set();

    incoming.forEach((fresh,i)=>{
      const key=keyFor(fresh,i);
      let current=oldByKey.get(key);
      if(current&&current.tagName===fresh.tagName){
        keep.add(current);
        patchElement(current,fresh);
        container.appendChild(current);
      }else{
        current=fresh;
        current.classList.add('neko-smooth-enter');
        container.appendChild(current);
        keep.add(current);
      }
    });

    existing.forEach(old=>{
      if(keep.has(old))return;
      old.classList.add('neko-smooth-leave');
      setTimeout(()=>old.isConnected&&old.remove(),150);
    });
  }

  Object.defineProperty(Element.prototype,'innerHTML',{
    configurable:descriptor.configurable,
    enumerable:descriptor.enumerable,
    get:descriptor.get,
    set(value){
      if(this instanceof HTMLElement&&targets.has(this.id)&&this.isConnected){
        try{return reconcile(this,value)}catch(err){console.warn('[smooth-refresh] fallback to native render:',err)}
      }
      return nativeSet.call(this,value);
    }
  });

  document.addEventListener('DOMContentLoaded',()=>{
    const button=document.getElementById('refresh');
    if(!button)return;
    button.addEventListener('click',()=>{
      button.classList.add('neko-refreshing');
      const old=button.textContent;
      button.textContent='↻ Syncing…';
      setTimeout(()=>{
        button.classList.remove('neko-refreshing');
        button.textContent=old||'↻ Refresh';
      },700);
    },true);
  });
})();
