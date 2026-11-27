'use strict';

window.Linkscope = (() => {
  const hour = 3600000;
  let frame = { nodes: [], links: [], routes: [], events: [], summaries: {}, trends: {} };
  let nodeById = Object.create(null),
    linkById = Object.create(null);
  const escape = (s) =>
    String(s ?? '—').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  const timeFmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  function time(t, seconds = false) {
    if (t == null) return '—';
    const full = timeFmt.format(t);
    return seconds ? full : full.slice(0, 5);
  }
  async function request(path) {
    const r = await window.sessionFetch(path, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  // The existing map renders HTML templates. Only display strings are escaped here.
  function labels(row, keys) {
    for (const key of keys) if (row[key] != null) row[key] = escape(row[key]);
  }
  function apply(next) {
    for (const n of next.nodes) {
      labels(n, ['name', 'place', 'provider', 'role']);
      for (const p of n.references || []) labels(p, ['region', 'provider']);
      if (n.host) labels(n.host, ['os', 'processor', 'arch', 'nic', 'version']);
    }
    for (const l of next.links) labels(l, ['name', 'service']);
    for (const r of next.routes) labels(r, ['name']);
    for (const e of next.events) labels(e, ['title', 'text']);
    nodeById = Object.fromEntries(next.nodes.map((n) => [n.id, n]));
    linkById = Object.fromEntries(next.links.map((l) => [l.id, l]));
    frame = next;
  }
  function sourceTraffic(n, at, routeId) {
    const links = frame.links.filter(
      (l) => l.from === n.id && l.sourceIp && (!routeId || Object.hasOwn(l.traffic, routeId)),
    );
    const rates = links.map((l) => (routeId ? l.traffic[routeId]?.forward : l.reading.forward));
    return {
      targets: links.length,
      upload: rates.length && rates.every((v) => v != null) ? rates.reduce((a, b) => a + b, 0) : null,
    };
  }
  return {
    hour,
    time,
    escape,
    apply,
    // Without a scope the panel returns every trend; the phone home draws one for each route.
    fetchState: (scope) => request('/api/v1/state' + (scope ? '?' + new URLSearchParams({ trend: scope }) : '')),
    fetchVersions: (kind, id) => request('/api/v1/versions?' + new URLSearchParams({ kind, id })),
    fetchHistory: (
      kind, id, minutes, end, version,
      resolution = minutes === 5 || (minutes === 60 && ['link', 'route', 'reference'].includes(kind))
        ? 'samples' : null,
    ) =>
      request(
        '/api/v1/history?' +
          new URLSearchParams({
            kind,
            id,
            minutes,
            end,
            ...(resolution ? { resolution } : {}),
            ...(version == null ? {} : { version }),
          }),
      ),
    fetchBars: (kind, id, minutes, end, version, carrier, archive) =>
      request(
        '/api/v1/history?' +
          new URLSearchParams({
            kind,
            id,
            minutes,
            end,
            resolution: 'bars',
            ...(archive ? { archive } : {}),
            ...(carrier ? { carrier } : {}),
            ...(version == null ? {} : { version }),
          }),
      ),
    get frame() {
      return frame;
    },
    get nodes() {
      return frame.nodes;
    },
    get links() {
      return frame.links;
    },
    get routes() {
      return frame.routes;
    },
    get events() {
      return frame.events;
    },
    get nodeById() {
      return nodeById;
    },
    get linkById() {
      return linkById;
    },
    nodeState: (n) => n.state,
    lastReport: (n) => n.last,
    nodeValue: (n, m) => n.reading?.[m] ?? null,
    linkSample: (l) => l.reading,
    linkState: (l) => l.state,
    sourceTraffic,
  };
})();
