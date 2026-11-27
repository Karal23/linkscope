'use strict';

(() => {
  const { icon, fillIcons, tileIcon, country, regionNames } = window.LinkscopeGlyphs;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = (s) =>
    String(s ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  const groups = { nodes: '节点', links: '链路', routes: '线路' };
  const prefixes = { nodes: 'node', links: 'link', routes: 'route' };
  const colors = [
    ['mint', '绿色'],
    ['blue', '蓝色'],
    ['violet', '紫色'],
    ['rose', '玫红'],
    ['neutral', '灰色'],
  ];
  const kinds = [
    ['agent', '主机探针', '运行探针，上报主机状态，并测量到相邻节点的分段。'],
    ['ping', '自建 Ping', '没有探针的服务器，由相邻的主机探针 Ping 测量。'],
    ['shared', '拼车落地', '只提供代理地址的落地，由相邻的主机探针测 TCP 建连，流量按车主数据填写。'],
    ['ingress', '无探针入口', '没有探针的入口，通常作为线路起点，由相邻的主机探针测量。'],
  ];
  const nodeStates = { online: '在线', offline: '离线', waiting: '待上报', ingress: '无探针', ping: 'Ping', shared: '拼车' };
  const linkStates = { normal: '正常', degraded: '质量异常', critical: '严重' };
  const phone = matchMedia('(max-width: 760px)');
  const editor = $('#editor');
  let config,
    live = null,
    access = 'local',
    group = 'nodes',
    selected = null,
    draft = null,
    returnTo = null,
    notice = null,
    errors = {},
    dirty = false,
    saving = false,
    resetUsage = false,
    bindProxy = false,
    idTouched = false,
    modeTouched = false;

  const nodeById = (id) => config.nodes.find((n) => n.id === id);
  const linkById = (id) => config.links.find((l) => l.id === id);
  const nodeName = (id) => nodeById(id)?.name || id;
  const liveNode = (id) => live?.nodes.find((n) => n.id === id);
  const liveLink = (id) => live?.links.find((l) => l.id === id);
  const targetOf = (l) => (l.observer === l.to ? l.from : l.to);
  const routesUsing = (id) => config.routes.filter((r) => r.tail.includes(id));
  const label = ([state, text]) => `<span class="state-label ${state}">${esc(text)}</span>`;
  const chip = (g, row) => `<button type="button" class="link-chip" data-open="${g}:${esc(row.id)}">${esc(row.name)}</button>`;

  function nodeStatus(n) {
    const state = liveNode(n.id)?.state || (n.kind === 'agent' ? 'waiting' : n.kind);
    return [state, nodeStates[state] || state];
  }
  function missingTarget(l, target = nodeById(targetOf(l))) {
    if (!l.mode || nodeById(l.observer)?.source !== 'system') return '';
    if (!target?.address) return '缺地址';
    return l.mode === 'TCP' && !target.port ? '缺端口' : '';
  }
  function linkStatus(l) {
    if (!l.mode) return ['unmeasured', '未测'];
    const missing = missingTarget(l);
    if (missing) return ['degraded', missing];
    const s = liveLink(l.id);
    if (!s || s.pending) return ['pending', '待测'];
    if (s.state === 'unmeasured')
      return l.standalone || routesUsing(l.id).length ? ['pending', '无读数'] : ['unmeasured', '未启用'];
    return [s.state, linkStates[s.state] || '待测'];
  }
  function routeStatus(r) {
    if (!r.tail.length) return ['ingress', '直连'];
    const states = r.tail.map(linkById).filter(Boolean).map(linkStatus);
    const missing = states.find(([, text]) => text === '缺地址' || text === '缺端口');
    if (missing) return missing;
    const unmeasured = states.filter(([s]) => s === 'unmeasured').length;
    if (unmeasured) return ['unmeasured', `${unmeasured} 段未测`];
    for (const s of ['critical', 'degraded', 'pending']) {
      const hit = states.find(([state]) => state === s);
      if (hit) return hit;
    }
    return ['normal', '正常'];
  }
  const statusOf = (g, row) => (g === 'nodes' ? nodeStatus : g === 'links' ? linkStatus : routeStatus)(row);
  const pathNames = (r) => [r.entry, ...r.tail.map((id) => linkById(id)?.to)].map(nodeName);
  function ago(at) {
    const s = Math.max(0, Math.round(((live?.now ?? Date.now()) - at) / 1000));
    if (s < 60) return `${s} 秒前`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m} 分钟前`;
    const h = Math.round(m / 60);
    return h < 48 ? `${h} 小时前` : `${Math.round(h / 24)} 天前`;
  }
  function regionName(code) {
    try {
      return regionNames.of(code);
    } catch {
      return code;
    }
  }

  // Form widgets. Every control is keyed by the draft field it edits.
  const grid = (...fields) => `<div class="field-grid">${fields.join('')}</div>`;
  const section = (title, body) => `<section class="form-section"><h3>${title}</h3><div class="section-body">${body}</div></section>`;
  const errorLine = (key) => `<p class="error" id="e-${key}">${esc(errors[key] || '')}</p>`;
  function wrap(key, text, widget, o = {}) {
    return `<div class="field${o.span ? ' span' : ''}${errors[key] ? ' invalid' : ''}" data-field="${key}">
      <label for="f-${key}">${text}</label>${o.adorn ? `<div class="adorned">${o.adorn}${widget}</div>` : widget}
      ${o.hint != null ? `<p class="hint" id="h-${key}">${o.hint}</p>` : ''}${errorLine(key)}</div>`;
  }
  function input(key, text, o = {}) {
    const value = o.value !== undefined ? o.value : draft[key];
    const attrs = [
      `id="f-${key}" name="${key}" autocomplete="off" spellcheck="false"`,
      o.number
        ? `type="number" inputmode="${o.int ? 'numeric' : 'decimal'}" min="${o.min ?? 0}" max="${o.max ?? 100000000}" step="${o.int ? 1 : 'any'}"`
        : 'type="text"',
      o.maxLength ? `maxlength="${o.maxLength}"` : '',
      o.placeholder ? `placeholder="${esc(o.placeholder)}"` : '',
      o.mono ? 'class="mono"' : '',
    ];
    return wrap(key, text, `<input ${attrs.join(' ')} value="${esc(value ?? '')}">`, o);
  }
  function select(key, text, choices, o = {}) {
    const value = String(draft[key] ?? '');
    const opts = choices
      .map(([v, t]) => `<option value="${esc(v)}"${String(v) === value ? ' selected' : ''}>${esc(t)}</option>`)
      .join('');
    return wrap(key, text, `<select id="f-${key}" name="${key}">${opts}</select>`, o);
  }
  function segmented(key, text, choices, o = {}) {
    const value = draft[key] ?? null;
    const buttons = choices
      .map(
        ([v, t, extra = {}]) =>
          `<button type="button" role="radio" aria-checked="${v === value}" data-set="${key}" data-value="${esc(JSON.stringify(v))}"${extra.disabled ? ' disabled' : ''}${extra.title ? ` title="${esc(extra.title)}"` : ''}>${t}</button>`,
      )
      .join('');
    return `<div class="field${o.span ? ' span' : ''}${errors[key] ? ' invalid' : ''}" data-field="${key}">
      <span class="label" id="l-${key}">${text}</span>
      <div class="segmented" role="radiogroup" aria-labelledby="l-${key}">${buttons}</div>
      ${o.hint ? `<p class="hint">${o.hint}</p>` : ''}${errorLine(key)}</div>`;
  }
  function swatches(key, text) {
    const buttons = colors
      .map(
        ([v, name]) =>
          `<button type="button" role="radio" class="swatch ${v}" aria-checked="${draft[key] === v}" aria-label="${name}" title="${name}" data-set="${key}" data-value="${esc(JSON.stringify(v))}"></button>`,
      )
      .join('');
    return `<div class="field" data-field="${key}"><span class="label" id="l-${key}">${text}</span><div class="swatches" role="radiogroup" aria-labelledby="l-${key}">${buttons}</div></div>`;
  }
  const idField = () =>
    selected ? '' : input('id', 'ID', { mono: true, maxLength: 40, hint: '用于凭据和接口，创建后不能修改' });

  function flagInfo(n) {
    const code = (n.countryCode || '').toUpperCase();
    const guess = country({ ...n, countryCode: '' });
    const flags = window.LinkscopeFlagCodes || [];
    let hint = '两位地区代码，例如 HK、JP、US';
    if (code.length === 2) hint = flags.includes(code) ? regionName(code) : '没有这个地区的旗帜，将显示地球图标';
    else if (!code && guess) hint = `${regionName(guess)} · 按地区推断`;
    return { tile: tileIcon({ ...n, countryCode: code.length === 2 ? code : '' }), hint, guess };
  }
  function mark(g = group, row = draft) {
    if (g === 'nodes') return tileIcon({ ...row, countryCode: row.countryCode?.length === 2 ? row.countryCode : '' });
    if (g === 'routes') return `<span class="node-icon ${row.tone}">${icon('routes')}</span>`;
    return `<span class="node-icon neutral">${icon('links')}</span>`;
  }

  function measuredBy() {
    const links = selected ? config.links.filter((l) => l.mode && l.observer && targetOf(l) === selected) : [];
    if (!links.length) return '<p class="hint">其他主机探针测量这个节点时使用。Ping 只需要地址。</p>';
    return `<ul class="usage-list">${links
      .map((l) => {
        const missing = missingTarget(l, draft);
        return `<li>${chip('links', l)}<span>${l.mode} · 由${esc(nodeName(l.observer))}测量</span>${missing ? label(['degraded', missing]) : ''}</li>`;
      })
      .join('')}</ul>`;
  }
  function agentState() {
    const s = liveNode(selected);
    const state = s?.state || 'waiting';
    if (state === 'waiting') return `${label(['waiting', '待上报'])}<span>还没有收到心跳</span>`;
    return `${label([state, nodeStates[state]])}<span>最后心跳 ${ago(s.last)}</span>`;
  }
  function command(title, text) {
    return `<div class="command"><span class="label">${title}</span><div class="command-box"><pre><code>${esc(text)}</code></pre><button type="button" class="icon-button copy" data-copy aria-label="复制命令" title="复制">${icon('copy')}</button></div></div>`;
  }
  function agentPanel() {
    if (draft.source !== 'system') return '<p class="hint">本地模拟器会替这个节点上报示例数据。</p>';
    if (!selected) return '<p class="hint">创建后这里会给出接入命令。</p>';
    const id = selected,
      url = location.origin;
    const steps =
      access === 'local'
        ? command('在项目目录运行', `python3 probes/agent.py --id ${id} --token-file .local-state/tokens/${id} --url ${url}`)
        : command('1. 在面板服务器读取凭据', `sudo cat /var/lib/linkscope/tokens/${id}`) +
          command(
            '2. 在探针机保存凭据，粘贴后按 Ctrl-D',
            `sudo sh -c 'umask 077; mkdir -p /etc/linkscope/tokens; cat > /etc/linkscope/tokens/${id}'`,
          ) +
          command(
            '3. 指定面板地址并启动探针',
            `sudo sh -eu -c '
  umask 077
  file=/etc/linkscope/probe.env
  if [ -s "$file" ]; then
    sed -i -e "1iLINKSCOPE_URL=$1" -e "/^[[:blank:]]*LINKSCOPE_URL[[:blank:]]*=/d" "$file"
  else
    printf "LINKSCOPE_URL=%s\\n" "$1" > "$file"
  fi
' sh '${url}' && sudo systemctl enable linkscope-agent@${id} && sudo systemctl restart linkscope-agent@${id}`,
          ) +
          '<p class="hint">探针机需要 Python 3.10 以上，并已放好 <code>/opt/linkscope/probes</code> 和 <code>linkscope-agent@.service</code>。完整步骤见 deploy/README.md。</p>';
    const online = liveNode(id)?.state === 'online';
    return `<div class="connect"><p class="connect-state" id="agent-state">${agentState()}</p>
      <details class="commands"${online ? '' : ' open'}><summary>接入命令</summary>${steps}</details></div>`;
  }

  function nodeForm() {
    const n = draft;
    const kind = kinds.find(([k]) => k === n.kind);
    const flag = flagInfo(n);
    let html = section(
      '基本信息',
      grid(
        input('name', '名称', { maxLength: 64, placeholder: '例如 香港出口' }),
        idField(),
        segmented(
          'kind',
          '节点类型',
          kinds.map(([v, t]) => [v, t]),
          { span: true, hint: kind?.[2] },
        ),
      ),
    );
    html += section(
      '拓扑展示',
      grid(
        input('place', '地区', { maxLength: 60, placeholder: '例如 香港' }),
        input('provider', '服务商', { maxLength: 64 }),
        input('role', '角色', { maxLength: 40, placeholder: '例如 跨境中转' }),
        input('countryCode', '旗帜', {
          maxLength: 2,
          mono: true,
          placeholder: flag.guess || '',
          adorn: `<span class="flag-preview" id="flag-preview">${flag.tile}</span>`,
          hint: esc(flag.hint),
        }),
        swatches('tone', '颜色'),
      ),
    );
    html += section(
      '探测地址',
      grid(
        input('address', 'IP 或主机名', { mono: true, maxLength: 253, placeholder: '203.0.113.10' }),
        input('port', 'TCP 端口', { number: true, int: true, min: 1, max: 65535, mono: true, placeholder: 'TCP 测量时填写' }),
      ) + `<div id="measured-by">${measuredBy()}</div>`,
    );
    if (n.kind === 'agent') {
      const source =
        access === 'local' || n.source === 'simulated'
          ? segmented('source', '上报来源', [
              ['system', '实际探针'],
              ['simulated', '本地模拟'],
            ])
          : '';
      html += section('探针', source + `<div id="agent-panel">${agentPanel()}</div>`);
    }
    const directions = [
      ['both', '上行＋下行'],
      ['up', '仅上行'],
      ['down', '仅下行'],
      ['max', '上、下行累计取较大值'],
      ...(n.kind === 'shared' ? [['single', '单向（车主计量）']] : []),
    ];
    const current = config.usage?.[selected];
    const used = resetUsage || current == null ? n.usedGiB : Number(current.toFixed(4));
    let quota = segmented(
      '_quota',
      '额度',
      [
        ['none', '未设置'],
        ['quota', '每月额度'],
        ['unlimited', '不限额'],
      ],
      { span: true },
    );
    if (n._quota !== 'none')
      quota +=
        grid(
          n._quota === 'quota' ? input('quotaGiB', '额度 · GiB', { number: true }) : '',
          input('usedGiB', '本期已用 · GiB', { number: true, value: used ?? '' }),
          select('direction', '计费方向', directions),
          input('resetDay', '每月重置日 · UTC', { number: true, int: true, min: 1, max: 31, placeholder: '留空则手动校准' }),
        ) +
        `<p class="hint">${n.kind === 'agent' ? '探针按计费方向累计网卡流量，改「本期已用」可以校准。' : '按车主或服务商提供的数据更新「本期已用」。'}短月的重置日取月末。</p>`;
    html += section('流量', `<div class="stack">${quota}</div>`);
    return html;
  }

  function linkForm() {
    const l = draft;
    const choices = config.nodes.map((n) => [n.id, n.name]);
    let html = section(
      '基本信息',
      grid(
        input('name', '名称', { maxLength: 64, placeholder: '例如 香港云联网' }),
        input('service', '网络 / 服务', { maxLength: 64, placeholder: '例如 CCN、IPLC' }),
        idField(),
      ),
    );
    const used = selected ? routesUsing(selected) : [];
    const saved = selected && linkById(selected);
    let ends = `<div class="endpoints">${select('from', '上游', choices)}<button type="button" class="icon-button swap" data-swap aria-label="交换上下游" title="交换上下游">${icon('swap')}</button>${select('to', '下游', choices)}</div>`;
    if (used.length)
      ends += `<div class="usage-line"><span class="label">所在线路</span>${used.map((r) => chip('routes', r)).join('')}</div>`;
    if (used.length && saved && (saved.from !== l.from || saved.to !== l.to))
      ends += '<p class="hint warn">改了两端以后，这些线路仍要首尾相接才能保存。</p>';
    html += section('两端', ends);
    const ends2 = [l.from, l.to].map(nodeById);
    let measure = segmented(
      'mode',
      '测量方式',
      [
        [null, '不测'],
        ['ICMP', 'ICMP Ping'],
        ['TCP', 'TCP 建连'],
      ],
      { span: true },
    );
    if (l.mode) {
      const agents = ends2.filter((n) => n?.kind === 'agent');
      measure += segmented(
        'observer',
        '从哪一端测量',
        ends2.map((n) => [n.id, esc(n.name), n.kind === 'agent' ? {} : { disabled: true, title: '不是主机探针' }]),
        { span: true },
      );
      if (!agents.length) measure += '<p class="hint warn span">两端都没有主机探针。先把其中一端设为主机探针。</p>';
      else if (l.observer) {
        const t = nodeById(targetOf(l));
        const missing = missingTarget(l, t);
        const where = t.address ? `<code>${esc(t.address)}${l.mode === 'TCP' && t.port ? ':' + t.port : ''}</code>` : '';
        measure += `<div class="target-line span${missing ? ' warn' : ''}"><span class="label">目标</span>${mark('nodes', t)}<b>${esc(t.name)}</b>${where}${missing ? `<span class="missing">${missing}</span>` : ''}<button type="button" class="text-button" data-open="nodes:${esc(t.id)}">${missing ? '去填写' : '修改'}</button></div>`;
      }
      measure += segmented(
        'standalone',
        '什么时候测',
        [
          [false, '线路用到时'],
          [true, '一直测'],
        ],
        { span: true },
      );
    }
    html += section('测量', grid(measure));
    return html;
  }

  function chain() {
    const r = draft;
    const entry = nodeById(r.entry);
    const items = [
      `<li class="chain-node">${entry ? mark('nodes', entry) : ''}<div class="field chain-entry${errors.entry ? ' invalid' : ''}" data-field="entry"><select id="f-entry" name="entry" aria-label="入口">${config.nodes
        .map((n) => `<option value="${esc(n.id)}"${n.id === r.entry ? ' selected' : ''}>${esc(n.name)}</option>`)
        .join('')}</select>${errorLine('entry')}</div><span class="chain-tag">入口</span></li>`,
    ];
    let current = r.entry;
    const visited = new Set([current]);
    r.tail.forEach((id, i) => {
      const l = linkById(id);
      if (!l) return;
      const last = i === r.tail.length - 1;
      items.push(
        `<li class="chain-link">${chip('links', l)}${l.mode ? `<span class="chain-mode">${l.mode}</span>` : ''}<span data-link-status="${esc(id)}">${label(linkStatus(l))}</span>${last ? `<button type="button" class="icon-button chain-cut" data-cut="${i}" aria-label="移除这一段" title="移除这一段">${icon('close')}</button>` : ''}</li>`,
        `<li class="chain-node">${mark('nodes', nodeById(l.to))}<strong>${esc(nodeName(l.to))}</strong></li>`,
      );
      visited.add(l.to);
      current = l.to;
    });
    const next = config.links.filter((l) => l.from === current && !visited.has(l.to));
    const options = next
      .map(
        (l) =>
          `<button type="button" class="next-hop" data-add-hop="${esc(l.id)}">${icon('plus')}<span><b>${esc(nodeName(l.to))}</b><small>${esc(l.name)} · ${l.mode || '未测'}</small></span></button>`,
      )
      .join('');
    const newLink = creationHint('links')
      ? `<p class="hint">${creationHint('links')}</p><button type="button" class="text-button" data-start="nodes">${icon('plus')}新建节点</button>`
      : `<button type="button" class="text-button" data-new-link="${esc(current)}">${icon('plus')}新建从「${esc(nodeName(current))}」出发的链路</button>`;
    items.push(`<li class="chain-next">${next.length ? `<span class="label">${r.tail.length ? '继续经过' : '第一段'}</span><div class="next-options">${options}</div>` : `<p class="hint">「${esc(nodeName(current))}」没有可以继续的出站链路。</p>`}${newLink}</li>`);
    const unmeasured = r.tail.filter((id) => !linkById(id)?.mode).length;
    return (
      `<ol class="path-chain">${items.join('')}</ol>` +
      (unmeasured ? `<p class="hint warn">${unmeasured} 段没有设置测量方式，线路合计会一直显示待测。</p>` : '') +
      (r.tail.length ? '' : '<p class="hint">只有入口的线路是直连。</p>')
    );
  }
  function routeForm() {
    const r = draft;
    let html = section(
      '基本信息',
      grid(input('name', '名称', { maxLength: 64, placeholder: '例如 香港主线' }), idField(), swatches('tone', '颜色')),
    );
    html += section('路径', chain());
    if (config.routeTestsEnabled) {
      let test = segmented('test', '客户端整线测试', [
        [false, '不测'],
        [true, '启用'],
      ]);
      if (r.test) {
        test += segmented('testSource', '测试来源', [
          ['system', '实际客户端'],
          ['simulated', '本地模拟'],
        ]);
        if (r.testSource !== 'simulated')
          test +=
            grid(
              input('testProxy', '测试端 HTTP 代理', { mono: true, maxLength: 1024 }),
              segmented('testMode', '全程测量方式', [
                ['http204', 'HTTP 204'],
                ['tls', 'TLS 握手'],
              ]),
              input('testUrl', '测试目标网址', { mono: true, maxLength: 1024, span: true }),
            ) + '<p class="hint">填写测试端上已经通往这条路径的代理。切回已绑定的路径会恢复原来的设置。</p>';
      }
      html += section('整线测试', `<div class="stack">${test}</div>`);
    }
    return html;
  }

  function creationHint(g) {
    if (g === 'links' && config.nodes.length < 2) return '至少需要两个节点才能新建链路';
    if (g === 'routes' && !config.nodes.length) return '请先添加一个节点作为线路入口';
    return '';
  }
  function setup() {
    const counts = { nodes: config.nodes.length, links: config.links.length, routes: config.routes.length };
    const steps = [
      ['nodes', '添加节点', '每台服务器、入口或落地都是一个节点。装了探针的主机会上报状态并负责测量。', true],
      ['links', '连接链路', '链路连接两个节点，并决定用哪种方式、从哪一端测量。', counts.nodes >= 2],
      ['routes', '组成线路', '从入口出发，按顺序经过链路。拓扑页会汇总整条线路的延迟。', counts.nodes >= 1],
    ];
    const current = steps.find(([g]) => !counts[g])?.[0];
    const done = !current;
    return `<div class="setup">
      <h2>${done ? `选择左侧的${groups[group]}进行编辑` : '三步搭好拓扑'}</h2>
      <ol class="setup-steps">${steps
        .map(([g, title, text, ready], i) => {
          const state = counts[g] ? 'done' : g === current ? 'current' : 'todo';
          const action =
            g === group || g === current
              ? `<button type="button" class="${g === current ? 'save-button' : 'control'}" data-start="${g}"${ready ? '' : ' disabled'}>${icon('plus')}新建${groups[g]}</button>`
              : '';
          return `<li class="${state}"><span class="step-num">${counts[g] ? icon('check') : i + 1}</span><div><b>${title}</b><p>${counts[g] ? `已有 ${counts[g]} ${g === 'nodes' ? '个' : '条'}${groups[g]}` : text}</p></div>${action}</li>`;
        })
        .join('')}</ol></div>`;
  }

  function paintEditor() {
    const active = document.activeElement;
    const focusKey =
      active && editor.contains(active)
        ? active.dataset.set
          ? `[data-set="${active.dataset.set}"][data-value="${CSS.escape(active.dataset.value)}"]`
          : active.id
            ? '#' + CSS.escape(active.id)
            : null
        : null;
    if (!draft) {
      editor.innerHTML = setup();
      return;
    }
    const title = draft.name || `新建${groups[group]}`;
    const row = selected && config[group].find((r) => r.id === selected);
    const status = row ? label(statusOf(group, row)) : '';
    const body = group === 'nodes' ? nodeForm() : group === 'links' ? linkForm() : routeForm();
    editor.innerHTML = `<header class="editor-head">
        <button type="button" class="icon-button phone-back" data-back aria-label="返回列表">${icon('back')}</button>
        <span class="head-mark" id="head-mark">${mark()}</span>
        <div class="head-copy"><h2 id="edit-title">${esc(title)}</h2>
          <p class="head-sub">${selected ? `<code>${esc(selected)}</code><span id="head-status">${status}</span>` : '尚未创建'}</p></div>
        ${selected ? '<button type="button" class="text-button danger" data-delete>删除</button>' : ''}
      </header><form class="editor-form" id="edit-form" novalidate>${body}</form>`;
    if (focusKey) $(focusKey, editor)?.focus({ preventScroll: true });
  }
  function paintCategories() {
    $('#categories').innerHTML = Object.entries(groups)
      .map(
        ([id, name]) =>
          `<button type="button" role="tab" data-group="${id}" aria-selected="${group === id}">${name}<span>${config[id].length}</span></button>`,
      )
      .join('');
    $('#add-label').textContent = `新建${groups[group]}`;
    const hint = creationHint(group);
    $('#add-item').disabled = !!hint;
    $('#add-hint').textContent = hint;
    $('#add-hint').hidden = !hint;
  }
  function paintList() {
    const sub = (row) =>
      group === 'nodes'
        ? [row.role, row.place].filter(Boolean).join(' · ')
        : group === 'links'
          ? `${nodeName(row.from)} → ${nodeName(row.to)}`
          : pathNames(row).join(' → ');
    const draftRow =
      draft && !selected
        ? `<div class="inventory-item draft" aria-current="true" role="listitem"><span class="item-mark">${mark()}</span><span class="item-copy"><strong>${esc(draft.name || `新建${groups[group]}`)}</strong><small>未创建</small></span></div>`
        : '';
    $('#inventory-list').innerHTML =
      draftRow +
        config[group]
          .map(
            (row) =>
              `<button type="button" class="inventory-item" role="listitem" data-select="${esc(row.id)}" aria-current="${selected === row.id}"><span class="item-mark">${mark(group, row)}</span><span class="item-copy"><strong>${esc(row.name)}</strong><small>${esc(sub(row))}</small></span>${label(statusOf(group, row))}</button>`,
          )
          .join('') || (draftRow ? '' : `<p class="empty-list">还没有${groups[group]}</p>`);
  }
  function paintMeta() {
    const agents = config.nodes.filter((n) => n.kind === 'agent');
    const online = agents.filter((n) => liveNode(n.id)?.state === 'online').length;
    const missing = config.links.map((l) => missingTarget(l));
    const probes = agents.length ? `${online} / ${agents.length} 个探针在线` : '还没有主机探针';
    $('#admin-meta').innerHTML =
      `<span${online < agents.length ? ' class="meta-warn"' : ''}>${probes}</span>` +
      ['缺地址', '缺端口'].map((reason) => {
        const count = missing.filter((s) => s === reason).length;
        return count ? `<span class="meta-warn">${count} 段${reason}</span>` : '';
      }).join('');
  }
  function paintBar() {
    $('.admin-shell').inert = saving;
    $('#discard').disabled = $('#reload-config').disabled = saving;
    const isNew = !!draft && !selected;
    const show = !!draft && (dirty || isNew || !!notice);
    $('#save-bar').hidden = !show;
    document.body.classList.toggle('has-bar', show);
    if (!show) return;
    const p = $('#save-note');
    p.textContent = notice?.text || (isNew ? `新建${groups[group]}` : dirty ? '有未保存的修改' : '');
    p.classList.toggle('error', !!notice?.error);
    $('#discard').textContent = isNew ? '取消' : '放弃';
    $('#discard').hidden = !isNew && !dirty;
    const conflict = !$('#reload-config').hidden;
    $('#save').textContent = saving && !conflict ? '正在保存…' : isNew ? '创建' : '保存';
    $('#save').disabled = saving || conflict || (!isNew && !dirty);
  }
  function paintLive() {
    if (!config) return;
    paintMeta();
    paintList();
    for (const badge of $$('[data-link-status]', editor)) {
      badge.innerHTML = label(linkStatus(linkById(badge.dataset.linkStatus)));
    }
    if (!draft || !selected) {
      if (!draft) paintEditor();
      return;
    }
    const row = config[group].find((r) => r.id === selected);
    if (row && $('#head-status')) $('#head-status').innerHTML = label(statusOf(group, row));
    if ($('#agent-state')) $('#agent-state').innerHTML = agentState();
  }
  function paintAll() {
    paintMeta();
    paintCategories();
    paintList();
    paintEditor();
    paintBar();
  }
  function note(text, error = false) {
    notice = text ? { text, error } : null;
    paintBar();
  }
  let toastTimer;
  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 2800);
  }

  function slug(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^[^a-z]+|-+$/g, '');
  }
  function suggestId() {
    const prefix = prefixes[group];
    let base = (group === 'links' ? `${draft.from}-${draft.to}` : slug(draft.name)).slice(0, 36);
    if (!/^[a-z][a-z0-9_-]+$/.test(base) || base.startsWith('peer-') || base === 'all' || base === 'client') base = prefix;
    const taken = new Set(config[group].map((r) => r.id));
    if (base !== prefix && !taken.has(base)) return base;
    for (let i = base === prefix ? 1 : 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  }
  function newItem(preset = {}) {
    const base = { id: '', name: '', tone: 'mint' };
    if (group === 'nodes')
      return {
        ...base,
        kind: 'agent',
        icon: 'server',
        role: '',
        place: '',
        provider: '',
        countryCode: '',
        source: 'system',
        address: '',
        port: null,
        quotaGiB: null,
        usedGiB: null,
        direction: 'both',
        resetDay: null,
        _quota: 'none',
      };
    if (group === 'links') {
      const from = preset.from || config.nodes[0].id;
      const targets = config.nodes.filter((n) => n.id !== from);
      const to = (targets.find((n) => !config.links.some((l) => l.from === from && l.to === n.id)) || targets[0]).id;
      const link = { ...base, from, to, mode: null, observer: null, service: '', standalone: false };
      const agent = [from, to].find((id) => nodeById(id)?.kind === 'agent');
      if (agent) Object.assign(link, { mode: 'ICMP', observer: agent });
      return link;
    }
    return {
      ...base,
      entry: (config.nodes.find((n) => n.kind === 'ingress') || config.nodes[0])?.id || '',
      tail: [],
      test: false,
      testSource: 'system',
      testMode: 'http204',
      testProxy: '',
      testUrl: '',
    };
  }
  function reset() {
    dirty = resetUsage = bindProxy = idTouched = modeTouched = false;
    errors = {};
    notice = null;
    $('#reload-config').hidden = true;
  }
  function openItem(id) {
    const row = id && config[group].find((r) => r.id === id);
    if (!row) return closeEditor();
    selected = id;
    draft = structuredClone(row);
    if (group === 'nodes') draft._quota = draft.unlimited ? 'unlimited' : draft.quotaGiB != null ? 'quota' : 'none';
    if (group === 'routes') draft.testMode ??= 'http204';
    reset();
    paintAll();
  }
  function startNew(preset) {
    returnTo = selected;
    selected = null;
    draft = newItem(preset);
    draft.id = suggestId();
    reset();
    paintAll();
    $('#f-name')?.focus({ preventScroll: true });
  }
  function closeEditor() {
    selected = draft = null;
    setEditing(false);
    reset();
    paintAll();
  }
  const setEditing = (on) => document.body.classList.toggle('editing', on);

  function ask(title, body, ok, { danger = false, cancel = '取消' } = {}) {
    const dialog = $('#confirm');
    $('#confirm-title').textContent = title;
    $('#confirm-body').innerHTML = body;
    $('#confirm-ok').textContent = ok;
    $('#confirm-ok').classList.toggle('danger', danger);
    $('#confirm-cancel').textContent = cancel || '';
    $('#confirm-cancel').hidden = !cancel;
    dialog.returnValue = '';
    dialog.showModal();
    return new Promise((resolve) =>
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true }),
    );
  }
  async function confirmDiscard() {
    if (saving) return false;
    if (!dirty) return true;
    return ask('放弃未保存的修改？', `<p>「${esc(draft.name || `新建${groups[group]}`)}」的修改还没有保存。</p>`, '放弃修改', {
      danger: true,
      cancel: '继续编辑',
    });
  }
  async function navigate(g, id, preset) {
    if (!id && creationHint(g)) return toast(creationHint(g));
    if (!(await confirmDiscard())) return;
    group = g;
    if (id) openItem(id);
    else startNew(preset);
    setEditing(!!draft);
    window.scrollTo({ top: 0 });
  }
  function references() {
    if (group === 'nodes')
      return [
        ...config.links.filter((l) => l.from === selected || l.to === selected).map((l) => ['links', l, '链路']),
        ...config.routes.filter((r) => r.entry === selected).map((r) => ['routes', r, '线路入口']),
      ];
    if (group === 'links') return routesUsing(selected).map((r) => ['routes', r, '线路']);
    return [];
  }
  async function removeItem() {
    const saved = config[group].find((r) => r.id === selected);
    const refs = references();
    if (refs.length) {
      await ask(
        `「${saved.name}」还在使用中`,
        `<p>先在这些地方移除它，再删除：</p><ul class="ref-list">${refs.map(([g, row, what]) => `<li><span>${what}</span>${chip(g, row)}</li>`).join('')}</ul>`,
        '知道了',
        { cancel: '' },
      );
      return;
    }
    const body =
      group === 'nodes' ? '<p>这个节点留存的主机历史、流量计数和探针凭据会一起删除。</p>' : '';
    if (await ask(`删除「${saved.name}」？`, body, '删除', { danger: true })) save(true);
  }

  function validate() {
    const e = {},
      d = draft;
    if (!String(d.name || '').trim()) e.name = '请填写名称';
    if (!selected) {
      if (!/^[a-z][a-z0-9_-]{0,39}$/.test(d.id || '')) e.id = '以小写字母开头，只能含小写字母、数字、短横线和下划线';
      else if (d.id.startsWith('peer-') || d.id === 'all' || d.id === 'client') e.id = '这个 ID 由系统保留';
      else if (config[group].some((r) => r.id === d.id)) e.id = '这个 ID 已经存在';
    }
    if (group === 'nodes') {
      if (d.countryCode && !/^[A-Za-z]{2}$/.test(d.countryCode)) e.countryCode = '需要两位字母';
      if (d.port != null && !(Number.isInteger(d.port) && d.port >= 1 && d.port <= 65535)) e.port = '端口范围是 1–65535';
      if (d._quota !== 'none') {
        if (d.resetDay != null && !(Number.isInteger(d.resetDay) && d.resetDay >= 1 && d.resetDay <= 31))
          e.resetDay = '填写 1–31';
        for (const k of ['quotaGiB', 'usedGiB'])
          if (d[k] != null && !(d[k] >= 0 && d[k] <= 1e8)) e[k] = '填写 0 到 1 亿之间的数';
        if (d._quota === 'quota' && d.quotaGiB == null && !e.quotaGiB) e.quotaGiB = '填写额度，或选择「未设置」';
      }
    }
    if (group === 'links') {
      if (!d.from || !d.to || d.from === d.to) e.to = '两端需要是不同的节点';
      if (d.mode && !d.observer) e.observer = '需要一端是主机探针';
    }
    if (group === 'routes' && !nodeById(d.entry)) e.entry = '请选择入口';
    return e;
  }
  function refreshErrors(all = false) {
    const found = validate();
    errors = all ? found : Object.fromEntries(Object.keys(errors).filter((k) => found[k]).map((k) => [k, found[k]]));
    $$('[data-field]', editor).forEach((el) => {
      const k = el.dataset.field;
      el.classList.toggle('invalid', !!errors[k]);
      const line = $('.error', el);
      if (line) line.textContent = errors[k] || '';
    });
    return found;
  }

  function markDirty() {
    dirty = true;
    if (notice?.error) notice = null;
    paintBar();
  }
  function pathEdited() {
    draft.testProxy = '';
    bindProxy = false;
    markDirty();
    paintEditor();
  }
  function apply(key, value) {
    draft[key] = value;
    if (key === 'entry') {
      draft.tail = [];
      return pathEdited();
    }
    if (key === 'kind') {
      draft.source = value === 'agent' ? draft.source || 'system' : null;
      if (value !== 'shared' && draft.direction === 'single') draft.direction = 'both';
    }
    if (key === '_quota') {
      draft.unlimited = value === 'unlimited';
      if (value !== 'quota') draft.quotaGiB = null;
    }
    if (['mode', 'from', 'to'].includes(key)) {
      const agents = [draft.from, draft.to].filter((id) => nodeById(id)?.kind === 'agent');
      if (key === 'mode') modeTouched = true;
      // A new link measures by default once one end can run the probe, until the user picks a method.
      else if (!selected && !modeTouched) draft.mode = agents.length ? 'ICMP' : null;
      if (!draft.mode) draft.observer = null;
      else if (!agents.includes(draft.observer)) draft.observer = agents[0] || null;
      if (!selected && !idTouched && key !== 'mode') draft.id = suggestId();
    }
    markDirty();
    refreshErrors();
    paintEditor();
  }

  async function readConfig() {
    const r = await window.sessionFetch('/api/v1/config', { cache: 'no-store' });
    if (!r.ok) throw new Error('管理配置暂时不可读');
    access = r.headers.get('X-Linkscope-Access') || 'local';
    $('#sign-out').hidden = access !== 'admin';
    return r.json();
  }
  async function refreshLive() {
    try {
      const r = await fetch('/api/v1/state?trend=all', { cache: 'no-store' });
      if (r.ok) live = await r.json();
    } catch {
      // Status labels keep their last reading until the panel answers again.
    }
    paintLive();
  }
  async function save(remove = false) {
    if (saving || !draft || $('#confirm').open || !$('#reload-config').hidden) return;
    if (!remove) {
      const found = Object.keys(refreshErrors(true));
      if (found.length) {
        note(`有 ${found.length} 处需要修改`, true);
        $(`[data-field="${found[0]}"] :is(input, select, button:not(:disabled))`, editor)?.focus();
        return;
      }
      const old = group === 'nodes' && selected && nodeById(selected);
      if (old?.kind === 'agent' && (draft.kind !== old.kind || draft.source !== old.source)) {
        const effect = draft.kind === 'agent'
          ? '原凭据将失效，新来源需要使用新凭据上报。真实与模拟来源的历史分别保留。'
          : '原凭据将失效，面板将停止接收这台探针的上报。已采集的主机历史按原保留期保存。';
        if (!(await ask(`更改「${old.name}」的探针？`, `<p>${effect}</p>`, '确认更改', { danger: true }))) return;
      }
    }
    const { _quota, ...item } = draft;
    item.name = item.name.trim();
    if (group === 'nodes') {
      item.unlimited = _quota === 'unlimited';
      if (_quota !== 'quota') item.quotaGiB = null;
      item.countryCode = (item.countryCode || '').toUpperCase();
    }
    const payload = {
      ...config,
      resetUsage: resetUsage && !remove ? [item.id] : [],
      bindProxy: bindProxy && !remove ? [item.id] : [],
    };
    delete payload.usage;
    const rows = config[group];
    const name = config[group].find((r) => r.id === selected)?.name;
    const created = !selected;
    payload[group] = remove
      ? rows.filter((r) => r.id !== selected)
      : selected
        ? rows.map((r) => (r.id === selected ? item : r))
        : [...rows, item];
    saving = true;
    notice = null;
    paintBar();
    try {
      const r = await window.sessionFetch('/api/v1/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Linkscope-Admin': '1' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const result = await r.json().catch(() => ({}));
        throw Object.assign(new Error(result.error || '保存失败'), { status: r.status });
      }
      config = await r.json();
      saving = false;
      if (!remove) openItem(item.id);
      else if (phone.matches) closeEditor();
      else openItem(config[group][0]?.id);
      toast(remove ? `已删除「${name}」` : created ? `已创建「${item.name}」` : '已保存，拓扑会自动更新');
      refreshLive();
    } catch (e) {
      saving = false;
      $('#reload-config').hidden = e.status !== 409;
      note(e.message, true);
    }
    paintBar();
  }
  async function copy(button) {
    const code = $('code', button.closest('.command'));
    try {
      await navigator.clipboard.writeText(code.textContent);
      button.innerHTML = icon('check');
      button.classList.add('copied');
      setTimeout(() => {
        button.innerHTML = icon('copy');
        button.classList.remove('copied');
      }, 1500);
    } catch {
      const range = document.createRange();
      range.selectNodeContents(code);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    }
  }

  $('#categories').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-group]');
    if (!b || b.dataset.group === group || !(await confirmDiscard())) return;
    group = b.dataset.group;
    setEditing(false);
    if (phone.matches) closeEditor();
    else openItem(config[group][0]?.id);
  });
  $('#inventory-list').addEventListener('click', (e) => {
    if (e.target.closest('[data-retry-load]')) return loadConfig();
    const b = e.target.closest('[data-select]');
    if (!b) return;
    if (b.dataset.select === selected) setEditing(true);
    else navigate(group, b.dataset.select);
  });
  $('#add-item').addEventListener('click', () => config && navigate(group, null));
  editor.addEventListener('click', async (e) => {
    const t = e.target.closest(
      '[data-set],[data-swap],[data-add-hop],[data-cut],[data-open],[data-new-link],[data-delete],[data-back],[data-copy],[data-start]',
    );
    if (!t || t.disabled) return;
    const d = t.dataset;
    if ('set' in d) return apply(d.set, JSON.parse(d.value));
    if ('swap' in d) {
      [draft.from, draft.to] = [draft.to, draft.from];
      return apply('from', draft.from);
    }
    if ('addHop' in d) {
      draft.tail.push(d.addHop);
      return pathEdited();
    }
    if ('cut' in d) {
      draft.tail = draft.tail.slice(0, Number(d.cut));
      return pathEdited();
    }
    if ('open' in d) {
      const [g, id] = d.open.split(':');
      return navigate(g, id);
    }
    if ('newLink' in d) return navigate('links', null, { from: d.newLink });
    if ('start' in d) return navigate(d.start, null);
    if ('delete' in d) return removeItem();
    if ('copy' in d) return copy(t);
    if ('back' in d && (await confirmDiscard())) {
      setEditing(false);
      closeEditor();
    }
  });
  editor.addEventListener('input', (e) => {
    const el = e.target;
    const key = el.name;
    if (!key || el.tagName === 'SELECT' || !draft) return;
    let value = el.value;
    if (el.type === 'number') value = value === '' ? null : Number(value);
    if (key === 'countryCode') {
      value = value.toUpperCase().replace(/[^A-Z]/g, '');
      if (el.value !== value) el.value = value;
    }
    draft[key] = value;
    markDirty();
    if (key === 'usedGiB') resetUsage = true;
    if (key === 'testProxy') bindProxy = true;
    if (key === 'id') idTouched = true;
    if (key === 'name') {
      $('#edit-title').textContent = value || `新建${groups[group]}`;
      if (!selected && !idTouched && group !== 'links') {
        draft.id = suggestId();
        $('#f-id').value = draft.id;
      }
    }
    if (key === 'countryCode' || key === 'place') {
      const flag = flagInfo(draft);
      $('#flag-preview').innerHTML = flag.tile;
      $('#h-countryCode').textContent = flag.hint;
      $('#f-countryCode').placeholder = flag.guess || '';
      $('#head-mark').innerHTML = mark();
    }
    if (key === 'address' || key === 'port') $('#measured-by').innerHTML = measuredBy();
    refreshErrors();
  });
  editor.addEventListener('change', (e) => {
    if (e.target.tagName === 'SELECT' && draft) apply(e.target.name, e.target.value);
  });
  editor.addEventListener('submit', (e) => {
    e.preventDefault();
    save();
  });
  $('#save').addEventListener('click', () => save());
  $('#discard').addEventListener('click', () => {
    if (selected) return openItem(selected);
    if (phone.matches) return closeEditor();
    openItem(config[group].some((r) => r.id === returnTo) ? returnTo : config[group][0]?.id);
  });
  $('#reload-config').addEventListener('click', async () => {
    saving = true;
    paintBar();
    try {
      config = await readConfig();
      openItem(selected);
      refreshLive();
    } catch (e) {
      note(e.message, true);
    } finally {
      saving = false;
      paintBar();
    }
  });
  $('#confirm').addEventListener('click', (e) => {
    const b = e.target.closest('[data-open]');
    if (!b) return;
    e.preventDefault();
    $('#confirm').close('cancel');
    const [g, id] = b.dataset.open.split(':');
    navigate(g, id);
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && draft) {
      e.preventDefault();
      if (dirty || !selected) save();
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  setInterval(() => {
    if (config && !document.hidden) refreshLive();
  }, 10000);
  document.addEventListener('visibilitychange', () => !document.hidden && config && refreshLive());

  async function loadConfig() {
    $('#inventory-list').textContent = '';
    $('#admin-meta').textContent = '正在读取配置';
    try {
      config = await readConfig();
      if (!phone.matches && config.nodes.length) openItem(config.nodes[0].id);
      else paintAll();
      refreshLive();
    } catch (e) {
      $('#admin-meta').textContent = '配置读取失败';
      $('#inventory-list').innerHTML = `<p class="load-error" role="alert">${esc(e.message)}</p><button type="button" class="control" data-retry-load>重新载入</button>`;
    }
  }
  fillIcons();
  loadConfig();
})();
