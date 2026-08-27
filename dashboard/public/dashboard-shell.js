(()=>{
  const $ = id => document.getElementById(id);
  const names = {
    overview: ['Overview', 'Live runner health and current builds'],
    nodes: ['Build Nodes', 'Connected machines, runners and diagnostics'],
    workflows: ['Workflows', 'Cached workflow state pushed over WebSocket'],
    storage: ['Storage & Cleanup', 'Reclaimable Docker data and automatic cleanup'],
  };

  function setView(view) {
    document.querySelectorAll('.view').forEach(el => el.classList.toggle('active', el.dataset.view === view));
    document.querySelectorAll('[data-nav]').forEach(el => el.classList.toggle('active', el.dataset.nav === view));
    const [title, sub] = names[view] || names.overview;
    if ($('pageHeading')) $('pageHeading').textContent = title;
    if ($('pageSub')) $('pageSub').textContent = sub;
    if (innerWidth < 850) $('sidebar')?.classList.remove('open');
  }

  document.querySelectorAll('[data-nav]').forEach(el => {
    el.addEventListener('click', event => {
      event.preventDefault();
      setView(el.dataset.nav || 'overview');
    });
  });

  $('mobileMenu')?.addEventListener('click', () => $('sidebar')?.classList.toggle('open'));

  $('workflowFilter')?.addEventListener('input', event => {
    const query = String(event.target.value || '').trim().toLowerCase();
    document.querySelectorAll('#workflowRows tr').forEach(row => {
      row.hidden = Boolean(query) && !String(row.textContent || '').toLowerCase().includes(query);
    });
  });

  // Re-apply the current workflow filter after WebSocket patches insert rows.
  window.addEventListener('neko-live-data', () => {
    const input = $('workflowFilter');
    if (input && input.value) input.dispatchEvent(new Event('input'));
  });

  setView('overview');
})();
