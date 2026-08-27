(() => {
  const status = document.getElementById('status');
  const auto = document.getElementById('auto');
  const refresh = document.getElementById('refresh');

  if (!refresh || typeof EventSource === 'undefined') {
    if (status) status.textContent = 'Polling mode';
    return;
  }

  let source = null;
  let refreshTimer = null;
  let fallbackTimer = null;
  let lastEventAt = Date.now();

  function setStatus(text) {
    if (status) status.textContent = text;
  }

  function disablePolling() {
    if (!auto) return;
    auto.checked = false;
    auto.dispatchEvent(new Event('change'));
  }

  function enableFallbackPolling() {
    if (!auto || auto.checked) return;
    auto.checked = true;
    auto.dispatchEvent(new Event('change'));
  }

  function queueRefresh(reason) {
    lastEventAt = Date.now();
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refresh.click();
      setTimeout(() => setStatus(`Live • ${reason}`), 600);
    }, 150);
  }

  function connect() {
    if (source) source.close();
    source = new EventSource('/api/events', { withCredentials: true });

    source.onopen = () => {
      lastEventAt = Date.now();
      disablePolling();
      setStatus('Live connected');
      queueRefresh('connected');
    };

    source.addEventListener('ready', () => {
      lastEventAt = Date.now();
      disablePolling();
      setStatus('Live connected');
    });

    source.addEventListener('nodes', () => queueRefresh('node update'));
    source.addEventListener('github', () => queueRefresh('GitHub update'));
    source.addEventListener('shutdown', () => setStatus('Server restarting…'));

    source.onerror = () => {
      setStatus('Live reconnecting…');
      if (Date.now() - lastEventAt > 15000) enableFallbackPolling();
    };
  }

  fallbackTimer = setInterval(() => {
    if (!source || source.readyState !== EventSource.OPEN) {
      if (Date.now() - lastEventAt > 15000) enableFallbackPolling();
    }
  }, 5000);

  window.addEventListener('beforeunload', () => {
    if (source) source.close();
    if (refreshTimer) clearTimeout(refreshTimer);
    if (fallbackTimer) clearInterval(fallbackTimer);
  });

  connect();
})();
