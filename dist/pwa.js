'use strict';

(() => {
  const key = 'linkscope-public-summary';
  const offlinePage = document.querySelector('#offline-view');
  if (offlinePage) {
    let snapshot;
    try { snapshot = JSON.parse(localStorage.getItem(key)); } catch { /* A first visit can have no data. */ }
    if (snapshot && Number.isFinite(snapshot.at)) {
      const time = document.querySelector('#snapshot-time');
      time.dateTime = new Date(snapshot.at).toISOString();
      time.textContent = new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
        second: '2-digit', hourCycle: 'h23',
      }).format(snapshot.at) + ' UTC+8';
      document.querySelector('#snapshot-online').textContent = (snapshot.online ?? '—') + ' / ' + (snapshot.total ?? '—');
      document.querySelector('#snapshot-faults').textContent = snapshot.faults ?? '—';
      for (const name of ['download', 'upload']) {
        const v = snapshot[name];
        document.querySelector('#snapshot-' + name).textContent = v == null ? '—'
          : v > 0 && v < 1 ? Math.round(v * 1000) + ' Kbps' : Number(v.toFixed(2)) + ' Mbps';
      }
      document.querySelector('#offline-summary').hidden = false;
    } else {
      document.querySelector('#offline-empty').hidden = false;
    }
    // A tunnel or origin can recover while the phone itself stays online.
    let checking = false;
    async function reconnect() {
      if (checking || document.hidden || !navigator.onLine) return;
      checking = true;
      try {
        const response = await fetch('/manifest.webmanifest', { cache: 'no-store', signal: AbortSignal.timeout(6000) });
        if (response.ok && (await response.json()).start_url === '/') location.replace('/');
      } catch { /* Keep the dated snapshot until the origin responds. */ }
      finally { checking = false; }
    }
    window.addEventListener('online', reconnect);
    document.addEventListener('visibilitychange', reconnect);
    setInterval(reconnect, 15000);
    return;
  }

  // Persist only these anonymous global counters, even when a single route is selected.
  let latest = null, storedAt = 0;
  function save() {
    if (!latest || latest.at === storedAt) return;
    try {
      localStorage.setItem(key, JSON.stringify(latest));
      storedAt = latest.at;
    } catch { /* Live monitoring also works with storage disabled. */ }
  }
  window.LinkscopePWA = {
    remember(frame) {
      if (frame.accessRole !== 'viewer' || frame.signedIn !== false) {
        if (latest !== null || storedAt !== -1) {
          try { localStorage.removeItem(key); } catch {}
          latest = null;
          storedAt = -1;
        }
        return;
      }
      const s = frame.summaries.all;
      latest = { at: frame.now, online: s.online, total: s.total, faults: s.faults, upload: s.upload, download: s.download };
      if (latest.at - storedAt >= 30000) save();
    },
  };
  window.addEventListener('pagehide', save);
  window.addEventListener('offline', save);
  document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });

  const menu = document.querySelector('#phone-menu');
  const install = document.querySelector('#phone-install');
  const help = document.querySelector('#install-help');
  const standalone = matchMedia('(display-mode: standalone)');
  let promptEvent;
  function syncInstall() {
    install.hidden = standalone.matches || navigator.standalone === true;
    help.hidden = true;
  }
  syncInstall();
  standalone.addEventListener('change', syncInstall);
  document.querySelector('#phone-menu-open').addEventListener('click', () => menu.showModal());
  document.querySelector('#phone-menu-close').addEventListener('click', () => menu.close());
  document.querySelector('#phone-sign-out').addEventListener('click', () => document.querySelector('#sign-out').click());
  menu.addEventListener('click', (event) => {
    if (event.target !== menu) return;
    const r = menu.getBoundingClientRect();
    if (event.clientY < r.top || event.clientX < r.left || event.clientX > r.right) menu.close();
  });
  window.addEventListener('beforeinstallprompt', (e) => {
    // Desktop keeps the browser's normal installation UI.
    if (matchMedia('(max-width: 900px)').matches) e.preventDefault();
    promptEvent = e;
    help.hidden = true;
  });
  window.addEventListener('appinstalled', () => {
    promptEvent = null;
    help.hidden = install.hidden = true;
  });
  install.addEventListener('click', async () => {
    if (promptEvent) {
      const prompt = promptEvent;
      promptEvent = null;
      try { await prompt.prompt(); return; } catch { /* Show the browser's manual path. */ }
    }
    const apple = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    help.textContent = apple ? '在 Safari 中点「分享」→「添加到主屏幕」，然后点「添加」。'
      : '在浏览器菜单中选择「安装应用」或「添加到主屏幕」。';
    help.hidden = false;
  });
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {});
  }
})();
