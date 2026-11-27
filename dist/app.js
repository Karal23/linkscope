'use strict';

(() => {
  const D = window.Linkscope;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const { icon, fillIcons, tileIcon } = window.LinkscopeGlyphs;
  const stateText = {
    online: '在线',
    waiting: '待上报',
    connected: '已接入',
    reference: '固定测点',
    offline: '离线',
    ingress: '无探针',
    ping: 'Ping 观测',
    shared: '拼车节点',
    normal: '正常',
    degraded: '质量异常',
    critical: '严重',
    unmeasured: '未测',
    pending: '待测',
  };
  const state = {
    route: 'all',
    playing: true,
    now: Date.now(),
    expanded: false,
    detail: null,
    nodeWide: false,
  };
  const phone = matchMedia('(max-width: 900px)');
  let dismissedPreview = null;
  const fmt = (v, precision = 1) => (v == null ? '—' : Number(v).toFixed(precision));
  const pill = (status) => `<span class="state-label ${status}">${stateText[status]}</span>`;
  // Line colour encodes measured health only; flags already carry the region.
  function lossOf(l) {
    const r = l.reading || {};
    if (l.mode === 'TCP') {
      const values = [r.tcpLoss, r.failureRate].filter((v) => v != null);
      return values.length ? Math.max(...values) : null;
    }
    return r.packetLoss ?? null;
  }
  function edgeTone(l) {
    const r = l.reading || {};
    if (!l.measured) return 'neutral';
    if (l.referenceId) {
      if (r.lossAlert === 'critical') return 'rose';
      return l.state === 'degraded' ? 'amber' : 'mint';
    }
    const loss = lossOf(l) ?? 0;
    if (r.latency == null || loss >= 5) return 'rose';
    if (loss > 0 || l.state === 'degraded') return 'amber';
    return 'mint';
  }
  const endpoints = (l) => `${D.nodeById[l.from].name} → ${D.nodeById[l.to].name}`;
  const percent = (v) => (v == null ? '—' : Number(v.toFixed(1)) + '%');
  const formatLinkValue = (v, metric) =>
    metric === 'tcpLoss' ? percent(v) : metric === 'packetLoss' && v != null ? String(v) : fmt(v);
  const linkVal = (l, metric = 'latency') =>
    `<span data-eval="${l.id}" data-metric="${metric}">${formatLinkValue(D.linkSample(l, state.now)[metric], metric)}</span>`;
  const lossOrTimeoutValue = (l) => l.mode === 'TCP'
    ? linkVal(l, 'tcpLoss')
    : `<span data-icmp-loss="${l.id}">${percent(l.reading.packetLoss)}</span>`;
  const latencyLabel = (mode) => mode ? mode + ' 延迟' : '延迟';
  function entryReference(entry, refs = D.nodeById[entry]?.references || []) {
    if (!refs.length) return;
    const choice = sessionStorage.getItem('linkscope-carrier-choice-' + entry);
    return refs.find((r) => r.provider === choice) || refs.find((r) => r.provider === '联通') || refs[0];
  }
  const referenceName = (r) => r.region + r.provider;
  const referenceDelay = (r) =>
    r.latency != null
      ? fmt(r.latency) + ' ms'
      : r.packetLoss === 100
        ? '无回包'
        : r.failureRate > 0
          ? '未连通'
          : '待测';
  function edgeCaption(l) {
    if (l.referenceId) return `<span class="edge-loss">${D.nodeById[l.from].provider} · 反测</span>`;
    if (!l.mode) return '';
    const tcp = l.mode === 'TCP';
    return `<span class="edge-loss" title="${tcp ? '近 1 分钟 TCP 探测中超时的比例' : '本轮 ICMP Echo 未收到回复的比例'}">${tcp ? '超时率' : '丢包率'} ${lossOrTimeoutValue(l)}</span>`;
  }
  // The map only calls out loss when there is some, so healthy links stay quiet.
  function mapLossBadge(l) {
    const tcp = l.mode === 'TCP';
    if (l.referenceId || !l.mode || !((tcp ? l.reading.tcpLoss : l.reading.packetLoss) > 0)) return '';
    return `<span class="edge-loss" title="${tcp ? '近 1 分钟 TCP 超时率' : '本轮 ICMP 丢包率'}">${tcp ? '超时' : '丢包'} ${lossOrTimeoutValue(l)}</span>`;
  }
  function delayStatus(l) {
    if (!l.measured) return stateText[l.state];
    if (l.reading.latency != null) return '';
    if (l.mode === 'TCP') return l.reading.tcpTimeout === 100 ? '超时' : '未连通';
    return '无回包';
  }
  function edgeValue(l) {
    if (l.referenceId) return `<span data-ref-delay="${l.id}">${referenceDelay(l.reading)}</span>`;
    return delayStatus(l) || `${linkVal(l)}<em> ms</em>`;
  }
  const nodeVal = (n, metric, precision = 0) =>
    `<span data-nval="${n.id}" data-metric="${metric}" data-precision="${precision}">${fmt(D.nodeValue(n, metric, state.now), precision)}</span>`;
  const edgeButton = (l) => `data-open="link" data-id="${l.id}"`;
  const nodeButton = (n) => `data-open="node" data-id="${n.id}"`;
  const inputLinks = (n) => D.links.filter((l) => l.from === n.id || l.to === n.id);
  const connectedIds = (links) => new Set(links.flatMap((l) => [l.from, l.to]));
  const nodeCaption = (n) => (n.sourceIp ? `${n.provider} · ${n.sourceIp}` : `${n.place} · ${n.provider}`);
  const flowRates = (l) =>
    `<span class="flow-pair"><span title="正向速率">↑${linkVal(l, 'forward')}</span><span title="回程速率">↓${linkVal(l, 'reverse')}</span></span>`;
  const selectedRoute = () => D.routes.find((r) => r.id === state.route);
  function flowWidth(l) {
    const { forward, reverse } = D.linkSample(l, state.now);
    return (1.25 + Math.min(100, (forward ?? 0) + (reverse ?? 0)) * 0.06).toFixed(2) + 'px';
  }
  function uploadReading(value, label) {
    return `<span class="card-reading" title="${label}"><span class="sr-only">${label}</span><span class="up-mark" aria-hidden="true">↑</span><b>${value}</b><small>Mbps</small></span>`;
  }
  function volume(gib) {
    if (gib == null) return '—';
    return gib >= 1024 ? fmt(gib / 1024, 2) + ' TiB' : fmt(gib, gib < 1 ? 2 : 1) + ' GiB';
  }
  function compactSpeed(up) {
    if (up == null) return ['—', ''];
    if (up >= 1000) return [fmt(up / 1000, 1), 'Gbps'];
    if (up > 0 && up < 1) return [fmt(up * 1000, up < 0.01 ? 1 : 0), 'Kbps'];
    return [fmt(up, up > 0 && up < 10 ? 1 : 0), 'Mbps'];
  }
  const quotaSegments = Array.from({ length: 8 }, (_, i) => `<i style="--slot:${i}"></i>`).join('');
  function quotaGauge(n) {
    if (n.unlimited) return { level: 8, label: '按量付费 · 流量不限', short: '∞' };
    if (n.quotaGiB == null) return { level: null, label: '流量额度未设置', short: '' };
    const limit = volume(n.quotaGiB);
    if (n.remaining == null) {
      return { level: 8, label: `${n.direction === 'single' ? '单向' : ''}额度 ${limit} · 已用量未知`, short: '' };
    }
    const fraction = n.quotaGiB > 0 ? Math.min(1, Math.max(0, n.remaining / n.quotaGiB)) : 0;
    return {
      level: fraction * 8,
      label: `剩余流量 ${volume(n.remaining)} / ${limit}（${percent(fraction * 100)}）`,
      short: Math.round(fraction * 100) + '%',
      low: fraction < 0.2,
    };
  }
  function quotaReading(n) {
    const { level, label, short, low } = quotaGauge(n);
    return `<span class="quota-reading"><span class="quota-meter" data-quota="${n.id}" role="img" aria-label="${label}" title="${label}" ${level == null ? 'data-unknown' : `style="--quota-level:${level}"`}>${quotaSegments}</span><small class="quota-pct${low ? ' low' : ''}${n.unlimited ? ' unlimited' : ''}" data-quota-pct="${n.id}" aria-hidden="true">${short}</small></span>`;
  }
  function cardReadings(n, status, route) {
    if (n.kind === 'reference') {
      const links = inputLinks(n);
      return `<span class="card-reading">可达 <b>${links.filter((l) => l.reading.latency != null).length} / ${links.length}</b></span><span class="card-reading">ICMP</span>`;
    }
    if (n.sourceIp) {
      const { targets, upload } = D.sourceTraffic(n, state.now, route?.id);
      const rate = `<span data-source-up="${n.id}" data-route="${route?.id || ''}">${fmt(upload, route ? 1 : 0)}</span>`;
      return `<span class="card-reading"><b>${targets}</b><small>个目标</small></span>${upload == null ? '<span class="card-reading">速率未测</span>' : uploadReading(rate, route ? '此线路的客户端上行速率' : '客户端记录的合计上行速率')}`;
    }
    if (n.host) {
      const quota = quotaReading(n);
      const [value, unit] = compactSpeed(n.reading?.up);
      const other =
        status === 'online'
          ? `<span class="card-reading" data-speed="${n.id}" title="网卡上行速率"><span class="up-mark">↑</span><b>${value}</b><small data-unit>${unit}</small></span>`
          : `<span class="card-reading offline-note">${icon('offline')}${stateText[status]}</span>`;
      return quota + other;
    }
    const adjacent = inputLinks(n);
    if (n.kind === 'ingress') {
      const sources = D.links.filter(
        (l) => l.sourceIp && l.to === n.id && (!route || route.links.includes(l.id)),
      );
      return `<span class="card-reading">无探针</span><span class="card-reading" title="客户端记录的接入来源"><b>${sources.length}</b><small>个来源</small></span>`;
    }
    const mode = n.kind === 'ping' ? 'ICMP' : 'TCP';
    const observed = adjacent.filter((l) => l.mode === mode && l.observer !== n.id);
    const inbound =
      observed.find((l) => route?.links.includes(l.id)) || observed.find((l) => !l.sourceIp) || observed[0];
    const measured =
      !route && observed.length > 1
        ? `<span class="card-reading"><b>${observed.length}</b><small>个上游</small></span>`
        : inbound?.measured
          ? `<span class="card-reading" title="观测来源 · ${D.nodeById[inbound.observer].name}"><small>${mode}</small><b>${linkVal(inbound)}</b><small>ms</small></span>`
          : `<span class="card-reading">${inbound?.pending ? '待测' : '未测'}</span>`;
    return (
      (n.unlimited || n.quotaGiB != null
        ? quotaReading(n)
        : `<span class="card-reading">${n.kind === 'ping' ? '自建' : '拼车'}</span>`) + measured
    );
  }
  // The card edge shows probe state: solid mint online, dashed grey offline, quiet without a probe.
  function borderStyle(n) {
    if (n.state === 'offline' || n.state === 'waiting') return '--rim:var(--neutral);border-style:dashed';
    if (n.state === 'online' || n.state === 'connected') return '--rim:var(--mint)';
    return '--rim:var(--border-strong)';
  }
  function nodeCard(n, className = 'map-node', position = '', route = selectedRoute()) {
    const status = D.nodeState(n, state.now);
    const mapId = className === 'map-node' ? `data-map-node="${n.id}"` : '';
    const caption =
      n.kind === 'reference'
        ? n.role
        : n.sourceIp
          ? nodeCaption(n)
          : `${n.place}<span class="caption-extra"> · ${n.provider}</span>`;
    return `<button type="button" class="node-card ${className} ${n.tone}" data-state="${status}" ${nodeButton(n)} ${mapId} style="${borderStyle(n)};${position}">
      <span class="card-identity">${tileIcon(n)}<span class="node-copy"><strong>${n.name}</strong><small title="${nodeCaption(n)}">${caption}</small></span>
        <span class="status-dot ${status}" title="${stateText[status]}"><span class="sr-only">${stateText[status]}</span></span></span>
      <span class="card-vitals">${cardReadings(n, status, route)}</span></button>`;
  }
  // The phone card stretches a wider trend under each figure, with a soft area and a dot on the latest sample.
  // `floor` is the smallest range the curve spreads over, so a steady reading with small jitter stays a calm line.
  function summaryTrend(history, key, label, refId, wide = false, uid = key, floor = 0) {
    const values = history.map((sample) => (refId ? sample.v?.estimates?.[refId] : sample.v?.[key]));
    const available = values.filter((v) => v != null);
    if (available.length < 2) return '';
    const lowest = Math.min(...available),
      highest = Math.max(...available),
      range = Math.max(floor, highest - lowest),
      low = (highest + lowest) / 2 - range / 2;
    const [w, h, pad, x0] = wide ? [100, 32, 4, 0] : [40, 16, 2, 1];
    const points = values.map((v, i) =>
      v == null ? null : [x0 + (w * i) / (values.length - 1), range ? h - pad - ((h - 2 * pad) * (v - low)) / range : h / 2]
        .map((n) => n.toFixed(1)));
    const path = points.map((p, i) => (p ? `${i && points[i - 1] ? 'L' : 'M'}${p.join(',')}` : '')).join(' ');
    const title = `近 1 小时${label}曲线`;
    if (!wide) {
      return `<svg class="summary-trend" viewBox="0 0 42 16" role="img" aria-label="${title}"><title>${title}</title><path data-trend="${key}" d="${path}"/></svg>`;
    }
    let area = '',
      run = [];
    const close = () => {
      if (run.length > 1) area += `M${run[0][0]},${h}L${run.map((p) => p.join(',')).join('L')}L${run.at(-1)[0]},${h}Z`;
      run = [];
    };
    points.forEach((p) => (p ? run.push(p) : close()));
    close();
    const last = points.findLast(Boolean).join(',');
    return `<svg class="summary-trend" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${title}"><title>${title}</title>
      <defs><linearGradient id="trend-fill-${uid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".2"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs>
      <path class="trend-area" fill="url(#trend-fill-${uid})" d="${area}"/><path data-trend="${key}" d="${path}"/>
      <path class="trend-ring" d="M${last}h0"/><path class="trend-dot" d="M${last}h0"/></svg>`;
  }
  // One cell per probe while they fit, otherwise a bar; the fill turns amber or rose as probes drop out.
  function kpiMeter(part, whole, tone) {
    if (part == null || !whole) return `<span class="kpi-meter neutral" aria-hidden="true"><i style="width:0"></i></span>`;
    if (whole <= 8 && Number.isInteger(whole)) {
      return `<span class="kpi-cells ${tone}" aria-hidden="true">${Array.from({ length: whole }, (_, i) => `<i${i < part ? ' class="on"' : ''}></i>`).join('')}</span>`;
    }
    return `<span class="kpi-meter ${tone}" aria-hidden="true"><i style="width:${((100 * part) / whole).toFixed(1)}%"></i></span>`;
  }
  // The desktop header stays on one line: hide the least needed pieces, in order, until it fits.
  const head = $('.board-head');
  function fitHead() {
    if (phone.matches) return head.removeAttribute('data-fit');
    for (let level = 0; level <= 5; level++) {
      head.dataset.fit = level;
      const boxes = [...head.children].filter((el) => el.offsetParent).map((el) => el.getBoundingClientRect());
      if (Math.max(...boxes.map((b) => b.top)) < Math.min(...boxes.map((b) => b.bottom))) return;
    }
  }
  function drawMetrics() {
    const route = selectedRoute();
    const scopeId = route?.id || 'all';
    const history = D.frame.trends[scopeId] || [];
    const summary = D.frame.summaries[scopeId] || {};
    const figures = route && routeFigures(route);
    const regional = figures?.regional;
    const anchor = figures?.ref;
    const metrics = $('#metrics'),
      scope = $('#metric-scope');
    metrics.setAttribute('aria-label', route ? route.name + '实时指标' : '全网实时指标');
    scope.hidden = !route;
    const scopeKey = route && JSON.stringify([route.id, route.name, anchor?.id]);
    if (route && scope.dataset.identity !== scopeKey) {
      scope.dataset.identity = scopeKey;
      scope.innerHTML = `<strong>${route.name}</strong><span>${routeMethod(route)}</span><button class="detail-link" data-open="route" data-id="${route.id}">线路详情</button>`;
    }
    const fields = route
      ? [
          [
            'delay',
            '分段合计（估算）',
            'latency',
            'blue',
            'ms',
            regional
              ? '入口到浙江运营商参考点的反测延迟与沿途各段实测耗时相加'
              : '从接入节点到落地节点的各段耗时之和，任一段缺测时显示待测',
            '分段合计',
          ],
          [
            'measured',
            '已测分段',
            'check',
            'mint',
            '',
            '最近 45 秒内有探测结果的分段数 / 计入合计的分段数，超时也算一次探测',
            '已测分段',
          ],
          ['upload', '线路上行', 'upload', 'violet', 'Mbps', '客户端按线路记录的上行速率，每个接入只统计一次', '上行'],
          ['faults', '异常分段', 'alert', 'fault-reading', '段', '此线路当前触发质量告警的分段数', '异常'],
        ]
      : [
          ['online', '在线探针', 'server', 'mint', '', '有主机探针的在线节点数与探针总数', '探针'],
          ['download', '总下行速率', 'download', 'blue', 'Mbps', '所有在线主机探针的网卡下行速率之和', '下行'],
          ['upload', '总上行速率', 'upload', 'violet', 'Mbps', '所有在线主机探针的网卡上行速率之和', '上行'],
          ['faults', '异常链路', 'alert', 'fault-reading', '段', '全网当前触发质量告警的分段数', '异常'],
        ];
    // The phone card names each figure in a word; the scope line above it says what was measured.
    const compact = phone.matches;
    metrics.innerHTML = fields
      .map(([key, label, symbol, tone, unit, description, short]) => {
        const v = route && key !== 'upload' ? figures[key] : summary[key];
        const missing = route && key === 'delay' ? figures.missing : '—';
        const speed = !route && ['upload', 'download'].includes(key) ? compactSpeed(v) : null;
        const value = speed
          ? speed[0]
          : v == null
            ? missing
            : fmt(v, key === 'delay' || (route && key === 'upload') ? 1 : 0);
        const suffix =
          key === 'online'
            ? `/ <span data-summary="total">${summary.total ?? '—'}</span>`
            : key === 'measured' && figures.segments ? `/ ${figures.segments}`
            : v == null
              ? ''
              : speed
                ? speed[1]
                : unit;
        const trend = ['delay', 'upload', 'download'].includes(key)
          ? summaryTrend(history, key === 'delay' ? 'segmentSum' : key, label, regional && key === 'delay' ? anchor?.id : null, compact)
          : '';
        const meter = !compact ? ''
          : key === 'online' ? kpiMeter(v, summary.total, v === summary.total ? 'mint' : v ? 'amber' : 'rose')
            : key === 'measured' ? kpiMeter(v, figures.segments, v === figures.segments ? 'mint' : 'amber')
              : '';
        return `<div class="${tone}${key === 'faults' && v > 0 ? ' has-faults' : ''}" data-kpi="${key}" title="${description}"><dt>${icon(symbol)}${compact ? short : label}</dt><dd><b data-summary="${key}">${value}</b><small>${suffix}</small>${trend}${meter}</dd></div>`;
      })
      .join('');
    fitHead();
    updatePhoneOverview();
  }
  // Below this column width a card and its readings no longer fit side by side, so the map scrolls sideways.
  const minColumn = 200;
  // Links between the same two cards bow apart by this much so each line keeps its own reading.
  const bundleGap = 30;
  function drawMap() {
    const stage = $('#map-stage');
    const connected = connectedIds(D.links);
    const topoNodes = D.nodes.filter((n) => connected.has(n.id) || n.routed);
    const startColumn = topoNodes.some((n) => n.col === 0) ? 0 : 1;
    const columnCount = Math.max(1, ...topoNodes.map((n) => n.col - startColumn + 1));
    const wide = stage.clientWidth > 0 && stage.clientWidth < minColumn * columnCount;
    stage.classList.toggle('is-wide', wide);
    const W = wide ? minColumn * columnCount : stage.clientWidth,
      H = stage.clientHeight;
    for (const layer of [$('#map-lines'), $('#map-labels'), $('#map-nodes')]) layer.style.width = wide ? W + 'px' : '';
    if (!W || !H) {
      highlightRoute();
      return;
    }
    const hasReferences = D.links.some((l) => l.referenceId);
    const columnWidth = W / columnCount;
    const width = Math.min(
      205,
      Math.max(hasReferences ? 128 : 134, columnWidth - (hasReferences ? 112 : 88)),
    );
    const inset = 12;
    // Cards are centred on their row, so keep half a card of room at the top and bottom edges.
    const insetY = Math.min(56, Math.max(inset, H / 6));
    // Stretch the configured rows over the full stage height so no band of the map sits empty.
    const rows = [...topoNodes.map((n) => n.row), ...D.links.flatMap((l) => (l.via || []).map((s) => s.row))].filter(
      (r) => r != null,
    );
    const rowMin = rows.length ? Math.min(...rows) : 0;
    const rowSpan = rows.length ? Math.max(...rows) - rowMin : 0;
    const rowAt = (row) => (rowSpan > 0 ? (row - rowMin) / rowSpan : 0.5);
    const entrySpace = hasReferences ? Math.min(38, Math.max(0, (columnWidth - width) / 2 - inset)) : 0;
    const point = (n) => ({
      x: columnWidth * (n.col - startColumn + 0.5) + (n.col === startColumn ? -entrySpace : entrySpace),
      y: insetY + rowAt(n.row) * (H - 2 * insetY),
    });
    const map = $('#map-lines');
    map.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const lines = [],
      labels = [];
    D.links.forEach((l, i) => {
      const reference = !!l.referenceId;
      // A link that closes a loop is drawn left to right like the rest; its packets run backwards.
      const [left, right] = l.flipped ? [l.to, l.from] : [l.from, l.to];
      const a = point(D.nodeById[left]),
        b = point(D.nodeById[right]);
      const x1 = a.x + width / 2,
        x2 = b.x - width / 2;
      const y1 = a.y + l.ports[0],
        y2 = b.y + l.ports[1] * (reference ? 3 : 1);
      const corridor = (l.via || []).flatMap((slot) => {
        const p = point(slot);
        return [
          { x: p.x - width / 2, y: p.y },
          { x: p.x + width / 2, y: p.y },
        ];
      });
      const points = [{ x: x1, y: y1 }, ...corridor, { x: x2, y: y2 }];
      const bow = !corridor.length && l.bundle ? { x: (x1 + x2) / 2, y: (y1 + y2) / 2 + l.bundle * bundleGap } : null;
      if (bow) points.splice(1, 0, bow);
      // A line through skipped columns reads best on its own lane, clear of the crowded ports.
      const lane = l.via?.length ? point(l.via[(l.via.length - 1) >> 1]) : bow;
      let labelX = lane ? lane.x : (x1 + points[1].x) / 2;
      let labelY = lane ? lane.y : (y1 + points[1].y) / 2;
      if (reference) {
        // Bring the pair in level at each probe so other curves clear its readings.
        const approach = points[points.length - 2];
        const gap = x2 - approach.x;
        labelX = x2 - Math.min(54, gap / 2);
        labelY = y2;
        points.splice(-1, 0, { x: Math.max(approach.x + gap / 4, labelX - 46), y: labelY });
      }
      let path = `M${x1},${y1}`;
      for (let j = 1; j < points.length; j++) {
        const from = points[j - 1],
          to = points[j],
          cx = (from.x + to.x) / 2;
        path += ` C${cx},${from.y} ${cx},${to.y} ${to.x},${to.y}`;
      }
      const tone = edgeTone(l);
      const direction = reference
        ? `${D.nodeById[l.to].name} → ${D.nodeById[l.from].name} · ICMP 反测`
        : l.flipped
          ? endpoints(l)
          : '';
      const reverseMotion = reference !== !!l.flipped ? ' keyPoints="1;0" keyTimes="0;1" calcMode="linear"' : '';
      const flowing = reference ? l.reading.latency != null : l.measured;
      lines.push(
        `<g class="edge-group ${tone}" data-edge="${l.id}" style="--flow-width:${flowWidth(l)}">
        ${reference ? `<path class="edge-bridge" d="${path}"/>` : ''}
        <path class="edge-line" d="${path}"/><path class="edge-hit" ${edgeButton(l)} d="${path}"/>
        <circle class="port" cx="${x1}" cy="${y1}" r="2.8"/><circle class="port" cx="${x2}" cy="${y2}" r="2.8"/>
        ${flowing ? `<circle class="packet" r="2.5"><animateMotion dur="${3.7 + (i % 3) * 0.7}s" begin="-${0.4 + i * 0.71}s" repeatCount="indefinite"${reverseMotion} path="${path}"/></circle>` : ''}</g>`,
      );
      const carrier = reference ? `<small>${D.nodeById[l.from].provider}</small>` : '';
      const rtt = carrier + (tone === 'amber' ? icon('alert') : '') + edgeValue(l);
      labels.push(
        `<button type="button" class="edge-label ${reference ? 'reference-label ' : ''}${tone}" data-edge="${l.id}" ${edgeButton(l)} style="left:${labelX}px;top:${labelY}px" ${direction ? `title="${direction}"` : ''}><span class="sr-only">${direction || endpoints(l)}，</span>${reference ? '' : mapLossBadge(l)}<span class="edge-rtt">${rtt}</span></button>`,
      );
    });
    map.innerHTML = lines.join('');
    $('#map-labels').innerHTML = labels.join('');
    $('#map-nodes').innerHTML = topoNodes
      .map((n) => {
        const p = point(n);
        return nodeCard(n, 'map-node', `left:${p.x}px;top:${p.y}px;width:${width}px`);
      })
      .join('');
    settleLabels(stage);
    if (!state.playing && map.pauseAnimations) map.pauseAnimations();
    highlightRoute();
    markSelection();
  }
  // Each reading starts at its usual spot and slides along its own line until it clears the cards and other readings.
  function settleLabels(stage) {
    const origin = stage.getBoundingClientRect();
    const box = (r, pad = 3) => ({
      l: r.left - origin.left + stage.scrollLeft - pad,
      r: r.right - origin.left + stage.scrollLeft + pad,
      t: r.top - origin.top - pad,
      b: r.bottom - origin.top + pad,
    });
    const taken = $$('#map-nodes .map-node', stage).map((el) => box(el.getBoundingClientRect()));
    const labels = $$('#map-labels .edge-label', stage);
    const overlaps = (b) => taken.some((t) => b.l < t.r && b.r > t.l && b.t < t.b && b.b > t.t);
    labels.filter((el) => el.classList.contains('reference-label')).forEach((el) => taken.push(box(el.getBoundingClientRect())));
    const movable = labels.filter((el) => !el.classList.contains('reference-label'));
    // Warnings claim their usual spot first.
    movable.sort((a, b) => /amber|rose/.test(b.className) - /amber|rose/.test(a.className));
    for (const label of movable) {
      const line = $(`.edge-group[data-edge="${CSS.escape(label.dataset.edge)}"] .edge-line`, stage);
      const start = { x: parseFloat(label.style.left), y: parseFloat(label.style.top) };
      // The loss badge sits above the reading, so the box reaches up to it.
      const own = box(label.getBoundingClientRect(), 0);
      const badge = $('.edge-loss', label);
      const top = badge ? Math.min(own.t, box(badge.getBoundingClientRect(), 0).t) : own.t;
      const half = Math.max(own.r - own.l, badge?.offsetWidth || 0) / 2 + 3;
      const centre = (own.t + own.b) / 2;
      const at = (p) => ({ l: p.x - half, r: p.x + half, t: p.y - (centre - top) - 3, b: p.y + (own.b - centre) + 3 });
      const length = line ? line.getTotalLength() : 0;
      const spots = [start, ...[0.5, 0.4, 0.6, 0.3, 0.7, 0.22, 0.78].map((f) => line.getPointAtLength(length * f))];
      const spot = (length ? spots : [start]).find((p) => !overlaps(at(p))) || start;
      label.style.left = `${spot.x}px`;
      label.style.top = `${spot.y}px`;
      taken.push(at(spot));
    }
  }
  function linksOfRoute(route) {
    if (!route) return D.links;
    const anchor = entryReference(route.entry);
    return route.links
      .map((id) => D.linkById[id])
      .filter((l) => l && (!l.referenceId || l.referenceId === anchor?.id));
  }
  // A preview from the route rail dims the map without changing the selected scope.
  function highlightRoute(preview) {
    const route = preview ? D.routes.find((r) => r.id === preview) : selectedRoute();
    const links = linksOfRoute(route);
    const nodeIds = route ? connectedIds(links) : new Set(D.nodes.map((n) => n.id));
    if (route) nodeIds.add(route.entry);
    const linkIds = new Set(links.map((l) => l.id));
    $$('#map-stage [data-edge]').forEach((el) => el.classList.toggle('dimmed', !linkIds.has(el.dataset.edge)));
    $$('[data-map-node]').forEach((el) => el.classList.toggle('dimmed', !nodeIds.has(el.dataset.mapNode)));
    if (!preview) $('#topo-count').textContent = `${nodeIds.size} 个节点 · ${links.length} 段链路`;
  }
  function markSelection() {
    const detail = sheet.open ? state.detail : null;
    const pick = (type, id) => detail?.type === type && detail.id === id;
    $$('[data-map-node]').forEach((el) => el.classList.toggle('is-selected', pick('node', el.dataset.mapNode)));
    $$('#map-stage [data-edge]').forEach((el) => {
      const id = el.dataset.edge;
      el.classList.toggle('is-selected', pick('link', id));
    });
  }
  // ---------- Phone: the network as a full-screen map, a sheet with the state and routes, details on demand ----------
  // The map shows one carrier at a time; picking one applies it to every entry that measures it.
  function phoneCarriers() {
    const entries = D.nodes.filter((n) => n.references?.length);
    const providers = [...new Set(entries.flatMap((n) => n.references.map((r) => r.provider)))];
    return { entries, providers, chosen: entries.length ? entryReference(entries[0].id)?.provider : null };
  }
  function setPhoneCarrier(provider) {
    phoneCarriers().entries.forEach((n) => sessionStorage.setItem('linkscope-carrier-choice-' + n.id, provider));
    drawTopology();
    drawMetrics();
    if (sheet.open) renderDetail();
  }
  // The hops a route's health is judged on, as in routeFigures.
  function routeLegs(route) {
    return D.nodeById[route.entry]?.references?.length
      ? linksOfRoute(route)
      : route.tail.map((id) => D.linkById[id]).filter(Boolean);
  }
  // A warned route names its first degraded hop and what is wrong with it.
  function routeIssue(route) {
    const l = routeLegs(route).find((x) => x.measured && x.state === 'degraded');
    if (!l) return null;
    const loss = lossOf(l);
    return { link: l, where: endpoints(l), what: loss > 0 ? `${l.mode === 'TCP' ? '超时率' : '丢包率'} ${percent(loss)}` : '延迟偏高' };
  }
  function phoneStatus() {
    const f = D.frame;
    const time = f.now ? D.time(f.now, true) : '';
    const warned = D.routes.filter((r) => routeFigures(r).health === 'warn');
    const timed = D.routes.map((r) => [r, routeFigures(r).delay]).filter(([, d]) => d != null).sort((a, b) => a[1] - b[1]);
    const fastest = timed.find(([r]) => routeFigures(r).health !== 'warn')?.[0];
    if ($('#topology').dataset.disconnected)
      return { tone: 'bad', title: '连接<em>已断开</em>', first: time ? `正在重连，显示的是 <b>${time}</b> 的数据。` : '正在连接面板。', when: time, fastest };
    if (f.lastReport == null) return { tone: 'idle', title: '等待探针上报', first: '探针上报后，这里会显示线路状态。', when: time, fastest };
    if (f.now - f.lastReport > 15000)
      return { tone: 'warn', title: '上报<em>已中断</em>', first: `最后一次上报在 <b>${D.time(f.lastReport, true)}</b>。`, when: time, fastest };
    if (warned.length) {
      const issue = routeIssue(warned[0]);
      const names = warned.map((r) => r.name).join('、');
      return {
        tone: 'warn',
        title: `${warned.length} 条线路<em>异常</em>`,
        first: issue
          ? `<button type="button" class="ps-jump" ${edgeButton(issue.link)}><b>${issue.where}</b> ${issue.what}，影响${names.slice(0, -1)}<span class="ps-nowrap">${names.slice(-1)}${icon('chevron-right')}</span></button>`
          : `影响${names}。`,
        when: time,
        fastest,
      };
    }
    return {
      tone: 'good',
      title: '一切正常',
      first: fastest ? `最快的是<b>${fastest.name}</b>，<b>${fmt(routeFigures(fastest).delay)} ms</b>。` : '线路还没有测量结果。',
      when: time,
      fastest,
    };
  }
  const phoneSpark = (route) => {
    const f = routeFigures(route);
    return summaryTrend(D.frame.trends[route.id] || [], 'segmentSum', route.name + '延迟', f.regional ? f.ref?.id : null, true, 'route-' + route.id, Math.max(10, (f.delay || 0) * 0.25));
  };
  const routeEnd = (route) => (route.tail.length ? D.nodeById[D.linkById[route.tail.at(-1)]?.to] : D.nodeById[route.entry]);
  function phoneRouteRow(route, fastest) {
    const f = routeFigures(route);
    const tone = f.health === 'warn' ? 'amber' : f.health === 'good' ? 'mint' : 'neutral';
    const issue = f.health === 'warn' ? routeIssue(route) : null;
    const stops = [route.entry, ...route.tail.map((id) => D.linkById[id]?.to)].filter(Boolean);
    const via = stops.length > 2 ? '经 ' + stops.slice(1, -1).map((id) => D.nodeById[id].name).join('、') : '直达 ' + (routeEnd(route)?.name || '');
    const end = routeEnd(route);
    // The row wears its line's colour as a ring round the flag and as its trend, so the list is the map's legend.
    const index = D.routes.indexOf(route);
    return `<button type="button" class="ps-route ${tone}${routeCased(index) ? ' cased' : ''}" style="--route-color:${routeLine(index)}" data-open="route" data-id="${route.id}" data-key="${tone}|${issue ? issue.where + issue.what : ''}|${route === fastest}">
      <span class="ps-flag">${end ? tileIcon(end) : ''}</span>
      <span class="ps-name">${route.name}${route === fastest ? '<span class="ps-fast">最快</span>' : ''}</span>
      <span class="ps-value" data-route-reading="${route.id}"></span>
      <span class="ps-via">${issue ? `${issue.where} · ${issue.what}` : via}</span>
      <span class="ps-trend" data-route-spark="${route.id}">${phoneSpark(route)}</span></button>`;
  }
  function phoneEvents() {
    const groups = eventGroups();
    if (!groups.length) return `<div class="ps-row is-calm"><span class="ps-lead">${icon('check')}</span><span><span>近 1 小时一切平稳</span></span></div>`;
    return groups
      .map((g) => {
        const target = g.type === 'link' ? D.linkById[g.id] : D.nodeById[g.id];
        const open = target ? `data-open="${g.type}" data-id="${g.id}"` : 'disabled';
        return `<button type="button" class="ps-row ${g.tone}" ${open}><span class="ps-lead"><i></i></span>
          <span><strong>${g.title}</strong><span>${g.text}${g.count > 1 ? ` · ${g.count} 次` : ''}</span></span><time>${D.time(g.at)}</time></button>`;
      })
      .join('');
  }
  function phoneChips() {
    return D.nodes
      .filter((n) => !n.sourceIp && n.kind !== 'reference')
      .map((n) => {
        const status = D.nodeState(n, state.now);
        const tone = ['online', 'connected'].includes(status) ? 'mint' : status === 'offline' ? 'down' : '';
        return `<button type="button" class="ps-chip ${tone}" ${nodeButton(n)}>${tileIcon(n)}${n.name}</button>`;
      })
      .join('');
  }
  function phoneVitals() {
    const all = D.frame.summaries.all || {};
    const [down, downUnit] = compactSpeed(all.download),
      [up, upUnit] = compactSpeed(all.upload);
    const short = all.total && all.online < all.total;
    return `<span${short ? ' class="is-short"' : ''}>${all.online ?? '—'}/${all.total ?? '—'} 探针在线</span> · 下行 ${down} ${downUnit} · 上行 ${up} ${upUnit}`;
  }
  function drawPhoneApp() {
    const content = $('#phone-content');
    content.innerHTML = `<header class="ps-status"><h2 id="phone-status" data-ps="title"></h2><time data-ps="when"></time>
        <p data-ps="first"></p><p class="ps-vitals" data-ps="vitals"></p></header>
      <p class="ps-label">线路</p><div class="ps-routes" data-ps="routes"></div>
      <p class="ps-label">最近 1 小时</p><div data-ps="events"></div>
      <p class="ps-label">节点</p><div class="ps-chips" data-ps="chips"></div>`;
    updatePhoneOverview();
    drawPhoneMap();
  }
  // Each refresh rewrites only the parts whose text changed, so a focused row keeps its focus.
  function updatePhoneOverview() {
    const content = $('#phone-content');
    if (!phone.matches || !$('[data-ps="routes"]', content)) return;
    const swap = (el, html) => {
      if (el && el.dataset.html !== html) {
        el.dataset.html = html;
        el.innerHTML = html;
      }
    };
    const s = phoneStatus();
    $('#topology').dataset.tone = s.tone;
    swap($('[data-ps="title"]', content), s.title);
    swap($('[data-ps="when"]', content), s.when);
    swap($('[data-ps="first"]', content), s.first);
    swap($('[data-ps="vitals"]', content), phoneVitals());
    const list = $('[data-ps="routes"]', content);
    const ids = D.routes.map((r) => r.id).join('|');
    if (list.dataset.ids !== ids) {
      list.dataset.ids = ids;
      list.innerHTML = D.routes.length ? D.routes.map((r) => phoneRouteRow(r, s.fastest)).join('') : '<p class="ps-empty">尚未配置线路</p>';
      updateRouteReadings(list);
    } else
      D.routes.forEach((route) => {
        const row = $(`[data-id="${CSS.escape(route.id)}"]`, list);
        const fresh = document.createElement('div');
        fresh.innerHTML = phoneRouteRow(route, s.fastest);
        const next = fresh.firstElementChild;
        if (row.dataset.key !== next.dataset.key) {
          const focused = row.contains(document.activeElement);
          row.replaceWith(next);
          updateRouteReadings(next);
          if (focused) next.focus({ preventScroll: true });
        } else swap($('[data-route-spark]', row), phoneSpark(route));
      });
    swap($('[data-ps="events"]', content), phoneEvents());
    swap($('[data-ps="chips"]', content), phoneChips());
  }
  // ---------- Phone map: a network topology ----------
  // Nodes are round flags with their names under them, in the desktop map's layers from top to bottom, and each link
  // is one thin curve carrying its delay. Streaks of light in each route's colour run along the links the route takes,
  // slower on slower links. Problems are marked on their link in words; an open detail zooms onto what it covers. The
  // four route colours live in mobile.css; routes five to eight reuse them as hollow streaks and any further routes
  // are drawn neutral.
  const routeLine = (i) => (i < 8 ? `var(--route-${(i % 4) + 1})` : 'var(--border-strong)');
  const routeCased = (i) => i >= 4 && i < 8;
  // A route's links in travel order: the chosen carrier's reverse test, then the route's own segments.
  function routeChain(route) {
    const ref = linksOfRoute(route).find((l) => l.referenceId);
    return [...(ref ? [ref] : []), ...route.tail.map((id) => D.linkById[id]).filter(Boolean)];
  }
  function phoneFocus() {
    if (!phone.matches || !sheet.open || !state.detail) return null;
    const { type, id } = state.detail;
    if (type === 'route') {
      const index = D.routes.findIndex((r) => r.id === id);
      const chain = index < 0 ? [] : routeChain(D.routes[index]);
      return { route: index, links: new Set(chain.map((l) => l.id)), nodes: new Set([D.routes[index]?.entry, ...chain.flatMap((l) => [l.from, l.to])]) };
    }
    if (type === 'node') {
      const near = D.links.filter((l) => l.from === id || l.to === id);
      return { route: null, links: new Set(near.map((l) => l.id)), nodes: new Set([id, ...near.flatMap((l) => [l.from, l.to])]) };
    }
    const l = D.linkById[id];
    return l ? { route: null, links: new Set([l.id]), nodes: new Set([l.from, l.to]) } : null;
  }
  // A point part of the way along a polyline, with the direction of the stretch it falls on.
  function pointAlong(pts, t) {
    const lens = pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]));
    let left = lens.reduce((a, b) => a + b, 0) * t;
    for (let i = 0; i < lens.length; i++) {
      if (left <= lens[i] || i === lens.length - 1) {
        const k = lens[i] ? Math.min(1, left / lens[i]) : 0;
        const d = [(pts[i + 1][0] - pts[i][0]) / (lens[i] || 1), (pts[i + 1][1] - pts[i][1]) / (lens[i] || 1)];
        return [[pts[i][0] + (pts[i + 1][0] - pts[i][0]) * k, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * k], d];
      }
      left -= lens[i];
    }
    return [pts.at(-1), [0, 1]];
  }
  // Width of a short 11.5px label: Chinese characters are about twice as wide as digits and Latin letters.
  const labelTextWidth = (text) => [...text].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e80 ? 11.6 : 6.8), 0);
  let drawnFocus = '';
  function drawPhoneMap() {
    const box = $('#phone-map');
    if (!phone.matches || !box || !box.clientWidth) return;
    const focus = phoneFocus();
    const { providers } = phoneCarriers();
    const Wv = box.clientWidth,
      W = Wv - 32,
      X = (x) => x + 16,
      f = (v) => v.toFixed(1);
    // The map leaves out visitor addresses and the carrier not chosen.
    const links = D.links.filter((l) => {
      if (D.nodeById[l.from]?.sourceIp || D.nodeById[l.to]?.sourceIp) return false;
      return !l.referenceId || l.referenceId === entryReference(l.to)?.id;
    });
    const linked = connectedIds(links);
    const nodes = D.nodes.filter((n) => n.col != null && !n.sourceIp && (linked.has(n.id) || (n.routed && n.kind !== 'reference')));
    if (!nodes.length) {
      box.replaceChildren();
      return;
    }
    const shown = new Set(nodes.map((n) => n.id));
    const drawnLinks = links.filter((l) => shown.has(l.from) && shown.has(l.to));
    // Items: nodes, and a pass-through lane wherever a link skips a layer, in the desktop map's columns.
    const vias = (l) => [...(l.via || [])].sort((a, b) => a.col - b.col);
    const ends = (l) => (l.flipped ? [l.to, l.from] : [l.from, l.to]);
    const cols = [...new Set([...nodes.map((n) => n.col), ...drawnLinks.flatMap((l) => vias(l).map((v) => v.col))])].sort((a, b) => a - b);
    const item = {};
    nodes.forEach((n) => (item[n.id] = { id: n.id, tier: cols.indexOf(n.col), order: n.row ?? 0.5, node: n, origin: n.kind === 'reference' }));
    drawnLinks.forEach((l) =>
      vias(l).forEach((v, k) => (item[`${l.id}#${k}`] = { id: `${l.id}#${k}`, tier: cols.indexOf(v.col), order: v.row ?? 0.5, lane: true })),
    );
    // Along a link from its upper end: the items it passes, top to bottom.
    const along = (l) => {
      const ids = [ends(l)[0], ...vias(l).map((_, k) => `${l.id}#${k}`), ends(l)[1]];
      return item[ids[0]].tier <= item[ids.at(-1)].tier ? ids : ids.reverse();
    };
    // The routes through each link, for the streaks that run along it.
    const routesOn = {};
    D.routes.forEach((route, ri) => routeChain(route).forEach((l) => (routesOn[l.id] ||= []).push(ri)));
    // Names are measured on one line and split over two; the carrier's pill is measured too.
    const halves = (name) => {
      const at = name.indexOf(' '),
        tail = name.match(/(出口|入口|中转|落地|节点)$/);
      const cut = at > 0 ? at : tail?.index > 0 ? tail.index : Math.ceil(name.length / 2);
      return [name.slice(0, cut).trim(), name.slice(cut).trim()];
    };
    const suffix = (n) => {
      const status = D.nodeState(n, state.now);
      return ['offline', 'waiting'].includes(status) ? ' · ' + stateText[status] : '';
    };
    const named = Object.values(item).filter((it) => it.node && !it.origin);
    const origins = Object.values(item).filter((it) => it.origin);
    const many = providers.length > 1;
    const pill = (n, cls = '', attrs = '') =>
      `<button type="button" class="mm-origin${cls}" data-phone-carrier${attrs} aria-label="${D.escape(n.name)}${many ? '，点按切换运营商' : ''}"><span class="mm-home">${icon('home')}</span>${D.escape(n.name)}${many ? `<small>${icon('swap')}切换</small>` : ''}</button>`;
    const probe = document.createElement('div');
    probe.className = 'mm-probe';
    probe.innerHTML =
      named
        .map((it) => {
          const [a, b] = halves(it.node.name),
            tail = suffix(it.node);
          return [['w1', it.node.name + tail], ['wa', a], ['wb', b + tail]]
            .map(([k, text]) => `<span class="tp-text" data-id="${D.escape(it.id)}" data-k="${k}">${D.escape(text)}</span>`)
            .join('');
        })
        .join('') + origins.map((o) => pill(o.node, '', ` data-id="${D.escape(o.id)}"`)).join('');
    box.append(probe);
    $$('.tp-text', probe).forEach((el) => (item[el.dataset.id][el.dataset.k] = el.offsetWidth));
    $$('.mm-origin', probe).forEach((el) => (item[el.dataset.id].pillW = el.offsetWidth));
    probe.remove();
    named.forEach((it) => (it.w2 = Math.max(it.wa, it.wb)));
    // Layers in the desktop map's order.
    const tiers = cols.map(() => []);
    Object.values(item).forEach((it) => tiers[it.tier].push(it));
    tiers.forEach((t) => t.sort((a, b) => a.order - b.order));
    const body = tiers.map((t) => t.filter((it) => !it.origin));
    const last = tiers.length - 1;
    // Sizes: nodes and names shrink together until every layer fits on one line and every layer fits in the height,
    // from 46px nodes with 13px names to 30px with 11.5px. A map still too crowded then splits its longest names over
    // two lines, and only after that scales down as a whole. Names were measured at 13px.
    const SIZES = [[46, 13], [42, 12.5], [38, 12], [34, 12], [30, 11.5]];
    const top = $('.board-head').offsetHeight + (origins.length ? 48 : 34);
    const room = $('#phone-next').offsetTop - 24 - top;
    const gapAt = (node, a, b) => (a.lane || b.lane ? 8 : Math.round(node * 0.3));
    const footAt = (node, font, it) => (it.lane ? 6 : Math.max(node, (it.wrap ? it.w2 : it.w1) * (font / 13)));
    const widthAt = (t, node, font) => t.reduce((sum, it, k) => sum + footAt(node, font, it) + (k ? gapAt(node, t[k - 1], it) : 0), 0);
    const tallAt = (node, font) => last * (node + 66) + node / 2 + 5 + Math.round(font * 1.3) <= room;
    let size = SIZES.find(([node, font]) => tallAt(node, font) && body.every((t) => widthAt(t, node, font) <= W));
    if (!size) {
      size = SIZES.at(-1);
      body.forEach((t) =>
        t
          .filter((it) => !it.lane && it.w2 < it.w1)
          .sort((a, b) => b.w1 - a.w1)
          .forEach((it) => widthAt(t, ...size) > W && (it.wrap = true)),
      );
    }
    const [NODE, FONT] = size,
      RAD = NODE / 2;
    const nameH = (it) => Math.round(FONT * (it.wrap ? 2.55 : 1.3));
    const gapOf = (a, b) => gapAt(NODE, a, b);
    body.forEach((t) => t.forEach((it) => (it.fw = footAt(NODE, FONT, it))));
    // Each layer keeps its order and its gaps, inside the screen where it fits.
    const place = (t) => {
      let edge = -Infinity;
      t.forEach((it, k) => {
        const min = k ? edge + gapOf(t[k - 1], it) + it.fw / 2 : it.fw / 2;
        if (it.x < min) it.x = min;
        edge = it.x + it.fw / 2;
      });
      edge = Infinity;
      for (let k = t.length - 1; k >= 0; k--) {
        const it = t[k];
        const max = k < t.length - 1 ? edge - gapOf(it, t[k + 1]) - it.fw / 2 : W - it.fw / 2;
        if (it.x > max) it.x = max;
        edge = it.x - it.fw / 2;
      }
    };
    const up = {},
      down = {};
    drawnLinks.forEach((l) => {
      const ids = along(l);
      ids.slice(1).forEach((b, k) => {
        (down[ids[k]] ||= []).push(b);
        (up[b] ||= []).push(ids[k]);
      });
    });
    const mean = (ids) => ids.reduce((sum, id) => sum + item[id].x, 0) / ids.length;
    body.forEach((t) => {
      t.forEach((it, k) => (it.x = (W * (k + 0.5)) / t.length));
      place(t);
    });
    // Pull each item toward what it connects to, keeping the desktop map's order within each layer.
    for (let round = 0; round < 4; round++) {
      for (let i = body.length - 2; i >= 0; i--) {
        body[i].forEach((it) => {
          const near = (down[it.id] || []).filter((id) => !item[id].origin);
          if (near.length) it.x = mean(near);
        });
        place(body[i]);
      }
      for (let i = 1; i < body.length; i++) {
        body[i].forEach((it) => {
          const near = (up[it.id] || []).filter((id) => !item[id].origin);
          if (near.length) it.x = (it.x + mean(near)) / 2;
        });
        place(body[i]);
      }
    }
    // Names sit under their nodes, so the drawing is centred as a whole, then spread out from its middle to use the
    // width, at most 1.8 times as wide as packed.
    const every = body.flat();
    const extent = () => [Math.min(...every.map((it) => it.x - it.fw / 2)), Math.max(...every.map((it) => it.x + it.fw / 2))];
    let [lo, hi] = extent();
    every.forEach((it) => (it.x += (W - (hi - lo)) / 2 - lo));
    const left = every.reduce((a, b) => (b.x - b.fw / 2 < a.x - a.fw / 2 ? b : a)),
      right = every.reduce((a, b) => (b.x + b.fw / 2 > a.x + a.fw / 2 ? b : a));
    const span = right.x - left.x;
    if (span > 0) {
      const grow = Math.max(1, Math.min(1.8, (W - left.fw / 2 - right.fw / 2) / span));
      every.forEach((it) => (it.x = W / 2 + (it.x - W / 2) * grow));
    }
    [lo, hi] = extent();
    // Layers from the top bar down to the button under the map, or to an open detail.
    const bottom = sheet.open ? box.clientHeight - sheet.offsetHeight - 30 : $('#phone-next').offsetTop - 24;
    const foot = RAD + 5 + Math.max(0, ...(body[last] || []).map(nameH));
    const band = Math.max(NODE + 66, Math.min(220, (bottom - top - foot) / Math.max(1, last)));
    const height = band * last + foot;
    const lift = Math.max(0, (bottom - top - height) / 2);
    tiers.forEach((t, i) => t.forEach((it) => (it.y = top + lift + i * band)));
    // The carrier's pill sits over the middle of the screen, or over the links an open detail covers.
    const covers = (l) => focus && (focus.route != null ? routeChain(D.routes[focus.route]).some((x) => x.id === l.id) : focus.links.has(l.id));
    const sx = (it) => (it.origin ? it.sx : X(it.x));
    origins.forEach((o) => {
      const out = drawnLinks.filter((l) => along(l)[0] === o.id);
      const lit = out.filter(covers);
      const xs = lit.length ? lit.map((l) => X(item[along(l)[1]].x)) : [Wv / 2];
      const half = (o.pillW || 150) / 2;
      o.sx = Math.max(half + 8, Math.min(Wv - half - 8, xs.reduce((a, b) => a + b, 0) / xs.length));
      // Links leave from along the bottom of the pill, in the order of where they go.
      out
        .sort((a, b) => item[along(a)[1]].x - item[along(b)[1]].x)
        .forEach((l, k) => (o.leave ||= {})[l.id] = Math.max(-(half - 18), Math.min(half - 18, (k - (out.length - 1) / 2) * 12)));
    });
    // Several links leaving or entering a node fan out around its edge, in the order of where they come from or go.
    const outs = {},
      ins = {},
      leave = {},
      enter = {};
    drawnLinks.forEach((l) => {
      const ids = along(l);
      (outs[ids[0]] ||= []).push(l);
      (ins[ids.at(-1)] ||= []).push(l);
    });
    const fan = (list, into, toward) =>
      list
        .sort((a, b) => toward(a) - toward(b))
        .forEach((l, k) => (into[l.id] = Math.max(-RAD * 0.62, Math.min(RAD * 0.62, (k - (list.length - 1) / 2) * 8))));
    Object.entries(outs).forEach(([id, list]) => !item[id].origin && fan(list, leave, (l) => sx(item[along(l)[1]])));
    Object.entries(ins).forEach(([id, list]) => fan(list, enter, (l) => sx(item[along(l).at(-2)])));
    // Links enter a node at the edge of its ring and leave from under its name, so they never cross it.
    const pointsOf = (l) =>
      along(l).map((id, k) => {
        const it = item[id];
        if (it.origin) return [it.sx + it.leave[l.id], it.y + 18];
        if (it.lane) return [sx(it), it.y];
        if (!k) return [sx(it) + leave[l.id], it.y + RAD + 5 + nameH(it) + 3];
        return [sx(it) + enter[l.id], it.y - Math.sqrt(RAD * RAD - enter[l.id] ** 2)];
      });
    // Smooth curves that leave and enter every point vertically.
    const curve = (pts) =>
      pts.slice(1).reduce((d, [x1, y1], i) => {
        const [x0, y0] = pts[i],
          c = (y1 - y0) * 0.5;
        return d + ` C${f(x0)},${f(y0 + c)} ${f(x1)},${f(y1 - c)} ${f(x1)},${f(y1)}`;
      }, `M${f(pts[0][0])},${f(pts[0][1])}`);
    const sample = (pts, n = 8) => {
      const out = [pts[0]];
      for (let i = 1; i < pts.length; i++) {
        const [x0, y0] = pts[i - 1],
          [x1, y1] = pts[i],
          c = (y1 - y0) * 0.5;
        for (let s = 1; s <= n; s++) {
          const t = s / n,
            u = 1 - t;
          out.push([u * u * (1 + 2 * t) * x0 + t * t * (3 - 2 * t) * x1, u * u * u * y0 + 3 * u * u * t * (y0 + c) + 3 * u * t * t * (y1 - c) + t * t * t * y1]);
        }
      }
      return out;
    };
    // The length of a curve, summed over short straight pieces.
    const lengthOf = (pts) => sample(pts, 24).reduce((sum, p, i, all) => sum + (i ? Math.hypot(p[0] - all[i - 1][0], p[1] - all[i - 1][1]) : 0), 0);
    // ---------- Drawing ----------
    const lines = [],
      flows = [],
      notes = [],
      taken = [],
      seen = [];
    const path = {};
    drawnLinks.forEach((l, li) => {
      const pts = pointsOf(l),
        d = curve(pts);
      path[l.id] = sample(pts);
      const tone = edgeTone(l);
      const on = !focus || covers(l);
      const kind = tone === 'neutral' ? ' pending' : tone === 'amber' || tone === 'rose' ? ` broken ${tone}` : '';
      const state_ = focus ? (on ? ' lit' : ' dim') : '';
      const color = focus?.route != null && on ? ` style="--route-color:${routeLine(focus.route)}"` : '';
      lines.push(`<path class="tp-glow${state_}"${color} d="${d}"/><path class="tp-link${kind}${state_}"${color} d="${d}"/><path class="mm-hit" ${edgeButton(l)} d="${d}"/>`);
      const latency = l.reading?.latency;
      if (!(l.referenceId ? latency != null : l.measured) || !on) return;
      // A short streak of light in each route's colour runs along the link, slower for a longer delay: a dash as long
      // as the streak, moved from before the start to past the end. As on the desktop map, a reverse test and a link
      // that closes a loop run theirs against the drawing.
      const dur = Math.min(7, 1.6 + (latency ?? 60) / 45);
      const len = lengthOf(pts),
        streak = Math.min(36, len * 0.35);
      const [from, to] = !!l.referenceId !== !!l.flipped ? [-len, streak] : [streak, -len];
      const rs = focus?.route != null ? [focus.route] : routesOn[l.id] || [null];
      rs.forEach((ri, k) => {
        const run = `<animate attributeName="stroke-dashoffset" from="${f(from)}" to="${f(to)}" dur="${dur.toFixed(2)}s" begin="-${(((k * dur) / rs.length + li * 0.37) % dur).toFixed(2)}s" repeatCount="indefinite"/>`;
        const dash = `d="${d}" stroke-dasharray="${f(streak)} ${f(len + streak)}" style="--route-color:${ri == null ? 'var(--muted)' : routeLine(ri)}"`;
        const hollow = ri != null && routeCased(ri);
        flows.push(
          `<path class="mm-train tp-flow-glow" ${dash}>${run}</path><path class="mm-train tp-flow${hollow ? ' cased' : ''}" ${dash}>${run}</path>` +
            (hollow ? `<path class="mm-train tp-flow-core" ${dash}>${run}</path>` : ''),
        );
      });
    });
    // Nodes: the flag in a ring, the name under it. A live probe has a soft glow; an offline one a red dashed ring.
    const nodesHtml = named
      .map((it) => {
        const n = it.node;
        const status = D.nodeState(n, state.now);
        const down_ = ['offline', 'waiting'].includes(status);
        const live = ['online', 'connected'].includes(status);
        const dim = focus && !focus.nodes.has(n.id) ? ' dim' : '';
        const picked = state.detail?.type === 'node' && state.detail.id === n.id && sheet.open ? ' picked' : '';
        const name = it.wrap ? halves(n.name).map(D.escape).join('<br />') : D.escape(n.name);
        const tag = down_ ? `<small> · ${stateText[status]}</small>` : '';
        const area = { l: X(it.x) - it.fw / 2, r: X(it.x) + it.fw / 2, t: it.y - RAD - 2, b: it.y + RAD + 5 + nameH(it) };
        taken.push(area);
        if (focus?.nodes.has(n.id)) seen.push(area);
        return `<button type="button" class="tp-node${down_ ? ' down' : live ? ' live' : ''}${dim}${picked}" ${nodeButton(n)} style="left:${f(X(it.x))}px;top:${f(it.y - RAD)}px"><span class="tp-ring">${tileIcon(n)}</span><span class="tp-name">${name}${tag}</span></button>`;
      })
      .join('');
    const pillsHtml = origins
      .map((o) => {
        const area = { l: o.sx - (o.pillW || 150) / 2, r: o.sx + (o.pillW || 150) / 2, t: o.y - 20, b: o.y + 20 };
        taken.push(area);
        if (focus?.nodes.has(o.id)) seen.push(area);
        return pill(o.node, focus && !focus.nodes.has(o.id) ? ' dim' : '', ` style="left:${f(o.sx)}px;top:${f(o.y)}px"`);
      })
      .join('');
    // Notes sit on their own link, as on the desktop map, sliding along it until they clear the nodes, the names,
    // other notes and, where they can, other links.
    const traces = drawnLinks.flatMap((l) =>
      path[l.id].slice(1).flatMap(([x1, y1], i) => {
        const [x0, y0] = path[l.id][i],
          n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 6));
        return Array.from({ length: n }, (_, k) => {
          const x = x0 + ((x1 - x0) * k) / n,
            y = y0 + ((y1 - y0) * k) / n;
          return { l: x - 3, r: x + 3, t: y - 3, b: y + 3, id: l.id };
        });
      }),
    );
    const hits = (r, boxes) => boxes.some((o) => r.l < o.r && o.l < r.r && r.t < o.b && o.t < r.b);
    // A link too short for its note on it takes the note beside it.
    const placeNote = (l, w, h) => {
      const at = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74].map((t) => pointAlong(path[l.id], t));
      const inside = (r) => r.l >= 4 && r.r <= Wv - 4 && r.t >= top - 40;
      const on = at.map(([[px, py]]) => ({ l: px - w / 2, r: px + w / 2, t: py - h / 2, b: py + h / 2 })).filter(inside);
      const beside = at
        .flatMap(([[px, py], d]) =>
          Math.abs(d[0]) > Math.abs(d[1]) * 1.5
            ? [[px - w / 2, py - 7 - h], [px - w / 2, py + 7]]
            : [[px + 7, py - h / 2], [px - 7 - w, py - h / 2]],
        )
        .map(([x, y]) => ({ l: x, r: x + w, t: y, b: y + h }))
        .filter(inside);
      const others = traces.filter((o) => o.id !== l.id);
      const r = on.find((r) => !hits(r, taken) && !hits(r, others)) || on.find((r) => !hits(r, taken)) || beside.find((r) => !hits(r, taken));
      if (r) taken.push(r);
      return r || null;
    };
    // Problems sit beside their link as a marker with an icon and words; colour alone never carries them.
    drawnLinks
      .filter((l) => ['amber', 'rose'].includes(edgeTone(l)) && (!focus || covers(l)))
      .forEach((l) => {
        const status = l.referenceId ? (l.reading.latency == null ? referenceDelay(l.reading) : '') : delayStatus(l);
        const loss = l.referenceId ? l.reading.packetLoss : lossOf(l);
        const word = l.mode === 'TCP' ? '超时' : '丢包';
        const [html, plain] = status ? [status, status] : loss > 0 ? [`${word} ${lossOrTimeoutValue(l)}`, `${word} ${percent(loss)}`] : ['延迟偏高', '延迟偏高'];
        const r = placeNote(l, 30 + labelTextWidth(plain), 22);
        if (r) notes.push(`<button type="button" class="mm-alert ${edgeTone(l)}" ${edgeButton(l)} title="${D.escape(endpoints(l))}" style="left:${f(r.l)}px;top:${f(r.t)}px">${icon('alert')}${html}</button>`);
        if (r && focus) seen.push(r);
      });
    // Delays: on every healthy measured link of the overview, as on the desktop map, and on every link a detail covers.
    drawnLinks
      .filter((l) => (focus ? covers(l) : edgeTone(l) === 'mint'))
      .forEach((l) => {
        const plain = l.referenceId ? referenceDelay(l.reading) : delayStatus(l) || `${fmt(l.reading.latency)} ms`;
        const r = focus ? placeNote(l, 16 + labelTextWidth(plain), 20) : placeNote(l, 12 + labelTextWidth(plain) * 0.92, 18);
        const line = focus?.route != null ? routeLine(focus.route) : 'var(--border-strong)';
        if (r) notes.push(`<button type="button" class="mm-ms ${edgeTone(l)}${focus ? '' : ' quiet'}" ${edgeButton(l)} title="${D.escape(endpoints(l))}" style="left:${f(r.l)}px;top:${f(r.t)}px;--route-color:${line}">${edgeValue(l)}</button>`);
        if (r && focus) seen.push(r);
      });
    // An open detail zooms the map onto the links, nodes and readings it covers, in the room between the top bar and
    // the detail. Otherwise, where even the tightest layers do not fit, the whole map scales down.
    const view = { k: Math.max(0.5, Math.min(1, (bottom - top) / Math.max(1, height), W / Math.max(1, hi - lo))) };
    if (focus && seen.length) {
      drawnLinks.filter(covers).forEach((l) => path[l.id].forEach(([x, y]) => seen.push({ l: x - 6, r: x + 6, t: y - 6, b: y + 6 })));
      const l = Math.min(...seen.map((r) => r.l)) - 8,
        r = Math.max(...seen.map((r) => r.r)) + 8,
        t = Math.min(...seen.map((r) => r.t)) - 8,
        b = Math.max(...seen.map((r) => r.b)) + 8;
      const roomTop = $('.board-head').offsetHeight + 4,
        roomBottom = box.clientHeight - (sheet.open ? sheet.offsetHeight : 0) - 8;
      view.k = Math.max(0.45, Math.min(1.2, (Wv - 24) / (r - l), (roomBottom - roomTop) / (b - t)));
      view.at = [(l + r) / 2, (t + b) / 2];
      view.to = [Wv / 2, (roomTop + roomBottom) / 2];
    }
    const camera = (k) => `translate(${f(view.to[0] - k * view.at[0])}px,${f(view.to[1] - k * view.at[1])}px) scale(${k.toFixed(3)})`;
    const style = view.at ? `transform-origin:0 0;transform:${camera(view.k)}` : `transform-origin:50% ${f(top)}px;${view.k < 1 ? `transform:scale(${view.k.toFixed(3)})` : ''}`;
    box.innerHTML = `<div class="mm-layer tp-map" style="--node:${NODE}px;--name:${FONT}px;${style}"><svg viewBox="0 0 ${Wv} ${box.clientHeight}" aria-hidden="true">${lines.join('')}${flows.join('')}</svg>${nodesHtml}${notes.join('')}${pillsHtml}</div>`;
    box.dataset.width = Wv;
    // Opening a detail, or another one, zooms in towards it; closing it lets the whole map fade back.
    const key = view.at ? `${state.detail.type}:${state.detail.id}` : '';
    if (key !== drawnFocus && !matchMedia('(prefers-reduced-motion: reduce)').matches)
      box.firstElementChild.animate(
        view.at ? [{ transform: camera(view.k * 0.86), opacity: 0.35 }, { transform: camera(view.k), opacity: 1 }] : [{ opacity: 0.35 }, { opacity: 1 }],
        { duration: 380, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
      );
    drawnFocus = key;
  }
  // ---------- Detail sheet: drag to one of three heights ----------
  const phoneSnaps = () => [0.44, 0.64, 0.9].map((r) => Math.round(innerHeight * r));
  // A sheet follows a drag on its grab strip; the strip can be redrawn with the content, so the sheet listens.
  function dragSheet(panel, prop) {
    let start = null;
    panel.addEventListener('pointerdown', (e) => {
      const handle = e.target.closest('[data-grab]');
      if (!handle) return;
      handle.setPointerCapture(e.pointerId);
      start = { y: e.clientY, h: panel.offsetHeight, moved: false };
      panel.classList.add('is-dragging');
    });
    panel.addEventListener('pointermove', (e) => {
      if (!start) return;
      const dy = start.y - e.clientY;
      if (Math.abs(dy) > 4) start.moved = true;
      const [peek, , full] = phoneSnaps();
      panel.style.setProperty(prop, Math.max(peek - 80, Math.min(full, start.h + dy)) + 'px');
    });
    const settle = () => {
      if (!start) return;
      const s = phoneSnaps(),
        now = panel.offsetHeight;
      // A tap steps up one height and wraps to the lowest; a drag settles on the nearest.
      const at = s.findIndex((v) => Math.abs(v - start.h) < 3);
      const next = start.moved ? s.reduce((a, b) => (Math.abs(b - now) < Math.abs(a - now) ? b : a)) : s[(at + 1) % s.length];
      start = null;
      panel.classList.remove('is-dragging');
      panel.style.setProperty(prop, next + 'px');
      drawPhoneMap();
    };
    panel.addEventListener('pointerup', settle);
    panel.addEventListener('pointercancel', settle);
  }
  // ---------- Phone pages: the map, and under it the overview ----------
  // A swipe up on the map, the wheel or the button under the map turns to the overview. A swipe down from the
  // overview's top, the button there or the back gesture returns to the map. Details are read against the map, so
  // one opened from the overview turns back to the map, and closing it returns to the overview.
  const pager = $('#phone-pages'),
    overview = $('#phone-overview');
  let page = 0,
    detailFrom = 0;
  function showPage(next) {
    const leaving = next ? $('#phone-map-page') : overview;
    const focused = leaving.contains(document.activeElement);
    page = next;
    pager.classList.remove('is-dragging');
    pager.style.transform = '';
    pager.dataset.page = next;
    $('#topology').dataset.page = next ? 'overview' : 'map';
    $('#phone-map-page').inert = !!next;
    overview.inert = !next;
    if (focused) $(next ? '#phone-prev' : '#phone-next').focus({ preventScroll: true });
  }
  // Turning by hand gives the overview one history entry, so the back gesture returns to the map.
  function turnPage(next) {
    if (next !== page) {
      if (next) history.pushState({ linkscopePage: true }, '');
      else if (history.state?.linkscopePage) history.back();
    }
    showPage(next);
  }
  // The pages follow a one-finger swipe or a mouse drag and settle on release, on the other page when the swipe
  // went far or fast enough. On the overview only a swipe down that starts at its top turns the page.
  let swipe = null,
    swipedAt = -Infinity;
  const zoomed = () => (window.visualViewport?.scale || 1) > 1.01;
  function swipeStart(x, y) {
    swipe = phone.matches && !sheet.open && !zoomed() ? { x, y, from: page, top: page === 0 || overview.scrollTop <= 0, mine: null, moves: [] } : null;
  }
  function swipeMove(x, y) {
    if (!swipe) return false;
    if (swipe.mine == null) {
      const dx = x - swipe.x,
        dy = y - swipe.y;
      if (Math.hypot(dx, dy) < 8) return false;
      swipe.mine = Math.abs(dy) > Math.abs(dx) && (swipe.from === 0 || (swipe.top && dy > 0));
      if (!swipe.mine) return false;
      swipe.y = y;
      pager.classList.add('is-dragging');
      getSelection()?.removeAllRanges();
    }
    if (!swipe.mine) return false;
    const h = pager.clientHeight;
    pager.style.transform = `translateY(${Math.min(0, Math.max(-h, y - swipe.y - swipe.from * h))}px)`;
    swipe.moves.push([performance.now(), y]);
    if (swipe.moves.length > 6) swipe.moves.shift();
    return true;
  }
  function swipeEnd() {
    const s = swipe;
    swipe = null;
    if (!s?.mine) return;
    swipedAt = performance.now();
    const [t0, y0] = s.moves[0],
      [t1, y1] = s.moves.at(-1);
    // The map turns on a swipe up and the overview on a swipe down; a swipe that turned back stays.
    const way = s.from === 0 ? -1 : 1;
    const moved = (y1 - s.y) * way,
      speed = ((y1 - y0) / Math.max(1, t1 - t0)) * way;
    const turn = (moved > pager.clientHeight * 0.2 && speed > -0.2) || (speed > 0.35 && moved > 16);
    turnPage(turn ? 1 - s.from : s.from);
  }
  function swipeCancel() {
    if (swipe?.mine) showPage(page);
    swipe = null;
  }
  function routeFigures(route) {
    const summary = D.frame.summaries[route.id] || {};
    const regional = !!D.nodeById[route.entry]?.references?.length;
    const ref = regional ? entryReference(route.entry) : null;
    const delay = regional ? summary.estimates?.[ref?.id] : summary.segmentSum;
    const legs = regional ? linksOfRoute(route) : route.tail.map((id) => D.linkById[id]);
    const measured = legs.filter((l) => l.measured);
    const faults = measured.length ? measured.filter((l) => l.state === 'degraded').length : null;
    const warning = faults > 0 ? '分段异常' : '';
    const health = faults > 0 ? 'warn' : delay == null ? 'idle' : 'good';
    return {
      regional, ref, delay, missing: legs.length ? '待测' : '无可测分段', faults, warning, health,
      measured: legs.length ? measured.length : null, segments: legs.length,
    };
  }
  function updateRouteReadings(root = document) {
    $$('[data-route-reading]', root).forEach((el) => {
      const route = D.routes.find((r) => r.id === el.dataset.routeReading);
      if (!route) return;
      const { delay, missing, warning, health } = routeFigures(route);
      const html = (delay == null ? `<small>${missing}</small>` : `<b>${fmt(delay)}</b><small>ms</small>`)
        + (warning ? `<em>${warning}</em>` : '');
      if (el.innerHTML !== html) el.innerHTML = html;
      const row = el.closest('[data-health]');
      if (row && row.dataset.health !== health) row.dataset.health = health;
    });
    $$('[data-route-figure]', root).forEach((el) => {
      const route = D.routes.find((r) => r.id === el.dataset.routeId);
      if (!route) return;
      const f = routeFigures(route);
      const key = el.dataset.routeFigure;
      const v = f[key];
      const number = key === 'faults' || Number.isInteger(v) ? String(v) : fmt(v);
      const unit = key === 'measured' ? '/ ' + f.segments : el.dataset.unit;
      const html = v == null ? (key === 'delay' ? f.missing : '—') : `${number}<em>${unit}</em>`;
      if (el.innerHTML !== html) el.innerHTML = html;
    });
  }
  function routeMethod(route) {
    const ref = entryReference(route.entry);
    return ref ? referenceName(ref) + ' · 分段估算' : '节点间分段估算';
  }
  function carrierButtons(route) {
    const heads = route.paths.map((path) => D.linkById[path[0]]).filter((l) => l?.referenceId);
    const chosen = heads.find((l) => l.referenceId === entryReference(route.entry)?.id);
    return {
      heads,
      chosen,
      html: heads
        .map((l) => `<button type="button" data-carrier-link="${l.id}" aria-pressed="${l === chosen}">${D.nodeById[l.from].provider}</button>`)
        .join(''),
    };
  }
  function railRoute(route) {
    const entry = D.nodeById[route.entry];
    const end = route.tail.length ? D.nodeById[D.linkById[route.tail.at(-1)].to] : entry;
    const segments = Math.max(0, ...route.paths.map((path) => path.length));
    const selected = state.route === route.id;
    const carriers = selected ? carrierButtons(route).html : '';
    return `<div class="rail-route${selected ? ' is-selected' : ''}" data-health="${routeFigures(route).health}">
      <button type="button" class="rail-route-main" data-select-route="${route.id}" aria-pressed="${selected}">
        <span class="rail-flag">${tileIcon(end)}</span>
        <span class="rail-copy"><strong>${route.name}</strong><small>${segments ? segments + ' 段' : '直连'} · ${routeMethod(route)}</small></span>
        <span class="rail-reading" data-route-reading="${route.id}"></span></button>
      ${selected ? `<div class="rail-route-tools">${carriers ? `<div class="segment" role="group" aria-label="浙江入口运营商">${carriers}</div>` : ''}<button type="button" class="detail-link" data-open="route" data-id="${route.id}">线路详情${icon('chevron-right')}</button></div>` : ''}
    </div>`;
  }
  function railNode(n) {
    const status = D.nodeState(n, state.now);
    return `<button type="button" class="rail-node ${n.tone}" data-state="${status}" ${nodeButton(n)} style="${borderStyle(n)}">
      ${tileIcon(n)}<span class="node-copy"><strong>${n.name}</strong><small>${n.place} · ${n.provider}</small></span>
      <span class="card-vitals">${cardReadings(n, status)}</span></button>`;
  }
  // Collapse repeated changes of one link or host into a single row with a count.
  function eventGroups(filter = () => true) {
    const groups = new Map();
    for (const e of D.events) {
      if (e.at < state.now - D.hour || !filter(e)) continue;
      const key = e.type + ':' + e.id;
      const group = groups.get(key);
      if (group) group.count++;
      else groups.set(key, { ...e, count: 1 });
    }
    return [...groups.values()].sort((a, b) => b.at - a.at);
  }
  function eventRows(groups) {
    return groups
      .map((g) => {
        const target = g.type === 'link' ? D.linkById[g.id] : D.nodeById[g.id];
        const open = target ? `data-open="${g.type}" data-id="${g.id}"` : 'disabled';
        const count = g.count > 1 ? `<small class="event-count" title="近 1 小时 ${g.count} 次状态变化">${g.count} 次</small>` : '';
        return `<button type="button" class="event-row ${g.tone}" ${open}><span class="event-symbol">${icon(g.icon)}</span><span class="event-title">${g.title}</span><span class="event-state">${g.text}</span>${count}<time>${D.time(g.at)}</time></button>`;
      })
      .join('');
  }
  function drawRail() {
    const routes = $('#rail-routes');
    const key = JSON.stringify([
      state.route,
      D.routes.map((r) => [r.id, r.name, r.entry, r.paths, r.tail, entryReference(r.entry)?.id]),
    ]);
    if (routes.dataset.key !== key) {
      routes.dataset.key = key;
      routes.innerHTML = D.routes.length ? D.routes.map(railRoute).join('') : '<p class="rail-empty">尚未配置线路</p>';
    }
    updateRouteReadings(routes);
    drawRailEvents();
  }
  function drawRailEvents() {
    const box = $('#rail-events');
    const groups = eventGroups();
    const html = groups.length ? eventRows(groups) : '<p class="rail-empty">没有状态变化</p>';
    if (box.dataset.html !== html) {
      box.dataset.html = html;
      box.innerHTML = html;
    }
  }
  function drawMobileRoutes() {
    if (!phone.matches) {
      $('#phone-content').replaceChildren();
      $('#phone-map').replaceChildren();
      return;
    }
    drawPhoneApp();
  }
  function drawTopology() {
    // Reserve vertical space for cards and the lanes crossing each column.
    const slots = new Map();
    for (const slot of [...D.nodes.filter((n) => n.row != null), ...D.links.flatMap((l) => l.via || [])]) {
      slots.set(`${slot.col}:${slot.row}`, slot.col);
    }
    const laneCounts = new Map();
    for (const col of slots.values()) laneCounts.set(col, (laneCounts.get(col) || 0) + 1);
    $('#topology-canvas').style.setProperty(
      '--plot-min',
      `${Math.max(360, 112 + 104 * (Math.max(1, ...laneCounts.values()) - 1))}px`,
    );
    $('#topology-canvas').classList.toggle(
      'with-direct',
      D.links.some((l) => l.direct),
    );
    const connected = connectedIds(D.links);
    const isolated = D.nodes.filter((n) => !connected.has(n.id) && !n.routed);
    $('#isolated-list').innerHTML = isolated.map(railNode).join('');
    $('#isolated-nodes').hidden = !isolated.length;
    drawRail();
    drawMobileRoutes();
    drawMap();
  }
  function drawDetailEvents() {
    const { type, id } = state.detail;
    if (type === 'route') return;
    const groups = eventGroups((e) => {
      if (e.type === type) return e.id === id;
      const l = e.type === 'link' && D.linkById[e.id];
      return type === 'node' && l && (l.from === id || l.to === id);
    });
    const region = $('#detail-events', sheet);
    if (!region) return;
    region.hidden = !groups.length;
    const list = $('.event-list', region);
    const html = eventRows(groups);
    if (list.dataset.html !== html) {
      list.dataset.html = html;
      list.innerHTML = html;
    }
  }
  const detailEvents =
    '<section class="fact-block" id="detail-events" hidden><h3>' +
    icon('activity') +
    '最近事件</h3><div class="event-list"></div></section>';
  function fullscreen(on) {
    state.expanded = on;
    document.body.classList.toggle('map-expanded', on);
    const b = $('#expand-map');
    b.innerHTML = icon(on ? 'collapse' : 'expand');
    b.setAttribute('aria-pressed', String(on));
    b.setAttribute('aria-label', on ? '收起拓扑' : '展开拓扑');
    b.title = b.getAttribute('aria-label');
  }
  const sheet = $('#detail-sheet');
  // Wide screens dock details beside the map; narrower ones keep the modal sheet.
  const dock = matchMedia('(min-width: 1180px)');
  let opener = null;
  function syncDock() {
    const canvas = $('#topology-canvas');
    const docked = sheet.open && !sheet.matches(':modal') && !phone.matches;
    canvas.classList.toggle('detail-open', docked);
    canvas.dataset.detail = docked && state.detail?.type === 'node' && state.nodeWide ? 'wide' : '';
    markSelection();
  }
  // On the phone, details stack: each one opened from another can be stepped back to.
  let phoneTrail = [];
  function openDetail(type, id, trigger, back = false) {
    const alreadyOpen = sheet.open;
    if (!alreadyOpen) opener = trigger;
    if (phone.matches) {
      if (!alreadyOpen) {
        phoneTrail = [];
        history.pushState({ linkscopeDetail: true }, '');
        sheet.style.setProperty('--detail-h', phoneSnaps()[1] + 'px');
        detailFrom = page;
        if (page) showPage(0);
      } else if (!back && state.detail && (state.detail.type !== type || state.detail.id !== id)) phoneTrail.push(state.detail);
    }
    state.detail = { type, id };
    archiveVersion = null;
    versionRows = [];
    versionsKey = '';
    renderDetail();
    const heading = $('.sheet-head [tabindex="-1"]', sheet);
    if (!alreadyOpen) {
      heading.autofocus = true;
      if (dock.matches || phone.matches) sheet.show();
      else sheet.showModal();
    }
    syncDock();
    sheet.scrollTop = 0;
    heading.focus({ preventScroll: true });
    drawPhoneMap();
  }
  function closePhoneDetail() {
    phoneTrail = [];
    if (history.state?.linkscopeDetail) history.back();
    else sheet.close();
  }
  function phoneBack() {
    const previous = phoneTrail.pop();
    if (previous) openDetail(previous.type, previous.id, null, true);
    else closePhoneDetail();
  }
  function stat(label, value, unit = '') {
    return `<div class="detail-stat"><small>${label}</small><b>${value}${unit ? `<em>${unit}</em>` : ''}</b></div>`;
  }
  function line(label, value) {
    return `<div class="data-line"><span>${label}</span><span>${value}</span></div>`;
  }
  // Host tiles show the current reading above a 24-hour sparkline. None of them switches anything.
  const hostMetrics = {
    cpu: ['CPU', '%', 'mint'],
    ram: ['内存', '%', 'blue'],
    disk: ['磁盘', '%', 'violet'],
    up: ['上行', 'Mbps', 'violet'],
    down: ['下行', 'Mbps', 'blue'],
  };
  const sparkSlot = (n, metric) =>
    `<span class="spark" data-draw="spark" data-kind="host" data-id="${n.id}" data-metric="${metric}" aria-hidden="true"></span>`;
  function hostVitals(n, online) {
    const h = n.host;
    if (!h) return '';
    const resources = [
      ['cpu', `${h.cores ?? '—'} 核`],
      ['ram', `${online ? nodeVal(n, 'ramUsed', 1) + ' / ' : ''}${h.memoryGiB ?? '—'} GiB`],
      ['disk', `${online ? nodeVal(n, 'diskUsed', 0) + ' / ' : ''}${h.diskGiB ?? '—'} GiB`],
    ].map(([metric, note]) => {
      const [label, , tone] = hostMetrics[metric];
      return `<div class="vital ${tone}"><small>${label}</small><b>${online ? nodeVal(n, metric) + '<em>%</em>' : '—'}</b>${sparkSlot(n, metric)}<span class="stat-note">${note}</span></div>`;
    });
    const network = [
      ['up', '↑'],
      ['down', '↓'],
    ].map(([metric, arrow]) => {
      const [label, , tone] = hostMetrics[metric];
      const [value, unit] = compactSpeed(n.reading?.[metric]);
      return `<div class="vital vital-speed ${tone}" data-host-metric="${metric}" data-speed="${n.id}"><span class="speed-head"><small><i aria-hidden="true">${arrow}</i>${label}</small><span class="speed-value"><b>${value}</b><em data-unit>${unit}</em></span></span>${sparkSlot(n, metric)}</div>`;
    });
    return `<section class="detail-block"><div class="block-head"><h3>主机</h3><span>近 24 小时</span></div><div class="vitals">${resources.join('')}${network.join('')}</div></section>`;
  }
  function factBlock(title, symbol, contents, className = '') {
    return `<section class="fact-block ${className}"><h3>${icon(symbol)}${title}</h3>${contents}</section>`;
  }
  function nodeFacts(n, adjacent) {
    if (n.kind === 'reference')
      return factBlock(
        '固定入口',
        'globe',
        line('测点', n.name) +
          line('测量方式', '首跳探针反向 ICMP Echo') +
          line('观测首跳', adjacent.map((l) => D.nodeById[l.to].name).join('、') || '暂无'),
      );
    if (n.sourceIp)
      return factBlock(
        '接入信息',
        'globe',
        line('来源 IP', n.sourceIp) +
          line('IP 归属地', n.place) +
          line('运营商', n.provider) +
          line('接入目标', n.entries.map((id) => D.nodeById[id].name).join('、')) +
          line('观测来源', '客户端连接记录') +
          line('最近观测', D.time(n.last, true)) +
          line('记录来源', n.source === 'simulated' ? '本地模拟上报' : '客户端上报'),
      );
    if (n.kind === 'ingress') {
      return factBlock(
        '入口信息',
        'router',
        line('节点类型', '转发入口') +
          line('主机探针', '未部署') +
          line('接入来源', '客户端连接记录') +
          line('分段观测', '见相邻链路的测量来源与方向'),
      );
    }
    if (n.kind && n.kind !== 'agent') {
      const shared = n.kind === 'shared';
      const measured = adjacent.filter((l) => l.mode === (shared ? 'TCP' : 'ICMP') && l.observer !== n.id);
      const observers = [...new Set(measured.map((l) => D.nodeById[l.observer].name))];
      return factBlock(
        '观测信息',
        'globe',
        line('节点类型', shared ? '拼车落地 · 车主提供代理连接' : '自建落地 · 可 Ping') +
          line('主机探针', '未部署') +
          line('测量方式', shared ? 'TCP 延迟与超时率' : 'ICMP 延迟与丢包率') +
          line('测量来源', observers.join('、') || '暂无采样') +
          line('最近测量', D.time(Math.max(0, ...measured.map((l) => l.last || 0)) || null, true)),
      );
    }
    const h = n.host,
      online = D.nodeState(n, state.now) === 'online';
    const system = factBlock(
      '主机配置',
      'chip',
      line('操作系统', h.os ?? '—') +
        line('处理器', h.processor ?? '—') +
        line('计算规格', `${h.cores ?? '—'} 核 · ${h.arch ?? '—'}`) +
        line(online ? '运行时长' : '上次上报时的运行时长', `<span data-uptime="${n.id}"></span>`),
      'host-specs',
    );
    return (
      system +
      factBlock(
        '网络与探针',
        'activity',
        line('网络接口', h.nic ?? '—') +
          line('探针版本', h.version ?? '—') +
          line('数据来源', n.source === 'simulated' ? '本地模拟上报' : '主机探针采集') +
          line('最后心跳', `<span data-heartbeat="${n.id}"></span>`),
      )
    );
  }
  function quotaTexts(n) {
    const usage = n.usedGiB == null && n.kind === 'shared' ? '待录入' : volume(n.usedGiB);
    let remaining = n.remaining == null ? '未知' : volume(n.remaining);
    if (n.quotaGiB == null) remaining = n.unlimited ? '∞ · 按量付费' : '未设置';
    const { short } = quotaGauge(n);
    if (short && !n.unlimited) remaining += ` · ${short}`;
    return { remaining, usage: usage + ' / ' + (n.unlimited ? '不限额' : volume(n.quotaGiB)) };
  }
  function quotaFacts(n) {
    if (n.sourceIp || (!n.unlimited && n.quotaGiB == null && !n.host)) return '';
    const direction = {
      up: '上行', down: '下行', both: '双向', max: '上、下行累计取较大值', single: '单向（车主计量）',
    }[n.direction];
    const texts = quotaTexts(n);
    return factBlock(
      '流量配额',
      'upload',
      line('剩余流量', `<span data-quota-text="remaining" data-node="${n.id}">${texts.remaining}</span>`) +
        line('本期已用 / 额度', `<span data-quota-text="usage" data-node="${n.id}">${texts.usage}</span>`) +
        line('计费方向', direction) +
        (n.resetDay ? line('流量重置', `每月 ${n.resetDay} 日 · UTC`) : ''),
      'quota-facts',
    );
  }
  // Every adjacent link gets a row: its current delay above the last day. The row opens the link.
  function historySeries(l) {
    if (l.referenceId) return { kind: 'reference', id: l.referenceId, mode: 'ICMP' };
    if (!l.mode) return null;
    return l.sourceIp
      ? { kind: 'peer', id: l.id, mode: l.mode }
      : { kind: 'link', id: l.id, version: l.version, mode: l.mode };
  }
  const seriesData = (draw, s, extra = '') =>
    `data-draw="${draw}" data-kind="${s.kind}" data-id="${D.escape(s.id)}" data-mode="${s.mode || ''}"${s.version != null ? ` data-version="${s.version}"` : ''}${s.carrier ? ` data-carrier="${D.escape(s.carrier)}"` : ''}${extra}`;
  const stripSlot = (s, extra = '', cls = '') => `<span class="strip${cls}" role="img" ${seriesData('strip', s, extra)}></span>`;
  const stripAxis = (extra = '') => `<span class="strip-axis" data-draw="axis"${extra} aria-hidden="true"></span>`;
  function historyRow(l, head, value = edgeValue(l)) {
    const s = historySeries(l);
    return `<button type="button" class="history-row ${edgeTone(l)}" ${edgeButton(l)}><span class="row-head">${head}<span class="row-value">${value}</span>${icon('chevron-right')}</span>${s ? stripSlot(s) : '<span class="strip-note">未采集分段延迟</span>'}</button>`;
  }
  function nodeBody(n) {
    const adjacent = inputLinks(n);
    const online = D.nodeState(n, state.now) === 'online';
    const rows = adjacent.map((l) => {
      const inbound = l.to === n.id;
      const other = D.nodeById[inbound ? l.from : l.to];
      return historyRow(l, `<span class="neighbor-dir">${inbound ? '入' : '出'}</span><span class="row-name">${other.name}</span>`);
    });
    const links = rows.length
      ? `<section class="detail-block"><div class="block-head"><h3>相邻链路</h3><span>近 24 小时 · 每格 30 分钟</span></div><div class="history-rows">${rows.join('')}</div>${stripAxis()}</section>`
      : '';
    return `<div class="node-body">
      <div class="node-main">${hostVitals(n, online)}${links}</div>
      <div class="node-facts${n.host ? ' host-facts' : ''}" id="node-facts">${nodeFacts(n, adjacent)}${quotaFacts(n)}${detailEvents}</div>
    </div>`;
  }
  // Latency well above this daily median marks the link degraded, the same rule the history bars use.
  const baselineLine = (l) =>
    l.baseline == null ? '' : line('24 小时中位延迟', `${fmt(l.baseline)} ms${l.elevated ? ' · 当前已抬升' : ''}`);
  // Link and route details keep the day as a strip and the last hour as bars. Neither one switches.
  function historyBlock(s, title = '') {
    const main = ' data-main=""';
    return `<section class="detail-block history-block"><div class="block-head"><h3>${title}近 24 小时</h3><span>每格 30 分钟</span></div>${stripSlot(s, main, ' strip-main')}${stripAxis(main)}<div class="history-figures" ${seriesData('figures', s, main)}></div><div class="block-head"><h3>${title}近 1 小时</h3><span>每根 1 分钟</span></div><div class="hour-bars" ${seriesData('bars', s, main + ' data-span="60"')}></div></section>`;
  }
  function linkBody(l) {
    const series = historySeries(l);
    const history = series ? historyBlock(series) : '<div class="chart-empty">这段连接暂无延迟样本。</div>';
    if (l.referenceId) {
      return (
        `<div class="identity"><h2 id="detail-title">${endpoints(l)}</h2>${pill(l.reading.lossAlert === 'critical' ? 'critical' : l.state)}</div>` +
        history +
        line('测量方向', D.nodeById[l.to].name + ' → ' + D.nodeById[l.from].name) +
        line('反测方式', 'ICMP Echo · 每 30 秒一轮，每轮 3 次') +
        line('丢包率（本轮 / 近 1 分钟）', `${lossOrTimeoutValue(l)} / <span data-ref-loss="${l.id}">${percent(l.reading.loss)}</span>`) +
        baselineLine(l) +
        line('最后测量', `<span data-link-last="${l.id}">${D.time(l.last, true)}</span>`)
      );
    }
    const tone = edgeTone(l),
      tcp = l.mode === 'TCP',
      status = D.linkState(l, state.now);
    const rates =
      stat(latencyLabel(l.mode), l.mode ? edgeValue(l) : '—') +
      stat(tcp ? '超时率' : '丢包率', l.mode ? lossOrTimeoutValue(l) : '—') +
      stat('链路状态', `<span class="detail-status">${pill(status)}</span>`);
    const method = tcp ? 'TCP 端口探测 · 近 1 分钟超时率' : l.mode ? 'ICMP Echo · 本轮丢包率' : '未采集分段延迟';
    const observer = D.nodeById[l.observer];
    const target = D.nodeById[l.observer === l.to ? l.from : l.to];
    const source =
      (l.sourceIp ? '客户端连接记录' : observer ? observer.name + ' 探针' : '无分段观测') +
      ((l.source || observer?.source) === 'simulated' ? ' · 本地模拟上报' : '');
    return `<div class="identity"><span class="node-icon ${tone}">${icon('links')}</span><div><h2 class="link-title" id="detail-title">${endpoints(l)}</h2><small>${l.service} · ${l.name}</small></div>${tcp ? pill(status) : ''}</div>
      <div class="detail-stats">${rates}</div>${l.sourceIp ? '' : '<div id="version-picker"></div>'}${history}
      ${line('正向 / 回程速率', l.rates ? `${flowRates(l)} Mbps` : '未采集')}${line('测量方式', method)}${l.pending && l.needsAddress ? line('任务状态', '待配置对端探测地址') : ''}${line('观测来源', source)}${observer && l.mode ? line('探测方向', `${observer.name} → ${target.name}`) : ''}${baselineLine(l)}${line('最后测量', `<span data-link-last="${l.id}">${D.time(l.last, true)}</span>`)}
      <section class="detail-section"><h3>链路两端</h3>${[l.from, l.to]
        .map((id, i) => {
          const n = D.nodeById[id];
          return `<button class="endpoint" ${nodeButton(n)}>${tileIcon(n)}${n.name}<small>${i === 0 ? '线路上游' : '线路下游'}</small>${icon('chevron-right')}</button>`;
        })
        .join('')}</section>${detailEvents}`;
  }
  function sizeNodeSheet() {
    const node = state.detail?.type === 'node';
    const wide = node && state.nodeWide;
    sheet.classList.toggle('node-sheet', node);
    sheet.classList.toggle('sheet-wide', wide);
    const toggle = $('#sheet-size');
    if (!toggle) return;
    toggle.innerHTML = `${icon(wide ? 'collapse' : 'expand')}<span>${wide ? '收起' : '展开'}</span>`;
    toggle.setAttribute('aria-expanded', String(wide));
    toggle.setAttribute('aria-label', wide ? '收起节点详情' : '展开节点详情');
    syncDock();
  }
  // One bar per route: each hop's share of the summed latency. Each hop is also a row with its own day.
  function routeBreakdown(route) {
    const regional = !!D.nodeById[route.entry]?.references?.length;
    const anchor = regional ? entryReference(route.entry) : null;
    const segments = [];
    if (regional) {
      const referenceLink = linksOfRoute(route).find((l) => l.referenceId);
      segments.push({
        label: anchor ? D.nodeById[route.entry].name + ' → ' + referenceName(anchor) + '（反测）' : '浙江参考点',
        value: anchor ? `<span data-route-anchor="${route.entry}">${referenceDelay(anchor)}</span>` : '待测',
        bar: `data-seg-anchor="${route.entry}"`,
        tone: referenceLink ? edgeTone(referenceLink) : 'neutral',
        link: anchor ? referenceLink : null,
      });
    }
    for (const id of route.tail) {
      const l = D.linkById[id];
      if (l) segments.push({ label: endpoints(l), value: edgeValue(l), bar: `data-seg-link="${l.id}"`, tone: edgeTone(l), link: l });
    }
    if (!segments.length) return '';
    const bar = `<div class="seg-bar" aria-hidden="true">${segments.map((s) => `<i class="${s.tone}" ${s.bar}></i>`).join('')}</div>`;
    const rows = segments
      .map((s) => {
        const head = `<b class="seg-dot"></b><span class="row-name">${s.label}</span>`;
        if (s.link) return historyRow(s.link, head, s.value);
        return `<div class="history-row seg-static ${s.tone}"><span class="row-head">${head}<span class="row-value">${s.value}</span></span></div>`;
      })
      .join('');
    return factBlock(
      '延迟分段',
      'latency',
      bar + `<div class="history-rows">${rows}</div>${stripAxis()}` + line('分段合计', `<span data-seg-total="${route.id}"></span>`),
      'route-breakdown',
    );
  }
  function segmentLatency(el) {
    if (el.dataset.segLink) return D.linkSample(D.linkById[el.dataset.segLink], state.now)?.latency ?? null;
    return entryReference(el.dataset.segAnchor)?.latency ?? null;
  }
  function referencePicker(entry, refs, selected) {
    if (!selected) return '';
    const options = refs.map((r) =>
      `<option value="${D.escape(r.id)}" data-provider="${D.escape(r.provider)}" ${r.id === selected.id ? 'selected' : ''}>${D.escape(referenceName(r))}</option>`,
    );
    return `<label class="version-label reference-picker">地区反测<select data-reference="${D.escape(entry)}">${options.join('')}</select></label>`;
  }
  function archivedRouteBody(route, archived) {
    const ref = entryReference(archived.entry, archived.references);
    const end = ` data-end="${archived.end}"`;
    const rows = archived.segments.map((l) => ({
      label: l.label,
      series: l.mode && l.version != null ? { ...l, kind: 'link' } : null,
    }));
    if (ref) rows.unshift({
      label: archived.entryName + ' → ' + referenceName(ref) + '（反测）',
      series: { kind: 'reference', id: ref.id, mode: 'ICMP' },
    });
    const breakdown = rows.map(({ label, series }) => {
      const version = series?.version == null ? '' : 'v' + series.version;
      return `<div class="history-row seg-static"><span class="row-head"><span class="row-name">${D.escape(label)}</span><span class="row-value">${version}</span></span>${series ? stripSlot(series, end) : '<span class="strip-note">未采集分段延迟</span>'}</div>`;
    }).join('');
    const total = { kind: 'summary', id: route.id, version: archived.version, carrier: ref?.id };
    return `<div class="identity"><span class="node-icon">${icon('routes')}</span><div><h2 id="detail-title">${D.escape(archived.label)}</h2><small>历史 v${archived.version} · 截至 ${reportDate.format(archived.end)} ${D.time(archived.end, true)}</small></div></div>
      <div id="version-picker"></div>${referencePicker(archived.entry, archived.references, ref)}${historyBlock(total, '分段合计 · ')}
      ${breakdown ? factBlock('延迟分段', 'latency', '<div class="history-rows">' + breakdown + '</div>' + stripAxis(end), 'route-breakdown') : ''}`;
  }
  function routeBody(route) {
    const archived = archiveVersion == null ? null : versionRows.find((r) => r.version === archiveVersion);
    if (archived) return archivedRouteBody(route, archived);
    const segments = Math.max(0, ...route.paths.map((path) => path.length));
    const figure = (key, unit) => `<span data-route-figure="${key}" data-route-id="${route.id}" data-unit="${unit}"></span>`;
    const stats =
      stat('分段合计（估算）', figure('delay', 'ms')) +
      stat('已测分段', figure('measured', '')) +
      stat('异常分段', figure('faults', '段'));
    const ref = entryReference(route.entry);
    const carrier = referencePicker(route.entry, D.nodeById[route.entry].references, ref);
    const total = { kind: 'summary', id: route.id, version: route.version, carrier: ref?.id, mode: '' };
    return `<div class="identity"><span class="node-icon ${route.tone}">${icon('routes')}</span><div><h2 id="detail-title">${route.name}</h2><small>${segments ? segments + ' 段' : '直连'} · ${routeMethod(route)}</small></div></div>
      <div class="detail-stats">${stats}</div><div id="version-picker"></div>${carrier}${historyBlock(total, '分段合计 · ')}${routeBreakdown(route)}`;
  }
  function renderDetail() {
    const { type, id } = state.detail,
      node = type === 'node';
    const route = type === 'route' && D.routes.find((r) => r.id === id);
    const body = route
      ? routeBody(route)
      : node
        ? nodeBody(D.nodeById[id])
        : linkBody(D.linkById[id]);
    const expand = node
      ? '<button type="button" id="sheet-size" class="control" aria-controls="sheet-content"></button>'
      : '';
    let heading = `<span class="sheet-kind" tabindex="-1">${icon('links')}${route ? '线路详情' : '链路详情'}</span>`;
    if (node) {
      const n = D.nodeById[id];
      heading = `<div class="identity node-identity">${tileIcon(n)}<div><div class="name-line"><h2 id="detail-title" tabindex="-1">${n.name}</h2>${pill(D.nodeState(n, state.now))}</div><small>${n.sourceIp ? `${n.sourceIp} · ${n.provider}` : `${n.place} · ${n.provider} · ${n.role}`}</small></div></div>`;
    }
    // On the phone the sheet's corner button steps back, to the previous detail or to the map.
    const close = phone.matches
      ? `<button id="sheet-close" type="button" class="icon-button" aria-label="返回" title="返回">${icon('back')}</button>`
      : `<button id="sheet-close" type="button" class="icon-button" aria-label="关闭详情" title="关闭详情">${icon('close')}</button>`;
    $('#sheet-inner').innerHTML = `${phone.matches ? '<div class="sheet-grab" data-grab></div>' : ''}<div class="sheet-head ${node ? 'node-head' : ''}">${heading}
      <div class="head-actions">${expand}${close}</div></div>
      <div class="sheet-body" id="sheet-content">${body}</div>`;
    sizeNodeSheet();
    markSelection();
    loadVersions();
    drawDetailHistory();
    updateReadings(sheet);
    drawDetailEvents();
  }
  let archiveVersion = null,
    versionRows = [],
    versionsKey = '';
  function paintVersionPicker() {
    const box = $('#version-picker', sheet);
    if (!box || !versionRows.length) return;
    const options = versionRows
      .map(
        (r) =>
          `<option value="${r.closed == null ? '' : r.version}">${r.closed == null ? '当前' : '历史'} v${r.version} · ${D.escape(r.label)}</option>`,
      )
      .join('');
    box.innerHTML = `<label class="version-label">测量版本<select id="history-version">${options}</select></label>`;
    $('#history-version', box).value = archiveVersion ?? '';
  }
  function loadVersions() {
    if (!$('#version-picker', sheet)) return;
    const { type, id } = state.detail;
    const key = [type, id, D.frame.revision].join('|');
    if (key === versionsKey) {
      paintVersionPicker();
      return;
    }
    versionsKey = key;
    D.fetchVersions(type, id)
      .then((rows) => {
        if (key !== versionsKey || state.detail?.id !== id || state.detail.type !== type) return;
        versionRows = rows;
        if (archiveVersion != null && !rows.some((r) => r.version === archiveVersion)) {
          archiveVersion = null;
          renderDetail();
          return;
        }
        paintVersionPicker();
      })
      .catch(() => {
        if (versionsKey === key) versionsKey = '';
      });
  }
  // Detail history is fetched per series at most once a minute and painted into every slot that shows it.
  const historyCache = new Map();
  function archivedRow(el) {
    return el.dataset.main != null && archiveVersion != null && versionRows.find((r) => r.version === archiveVersion);
  }
  function seriesSpec(el) {
    const d = el.dataset;
    const archived = archivedRow(el);
    return {
      kind: d.kind,
      id: d.id,
      span: Number(d.span || 1440),
      version: archived ? archiveVersion : d.version == null ? null : Number(d.version),
      carrier: d.carrier || null,
      mode: archived ? archived.mode : d.mode,
      end: archived ? archived.end : d.end == null ? null : Number(d.end),
    };
  }
  const specKey = (s) => [s.kind, s.id, s.span, s.version ?? '', s.carrier ?? '', s.end ?? ''].join('|');
  function historyEntry(s) {
    const key = specKey(s);
    const now = Date.now();
    let entry = historyCache.get(key);
    if (entry) {
      const ttl = entry.failed ? 30_000 : s.end != null ? Infinity : 60_000;
      if (entry.loading || now - entry.at < ttl) return entry;
    }
    entry = { key, at: now, data: entry?.data, loading: true };
    historyCache.set(key, entry);
    const end = s.end ?? state.now;
    const archive = s.end == null ? null : [state.detail.type, state.detail.id, archiveVersion].join('/');
    const request =
      s.kind === 'host'
        ? D.fetchHistory('host', s.id, s.span, end, null, 'averages')
        : D.fetchBars(s.kind, s.id, s.span, end, s.version, s.carrier, archive);
    request
      .then((data) => {
        entry.data = data;
        entry.failed = false;
      })
      .catch(() => {
        entry.failed = true;
        entry.at = Date.now();
      })
      .finally(() => {
        entry.loading = false;
        if (sheet.open) drawDetailHistory();
      });
    if (historyCache.size > 200) {
      for (const [k, v] of historyCache) if (!v.loading && now - v.at > 600_000) historyCache.delete(k);
    }
    return entry;
  }
  function drawDetailHistory() {
    if (!state.detail) return;
    $$('[data-draw]', sheet).forEach((el) => {
      if (el.dataset.draw === 'axis') {
        paintAxis(el);
        return;
      }
      const spec = seriesSpec(el);
      const entry = historyEntry(spec);
      const width = el.clientWidth;
      const shown = el._history;
      if (shown && shown.key === entry.key && shown.data === entry.data && shown.width === width) return;
      if (!entry.data) {
        if (el._history?.key !== entry.key) {
          el.replaceChildren();
          el._history = { key: entry.key };
        }
        if (entry.failed && el.dataset.draw === 'bars') el.textContent = '历史暂时不可用';
        return;
      }
      const paint = { strip: paintStrip, figures: paintFigures, bars: paintHourBars, spark: paintSpark }[el.dataset.draw];
      paint(el, entry.data, spec);
      el._history = { ...el._history, key: entry.key, data: entry.data, width, spec };
    });
  }
  const statusText = { mint: '正常', amber: '抬升或丢包', rose: '严重', gap: '缺测' };
  function paintStrip(el, data) {
    const cells = data.points.map((p, i) => `<i class="${p.status}" data-i="${i}"></i>`).join('');
    el.innerHTML = cells;
    const counts = data.points.reduce((c, p) => ({ ...c, [p.status]: (c[p.status] || 0) + 1 }), {});
    const notes = ['amber', 'rose', 'gap'].filter((k) => counts[k]).map((k) => `${statusText[k]} ${counts[k]} 格`);
    el.setAttribute('aria-label', `近 24 小时${notes.length ? '，' + notes.join('，') : '均正常'}`);
  }
  function lossWord(spec) {
    if (spec.kind === 'summary') return '';
    return spec.mode === 'TCP' ? '超时' : '丢包';
  }
  function paintFigures(el, data, spec) {
    const s = data.stats;
    const loss = lossWord(spec);
    el.innerHTML = [
      ['中位', fmt(s.p50), 'ms'],
      ['P95', fmt(s.p95), 'ms'],
      ['最高', fmt(s.max), 'ms'],
      ...(loss ? [[loss, fmt(s.loss), s.loss == null ? '' : '%', spec.kind !== 'reference' && s.loss > 0]] : []),
    ]
      .map(([label, value, unit, warn]) => `<div${warn ? ' class="warn"' : ''}><small>${label}</small><b>${value}</b>${unit ? `<em>${unit}</em>` : ''}</div>`)
      .join('');
  }
  function niceCeil(v) {
    const e = 10 ** Math.floor(Math.log10(v));
    return [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((m) => m * e >= v) * e;
  }
  const axisValue = (v) => (v < 10 ? Number(v.toFixed(1)) : Math.round(v));
  const zone = 8 * D.hour;
  // The last hour: one bar per minute from zero. Healthy bars stay quiet so problems stand out.
  function paintHourBars(el, data) {
    const points = data.points;
    if (!points.some((p) => p.n)) {
      el.textContent = '近 1 小时暂无采样';
      el._bars = null;
      return;
    }
    const w = el.clientWidth || 360,
      h = 150,
      l = 30,
      r = w - 6,
      t = 8,
      b = h - 22;
    const duration = data.end - data.start;
    const top = niceCeil(Math.max(1, ...points.map((p) => p.p50 ?? 0)) * 1.1);
    const pitch = (r - l) / points.length;
    const width = Math.max(1.5, Math.min(pitch - 1.5, Math.max(3, Math.min(6, (r - l) / 85))));
    const y = (v) => b - ((b - t) * v) / top;
    const marks = points.map((p, i) => {
      const left = l + i * pitch + (pitch - width) / 2;
      if (p.status === 'gap') return `<rect class="bar gap" data-i="${i}" x="${left}" y="${b - 3}" width="${width}" height="3" rx="1.5"/>`;
      const height = p.p50 == null ? 6 : Math.max(2, b - y(p.p50));
      const peak = b - height,
        round = Math.min(width / 2, 3, height);
      return `<path class="bar ${p.status}" data-i="${i}" d="M${left},${b}V${peak + round}Q${left},${peak} ${left + round},${peak}H${left + width - round}Q${left + width},${peak} ${left + width},${peak + round}V${b}Z"/>`;
    });
    const grid = [0, 0.5, 1]
      .map((k) => {
        const yy = b - (b - t) * k;
        return `<path d="M${l} ${yy}H${r}" stroke="var(--chart-grid)"${k ? ' stroke-dasharray="3 4"' : ''}/><text x="${l - 5}" y="${yy + 3}" text-anchor="end">${axisValue(top * k)}</text>`;
      })
      .join('');
    const step = 15 * 60_000,
      ticks = [];
    for (let at = Math.ceil((data.start + zone) / step) * step - zone; at <= data.end; at += step) {
      const x = l + ((r - l) * (at - data.start)) / duration;
      if (x >= l + 14 && x <= r - 14) ticks.push(`<text x="${x.toFixed(1)}" y="${h - 5}" text-anchor="middle">${D.time(at)}</text>`);
    }
    el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="近 1 小时延迟，中位 ${fmt(data.stats.p50)} ms，最高 ${fmt(data.stats.max)} ms">${grid}${ticks.join('')}${marks.join('')}</svg>`;
    el._bars = { l, pitch };
  }
  // Half-hour averages, the same cells as the link strips. Percentages keep their full scale.
  function paintSpark(el, data) {
    const metric = el.dataset.metric;
    const [, unit] = hostMetrics[metric];
    const start = data.start, span = data.end - start, size = data.step;
    const points = data.points.map((p) => ({ t: p.t, v: p.v?.[metric] ?? null }));
    const values = points.map((p) => p.v).filter((v) => v != null);
    if (!values.length) {
      el.replaceChildren();
      el._spark = null;
      return;
    }
    const top = unit === '%' ? Math.max(100, ...values) : Math.max(1, ...values) * 1.15;
    const segments = [];
    let current = [];
    for (const p of points) {
      if (p.v == null) {
        if (current.length) segments.push(current);
        current = [];
      } else current.push([((p.t - start) / span) * 100, 23 - (p.v / top) * 21]);
    }
    if (current.length) segments.push(current);
    const paths = segments
      .map((seg) => {
        const d = seg.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
        return `<path class="spark-area" d="${d} L${seg.at(-1)[0].toFixed(2)},24 L${seg[0][0].toFixed(2)},24 Z"/><path class="spark-line" d="${d}"/>`;
      })
      .join('');
    el.innerHTML = `<svg viewBox="0 0 100 24" preserveAspectRatio="none">${paths}</svg>`;
    el._spark = { points, start, span, size };
  }
  function paintAxis(el) {
    const archived = archivedRow(el);
    const fixedEnd = archived ? archived.end : el.dataset.end;
    const end = fixedEnd == null ? state.now : Number(fixedEnd),
      start = end - 24 * D.hour,
      step = 6 * D.hour,
      labels = [];
    for (let at = Math.ceil((start + zone) / step) * step - zone; at <= end; at += step) {
      const k = (at - start) / (end - start);
      if (k > 0.06 && k < 0.86) labels.push(`<span style="left:${(k * 100).toFixed(2)}%">${D.time(at)}</span>`);
    }
    labels.push(`<span class="axis-end">${fixedEnd == null ? '现在' : D.time(end)}</span>`);
    const html = labels.join('');
    if (el.dataset.html !== html) {
      el.dataset.html = html;
      el.innerHTML = html;
    }
  }
  function bucketText(p, step, spec) {
    const when = `${D.time(p.t - step / 2)}–${D.time(p.t + step / 2)}`;
    if (p.status === 'gap') return `${when}\n${p.segmentStatus === 'gap' ? '分段缺测' : p.n ? '待测' : '缺测'}`;
    const loss = lossWord(spec);
    if (p.p50 == null) return `${when}\n${spec.kind === 'summary' ? '分段异常，合计待测' : loss === '超时' ? '未连通' : '无回包'}`;
    const notes = [p.n > 1 ? `中位 ${fmt(p.p50)} · 最高 ${fmt(p.max)} ms` : `${fmt(p.p50)} ms`];
    if (loss && p.loss > 0) notes.push(`${loss} ${percent(p.loss)}`);
    if (p.fails && loss === '超时') notes.push(`失败 ${p.fails} 次`);
    if (p.high) notes.push('延迟抬升');
    if (p.segmentStatus) notes.push(p.segmentStatus === 'gap' ? '分段缺测' : '分段异常');
    return `${when}\n${notes.join(' · ')}`;
  }
  const detailTip = document.createElement('span');
  detailTip.className = 'detail-tip';
  detailTip.hidden = true;
  function clearInspect() {
    detailTip.hidden = true;
    $$('.inspecting', sheet).forEach((el) => el.classList.remove('inspecting'));
    $$('[data-draw] .on', sheet).forEach((el) => el.classList.remove('on'));
  }
  function inspectHistory(el, clientX) {
    const h = el._history;
    if (!h?.data) return clearInspect();
    const r = el.getBoundingClientRect();
    const x = clientX - r.left;
    let index, text, px;
    if (el.dataset.draw === 'spark') {
      const { points, start, span, size } = el._spark || {};
      if (!points) return clearInspect();
      index = Math.max(0, Math.min(points.length - 1, Math.floor((x / r.width) * points.length)));
      const p = points[index];
      const [label, unit] = hostMetrics[el.dataset.metric];
      text = `${label} ${D.time(p.t - size / 2)}–${D.time(p.t + size / 2)}\n${p.v == null ? '无采样' : '平均 ' + fmt(p.v) + ' ' + unit}`;
      px = ((p.t - start) / span) * r.width;
    } else {
      const { points, step } = h.data;
      if (el.dataset.draw === 'bars') {
        const { l, pitch } = el._bars || {};
        if (!pitch) return clearInspect();
        index = Math.floor((x - l) / pitch);
        px = l + (Math.max(0, Math.min(points.length - 1, index)) + 0.5) * pitch;
      } else {
        index = Math.floor((x / r.width) * points.length);
        px = ((Math.max(0, Math.min(points.length - 1, index)) + 0.5) / points.length) * r.width;
      }
      index = Math.max(0, Math.min(points.length - 1, index));
      text = bucketText(points[index], step, h.spec);
      $$('[data-i]', el).forEach((mark) => mark.classList.toggle('on', Number(mark.dataset.i) === index));
    }
    el.classList.add('inspecting');
    if (detailTip.parentElement !== el) el.append(detailTip);
    detailTip.textContent = text;
    detailTip.hidden = false;
    detailTip.style.left = Math.max(0, Math.min(r.width - detailTip.offsetWidth, px - detailTip.offsetWidth / 2)) + 'px';
  }
  const reportDate = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
  });
  function updateReadings(root = document) {
    $$('[data-eval]', root).forEach((el) => {
      const v = D.linkSample(D.linkById[el.dataset.eval], state.now)[el.dataset.metric];
      el.textContent = formatLinkValue(v, el.dataset.metric);
    });
    $$('[data-ref-delay]', root).forEach((el) => {
      el.textContent = referenceDelay(D.linkById[el.dataset.refDelay].reading);
    });
    $$('[data-route-anchor]', root).forEach((el) => {
      const r = entryReference(el.dataset.routeAnchor);
      el.textContent = r ? referenceDelay(r) : '待测';
    });
    $$('[data-ref-loss]', root).forEach((el) => {
      el.textContent = percent(D.linkById[el.dataset.refLoss].reading.loss);
    });
    $$('[data-icmp-loss]', root).forEach((el) => {
      el.textContent = percent(D.linkById[el.dataset.icmpLoss].reading.packetLoss);
    });
    $$('[data-link-last]', root).forEach((el) => {
      el.textContent = D.time(D.linkById[el.dataset.linkLast].last, true);
    });
    $$('[data-nval]', root).forEach((el) => {
      el.textContent = fmt(
        D.nodeValue(D.nodeById[el.dataset.nval], el.dataset.metric, state.now),
        Number(el.dataset.precision),
      );
    });
    $$('[data-source-up]', root).forEach((el) => {
      const route = el.dataset.route;
      el.textContent = fmt(
        D.sourceTraffic(D.nodeById[el.dataset.sourceUp], state.now, route).upload,
        route ? 1 : 0,
      );
    });
    $$('[data-quota]', root).forEach((el) => {
      const { level, label } = quotaGauge(D.nodeById[el.dataset.quota]);
      el.toggleAttribute('data-unknown', level == null);
      el.style.setProperty('--quota-level', level ?? 0);
      el.title = label;
      el.setAttribute('aria-label', label);
    });
    $$('[data-quota-pct]', root).forEach((el) => {
      const { short, low } = quotaGauge(D.nodeById[el.dataset.quotaPct]);
      if (el.textContent !== short) el.textContent = short;
      el.classList.toggle('low', !!low);
    });
    $$('[data-quota-text]', root).forEach((el) => {
      const text = quotaTexts(D.nodeById[el.dataset.node])[el.dataset.quotaText];
      if (el.textContent !== text) el.textContent = text;
    });
    $$('.seg-bar', root).forEach((bar) => {
      const parts = $$('i', bar);
      const values = parts.map(segmentLatency);
      parts.forEach((el, i) => {
        el.style.flexGrow = values[i] ?? 0;
        el.classList.toggle('pending', values[i] == null);
      });
      const total = $('[data-seg-total]', bar.parentElement);
      if (total) total.textContent = values.every((v) => v != null) ? fmt(values.reduce((a, b) => a + b, 0)) + ' ms' : '待测';
    });
    updateRouteReadings(root);
    $$('[data-speed]', root).forEach((el) => {
      const [v, u] = compactSpeed(D.nodeById[el.dataset.speed].reading?.[el.dataset.hostMetric || 'up']);
      $('b', el).textContent = v;
      $('[data-unit]', el).textContent = u;
    });
    if (root === sheet && state.detail?.type === 'node') {
      const n = D.nodeById[state.detail.id];
      if (n.host) {
        const last = D.lastReport(n, state.now);
        const hours = last && n.host.boot ? Math.floor((last - n.host.boot) / D.hour) : null;
        $('[data-uptime]', sheet).textContent =
          hours == null ? '—' : `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
        $('[data-heartbeat]', sheet).textContent =
          last == null ? '待上报' : `${reportDate.format(last)} ${D.time(last, true)} UTC+8`;
      }
    }
    $$('[data-sample-time]', root).forEach((el) => {
      el.textContent = D.time(state.now, true) + ' UTC+8';
    });
  }
  function mapShape(frame) {
    return JSON.stringify([
      frame.revision,
      frame.nodes.map((n) => [n.id, n.state, n.row, n.place, n.provider]),
      frame.links.map((l) => [
        l.id,
        l.mode,
        l.state,
        l.rates,
        Object.entries(l.traffic || {}).map(([key, v]) => [key, v?.forward != null]),
        l.referenceId,
        delayStatus(l),
        l.reading.packetLoss == null,
        l.reading.failureRate == null,
        edgeTone(l),
        !!mapLossBadge(l),
      ]),
    ]);
  }
  let fetching = false;
  let generation = 0;
  function showDisconnected() {
    $('#topology').dataset.disconnected = 'true';
    $('#live-label').textContent = state.playing ? '等待重连' : '已暂停';
    $('#data-status').textContent = D.frame.now
      ? '已断开 · 上次更新 ' + D.time(D.frame.now, true)
      : '暂时无法连接';
    $('#data-status').dataset.level = 'warn';
    fitHead();
    updatePhoneOverview();
  }
  async function refresh() {
    if (!state.playing || fetching) return;
    fetching = true;
    const version = generation;
    try {
      const frame = await D.fetchState(phone.matches ? null : state.route);
      if (version !== generation || !state.playing) return;
      const priorDetail = detailShape();
      const changed = mapShape(frame) !== mapShape(D.frame);
      const revised = frame.revision !== D.frame.revision;
      D.apply(frame);
      state.now = frame.now;
      window.LinkscopePWA?.remember(frame);
      delete $('#topology').dataset.disconnected;
      $('#live-label').textContent = '实时刷新';
      document.querySelectorAll('[data-admin]').forEach((el) => {
        el.hidden = frame.accessRole === 'viewer';
      });
      $('#sign-out').hidden = !frame.signedIn;
      $('#phone-sign-out').hidden = !frame.signedIn;
      $$('[data-admin-link]').forEach((link) => {
        link.href = frame.accessRole === 'viewer' ? '/login?next=admin' : '/admin';
      });
      $('#clock').textContent = D.time(frame.now, true);
      const stale = frame.lastReport == null || frame.now - frame.lastReport > 15000;
      $('#data-status').textContent =
        frame.lastReport == null
          ? '等待探针上报'
          : stale
            ? '上报已中断'
            : frame.nodes.some((n) => n.source === 'simulated' && ['online', 'connected'].includes(n.state))
              ? '含本地模拟上报'
              : '探针已连接';
      $('#data-status').dataset.level = stale ? 'warn' : '';
      if (revised && state.route !== 'all' && !D.routes.some((r) => r.id === state.route)) state.route = 'all';
      if (changed) drawTopology();
      else {
        $$('.edge-group').forEach((el) =>
          el.style.setProperty('--flow-width', flowWidth(D.linkById[el.dataset.edge || el.dataset.id])),
        );
        drawRail();
        updateReadings($('#map-stage'));
        updateReadings($('#isolated-list'));
        updateReadings($('#phone-content'));
        updateReadings($('#phone-map'));
      }
      $('#empty-map').hidden = !!frame.nodes.length;
      drawMetrics();
      syncDetail(priorDetail);
    } catch {
      if (version === generation) showDisconnected();
    } finally {
      fetching = false;
      if (state.playing && version !== generation) refresh();
    }
  }
  function toggleLive() {
    state.playing = !state.playing;
    generation++;
    const b = $('#live-toggle'),
      map = $('#map-lines');
    b.setAttribute('aria-pressed', String(state.playing));
    b.title = state.playing ? '暂停面板刷新' : '继续面板刷新';
    $('#live-label').textContent = state.playing ? '实时刷新' : '已暂停';
    $('.playback-icon', b).innerHTML = icon(state.playing ? 'pause' : 'play');
    fitHead();
    if (state.playing) {
      map.unpauseAnimations?.();
      refresh();
    } else {
      map.pauseAnimations?.();
    }
  }
  document.addEventListener('click', (e) => {
    const target = e.target.closest(
      '[data-open],[data-select-route],[data-carrier-link],#sheet-close,#sheet-size',
    );
    if (!target) return;
    const data = target.dataset;
    if (data.open) {
      openDetail(data.open, data.id, target);
      return;
    }
    if (target.id === 'sheet-close') {
      if (phone.matches) phoneBack();
      else sheet.close();
      return;
    }
    if (target.id === 'sheet-size') {
      state.nodeWide = !state.nodeWide;
      sizeNodeSheet();
      drawDetailHistory();
      return;
    }
    if (data.selectRoute) {
      const id = data.selectRoute;
      const deselect = id === state.route;
      dismissedPreview = deselect ? id : null;
      selectRoute(deselect ? 'all' : id);
      $(`[data-select-route="${id}"]`, $('#rail-routes'))?.focus({ preventScroll: true, focusVisible: false });
      return;
    }
    if (data.carrierLink) {
      setCarrier(data.carrierLink);
      return;
    }
  });
  sheet.addEventListener('change', (e) => {
    if (e.target.id === 'history-version') {
      archiveVersion = e.target.value === '' ? null : Number(e.target.value);
      const top = sheet.scrollTop;
      renderDetail();
      sheet.scrollTop = top;
      $('#history-version', sheet)?.focus({ preventScroll: true });
      return;
    }
    if (e.target.matches('[data-reference]')) {
      const entry = e.target.dataset.reference;
      const provider = e.target.selectedOptions[0].dataset.provider;
      sessionStorage.setItem('linkscope-carrier-choice-' + entry, provider);
      drawMetrics();
      const top = sheet.scrollTop;
      drawTopology();
      renderDetail();
      sheet.scrollTop = top;
      $('[data-reference]', sheet)?.focus({ preventScroll: true });
      return;
    }
  });
  new ResizeObserver(() => {
    if (sheet.open) drawDetailHistory();
  }).observe(sheet);
  sheet.addEventListener('click', (e) => {
    if (e.target !== sheet) return;
    const r = sheet.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) sheet.close();
  });
  sheet.addEventListener('close', () => {
    state.detail = null;
    phoneTrail = [];
    clearInspect();
    syncDock();
    drawPhoneMap();
    if (detailFrom && phone.matches) showPage(1);
    detailFrom = 0;
    if (opener?.isConnected) opener.focus?.({ preventScroll: true });
    opener = null;
  });
  sheet.addEventListener('pointermove', (e) => {
    const el = e.target.closest('[data-draw="strip"], [data-draw="bars"], [data-draw="spark"]');
    if (el) inspectHistory(el, e.clientX);
    else if (!detailTip.hidden) clearInspect();
  });
  sheet.addEventListener('pointerout', (e) => {
    const el = e.target.closest('[data-draw]');
    if (el && !el.contains(e.relatedTarget)) clearInspect();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sheet.open && !sheet.matches(':modal')) {
      if (phone.matches) closePhoneDetail();
      else sheet.close();
    } else if (e.key === 'Escape' && state.expanded && !sheet.open) {
      fullscreen(false);
      $('#expand-map').focus();
    }
  });
  function detailShape() {
    if (!state.detail) return '';
    const { type, id } = state.detail;
    if (type === 'route') {
      const r = D.routes.find((r) => r.id === id);
      return (
        r &&
        JSON.stringify([
          D.frame.revision,
          r.version,
          entryReference(r.entry)?.id,
          linksOfRoute(r).map((l) => [l.id, l.state, edgeTone(l), delayStatus(l)]),
        ])
      );
    }
    if (type === 'link') {
      const l = D.linkById[id];
      return l && JSON.stringify([D.frame.revision, l.state, l.rates, delayStatus(l), l.pending, l.referenceId, l.reading.lossAlert]);
    }
    const n = D.nodeById[id];
    return (
      n &&
      JSON.stringify([
        n.state,
        n.last != null,
        n.source,
        n.host?.boot,
        inputLinks(n).map((l) => [l.id, l.state, l.mode, l.referenceId, l.reading.lossAlert, delayStatus(l)]),
        D.frame.revision,
      ])
    );
  }
  function syncDetail(previous) {
    if (!sheet.open || !state.detail) return;
    const { type, id } = state.detail;
    const item =
      type === 'route' ? D.routes.find((r) => r.id === id) : type === 'node' ? D.nodeById[id] : D.linkById[id];
    if (!item) {
      sheet.close();
      return;
    }
    if (previous !== detailShape()) {
      const scroll = $('#sheet-content').scrollTop;
      renderDetail();
      $('#sheet-content').scrollTop = scroll;
    } else {
      updateReadings(sheet);
      drawDetailHistory();
      drawDetailEvents();
    }
  }
  async function selectRoute(scope) {
    const version = ++generation;
    state.route = scope;
    drawTopology();
    drawMetrics();
    if (state.playing) {
      refresh();
    } else if (!D.frame.trends[scope]) {
      try {
        const trend = await D.fetchHistory('summary', scope, 60, state.now, selectedRoute()?.version, 'trend');
        if (version !== generation) return;
        D.frame.trends[scope] = trend;
        drawMetrics();
      } catch {
        if (version === generation) $('#data-status').textContent = '趋势暂时无法加载';
      }
    }
  }
  function setCarrier(linkId) {
    const l = D.linkById[linkId];
    if (!l) return;
    sessionStorage.setItem('linkscope-carrier-choice-' + l.to, D.nodeById[l.from].provider);
    drawTopology();
    drawMetrics();
    if (sheet.open) renderDetail();
    $(`#topology [data-carrier-link="${l.id}"]`)?.focus({ preventScroll: true });
  }
  $('#map-stage').addEventListener('click', (e) => {
    if (e.target.closest('[data-open], [data-edge]')) return;
    if (sheet.open) sheet.close();
    if (state.route !== 'all') selectRoute('all');
  });
  // A deselected row only previews again after the pointer leaves it.
  $('#rail-routes').addEventListener('pointerover', (e) => {
    const b = e.target.closest('[data-select-route]');
    if (b && b.dataset.selectRoute !== dismissedPreview) {
      dismissedPreview = null;
      highlightRoute(b.dataset.selectRoute);
    }
  });
  $('#rail-routes').addEventListener('pointerleave', () => {
    dismissedPreview = null;
    highlightRoute();
  });
  // The carrier pill switches carriers; a tap on empty map closes an open detail.
  $('#phone-map').addEventListener('click', (e) => {
    if (e.target.closest('[data-phone-carrier]')) {
      const { providers, chosen } = phoneCarriers();
      if (providers.length > 1) setPhoneCarrier(providers[(providers.indexOf(chosen) + 1) % providers.length]);
    } else if (!e.target.closest('[data-open]') && sheet.open) closePhoneDetail();
  });
  // A detail opened on the phone adds one history entry, so the back gesture closes it; on the overview the back
  // gesture returns to the map.
  window.addEventListener('popstate', () => {
    if (!phone.matches) return;
    if (sheet.open) {
      phoneTrail = [];
      sheet.close();
    } else showPage(history.state?.linkscopePage ? 1 : 0);
  });
  dragSheet(sheet, '--detail-h');
  $('#phone-next').addEventListener('click', () => !sheet.open && turnPage(1));
  $('#phone-prev').addEventListener('click', () => turnPage(0));
  pager.addEventListener('touchstart', (e) => (e.touches.length === 1 ? swipeStart(e.touches[0].clientX, e.touches[0].clientY) : swipeCancel()), { passive: true });
  pager.addEventListener(
    'touchmove',
    (e) => {
      if (!swipe) return;
      if (e.touches.length !== 1) return swipeCancel();
      const { clientX: x, clientY: y } = e.touches[0];
      // At the overview's top a pull down is held back from the browser until it is recognised as a swipe.
      const pulling = swipe.mine == null && swipe.from === 1 && swipe.top && y > swipe.y;
      if ((swipeMove(x, y) || pulling) && e.cancelable) e.preventDefault();
    },
    { passive: false },
  );
  pager.addEventListener('touchend', (e) => !e.touches.length && swipeEnd());
  pager.addEventListener('touchcancel', swipeCancel);
  pager.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    swipeStart(e.clientX, e.clientY);
    if (swipe) swipe.pointer = e.pointerId;
  });
  pager.addEventListener('pointermove', (e) => {
    if (swipe?.pointer === e.pointerId && swipeMove(e.clientX, e.clientY) && !pager.hasPointerCapture(e.pointerId)) pager.setPointerCapture(e.pointerId);
  });
  pager.addEventListener('pointerup', (e) => swipe?.pointer === e.pointerId && swipeEnd());
  pager.addEventListener('pointercancel', (e) => swipe?.pointer === e.pointerId && swipeCancel());
  // A swipe that starts on a station or a row does not also open it.
  pager.addEventListener(
    'click',
    (e) => {
      if (performance.now() - swipedAt > 350) return;
      e.stopPropagation();
      e.preventDefault();
    },
    true,
  );
  // The wheel turns the page too: down on the map, up at the overview's top. One wheel gesture turns one page.
  let wheelAt = -Infinity,
    wheelHeld = -Infinity,
    wheelFromTop = false;
  pager.addEventListener(
    'wheel',
    (e) => {
      if (!phone.matches || sheet.open || e.ctrlKey || !e.deltaY) return;
      const now = performance.now();
      if (now - wheelAt > 250) wheelFromTop = overview.scrollTop <= 0;
      wheelAt = now;
      if (now < wheelHeld) {
        wheelHeld = Math.max(wheelHeld, now + 150);
        e.preventDefault();
      } else if (page === 0 ? e.deltaY > 0 : wheelFromTop && e.deltaY < 0) {
        wheelHeld = now + 500;
        e.preventDefault();
        turnPage(1 - page);
      }
    },
    { passive: false },
  );
  // Zoomed in, one finger pans the page as usual.
  window.visualViewport?.addEventListener('resize', () => pager.classList.toggle('is-zoomed', zoomed()));
  phone.addEventListener('change', () => {
    if (!phone.matches && $('#phone-menu').open) $('#phone-menu').close();
    // The phone shows details as a sheet over the map and the desktop as a dialog, so neither carries over.
    if (sheet.open) sheet.close();
    showPage(0);
    drawMobileRoutes();
    drawMetrics();
  });
  // Switching between docked and modal details needs a fresh open.
  dock.addEventListener('change', () => {
    if (sheet.open) sheet.close();
  });
  window.addEventListener('offline', showDisconnected);
  window.addEventListener('online', refresh);
  $('#expand-map').addEventListener('click', () => fullscreen(!state.expanded));
  $('#live-toggle').addEventListener('click', toggleLive);
  fillIcons();
  showPage(phone.matches && history.state?.linkscopePage ? 1 : 0);
  drawTopology();
  $('#clock').textContent = D.time(state.now, true);
  drawMetrics();
  new ResizeObserver(drawMap).observe($('#map-stage'));
  new ResizeObserver(() => {
    const box = $('#phone-map');
    if (box && Number(box.dataset.width) !== box.clientWidth) drawPhoneMap();
  }).observe($('#mobile-routes'));
  // Fitting changes only the header's height, so a width change is the signal to fit again.
  let headWidth = 0;
  new ResizeObserver(() => {
    if (head.clientWidth === headWidth) return;
    headWidth = head.clientWidth;
    fitHead();
  }).observe(head);
  document.fonts?.ready.then(fitHead);
  refresh();
  setInterval(refresh, 5000);
})();
