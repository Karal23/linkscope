'use strict';

// Icons and flag tiles shared by the topology board and the admin page.
window.LinkscopeGlyphs = (() => {
  const paths = {
    settings:
      '<path d="M4 6h6m5 0h5M4 12h2m5 0h9M4 18h10m5 0h1"/><circle cx="12.5" cy="6" r="2.5"/><circle cx="8.5" cy="12" r="2.5"/><circle cx="16.5" cy="18" r="2.5"/>',
    shuffle:
      '<path d="M3 6h3c4 0 7 12 11 12h4m-4-4 4 4-4 4M3 18h3c1.5 0 3-2.5 4.2-5M13 8c1.4-1.7 2.6-2 4-2h4m-4-4 4 4-4 4"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
    moon: '<path d="M20 14.2A8.5 8.5 0 0 1 9.8 4a8.5 8.5 0 1 0 10.2 10.2Z"/>',
    chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M9 3v3m6-3v3M9 18v3m6-3v3M3 9h3m-3 6h3m12-6h3m-3 6h3"/>',

    server:
      '<rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.02M7 17h.02m5-10h5m-5 10h5"/>',
    links:
      '<path d="m9.5 14.5 5-5m-4-3 2-2a4.3 4.3 0 0 1 6.1 6.1l-3 3a4.3 4.3 0 0 1-6.1 0m4 4-2 2a4.3 4.3 0 0 1-6.1-6.1l3-3a4.3 4.3 0 0 1 6.1 0"/>',
    pause: '<path d="M9 6.5v11m6-11v11" stroke-width="2.8"/>',
    play: '<path d="m8 5 10 7-10 7V5Z"/>',
    routes:
      '<circle cx="5" cy="6" r="2"/><circle cx="19" cy="18" r="2"/><path d="M7 6h7a3 3 0 0 1 0 6h-4a3 3 0 0 0 0 6h7"/>',
    expand: '<path d="M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5"/>',
    collapse: '<path d="M4 9h5V4m11 5h-5V4M9 20v-5H4m11 5v-5h5"/>',
    'chevron-down': '<path d="m6 9 6 6 6-6"/>',
    'chevron-right': '<path d="m9 6 6 6-6 6"/>',
    pointer: '<path d="m5 3 5 17 3-6 6-3L5 3Z"/>',
    activity: '<path d="M2.5 12h4l3-7 4 14 3-7h5"/>',
    home: '<path d="m3 11 9-7 9 7M5.3 10v9.4h13.4V10M10 19v-5h4v5"/>',
    router:
      '<rect x="3" y="12" width="18" height="7" rx="2"/><path d="M6 12V6m12 6V4M7 15.5h.1m4 0h.1m4 0h3"/>',
    relay: '<path d="m3 8 9-5 9 5-9 5-9-5Zm0 5 9 5 9-5m-18 4 9 5 9-5"/>',
    globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
    alert:
      '<path d="m10.5 4-8 14a1.6 1.6 0 0 0 1.4 2.4h16.2a1.6 1.6 0 0 0 1.4-2.4l-8-14a1.7 1.7 0 0 0-3 0Z"/><path d="M12 9v4m0 3h.01"/>',
    offline: '<circle cx="12" cy="12" r="8"/><path d="M8.5 12h7"/>',
    check: '<path d="m5 12 4.5 4.5L19 7"/>',
    upload: '<path d="M4 17V9m-3 3 3-3 3 3m3 6V6m-3 3 3-3 3 3m4 8V3m-3 3 3-3 3 3"/>',
    download: '<path d="M4 5v10m-3-3 3 3 3-3m3-8v13m-3-3 3 3 3-3m4-11v17m-3-3 3 3 3-3"/>',
    latency: '<path d="M3 14h4l2.5-7 4 11 2.5-7h5"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    direction: '<path d="M4 12h15m-5-5 5 5-5 5"/>',
    back: '<path d="M20 12H4m7-7-7 7 7 7"/>',
    install: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    swap: '<path d="M4 8h15m-4-4 4 4-4 4M20 16H5m4-4-4 4 4 4"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3m5 0h5"/>',
  };
  function icon(name) {
    return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || ''}</svg>`;
  }
  function fillIcons(root = document) {
    root.querySelectorAll('[data-icon]').forEach((el) => {
      el.innerHTML = icon(el.dataset.icon);
    });
  }
  const regionNames = new Intl.DisplayNames(['zh-CN'], { type: 'region' });
  function country(n) {
    if (n.countryCode) return n.countryCode;
    const place = n.place || '';
    return [
      ['HK', /香港/],
      ['TW', /台湾|台北/],
      ['JP', /日本|东京|大阪/],
      ['US', /美国|洛杉矶|圣何塞/],
      ['SG', /新加坡/],
      ['DE', /德国|法兰克福/],
      ['CN', /中国|杭州|上海|广州|深圳|成都|南京/],
    ].find(([, pattern]) => pattern.test(place))?.[0];
  }
  function tileIcon(n) {
    const code = country(n);
    const flags = window.LinkscopeFlagCodes || [];
    const i = flags.indexOf(code);
    if (i < 0) return `<span class="node-icon ${n.tone}">${icon('globe')}</span>`;
    const rows = Math.ceil(flags.length / 16);
    return `<span class="node-icon flag-tile"><span class="country-flag" role="img" aria-label="${regionNames.of(code)}" style="background-size:1600% ${rows * 100}%;background-position:${((i % 16) / 15) * 100}% ${(Math.floor(i / 16) / (rows - 1)) * 100}%"></span></span>`;
  }
  return { icon, fillIcons, country, tileIcon, regionNames };
})();
