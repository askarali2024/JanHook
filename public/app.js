/* JanHook UI — vanilla JS, no build step, no dependencies. */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);

  // Inline SVG icons used inside JS-rendered markup.
  const svg = (inner) =>
    `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
  const ICON_COPY = svg('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>');
  const ICON_TERM = svg('<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>');
  const ICON_REPLAY = svg('<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>');
  const ICON_TRASH = svg('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>');

  // ---------------------------------------------------------------- state --
  const state = {
    endpoints: [],
    slug: null,
    requests: [], // newest first
    selectedId: null,
    filter: '',
    tab: 'body', // body | headers | query
    bodyMode: 'pretty', // pretty | raw
  };

  // ------------------------------------------------------------- utilities --
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));

  async function api(path, opts = {}) {
    const init = { method: opts.method || 'GET', headers: {} };
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    const res = await fetch(path, init);
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      try {
        const j = await res.json();
        if (j && j.error) msg = j.error;
      } catch { /* not json */ }
      throw new Error(msg);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  function toast(message, type = 'ok') {
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = message;
    $('#toasts').appendChild(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 300);
    }, 2400);
  }

  async function copyText(text, label = 'Copied') {
    if (!text) {
      toast('Nothing to copy', 'err');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast(`${label} to clipboard`);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
      toast(ok ? `${label} to clipboard` : 'Copy failed', ok ? 'ok' : 'err');
    }
  }

  function fmtBytes(n) {
    if (n == null) return '—';
    if (n === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
    return `${i === 0 || v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
  }

  function relTime(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (s < 10) return 'just now';
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }

  function methodClass(m) {
    const mm = String(m || '').toUpperCase();
    if (mm === 'POST') return 'post';
    if (mm === 'GET') return 'get';
    if (mm === 'PUT' || mm === 'PATCH') return 'put';
    if (mm === 'DELETE') return 'delete';
    return 'other';
  }

  function shortCt(ct) {
    return String(ct || '').split(';')[0].trim() || 'unknown';
  }

  function statusClass(code) {
    if (code >= 500) return 's5xx';
    if (code >= 400) return 's4xx';
    if (code >= 300) return 's3xx';
    if (code >= 200) return 's2xx';
    return 's1xx';
  }

  // Tiny regex JSON highlighter (no dependencies).
  const JSON_TOKEN_RE = /"(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(?:\s*:)?|\b(?:true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g;

  function highlightJSON(data) {
    let json;
    try {
      json = JSON.stringify(data, null, 2);
    } catch { json = String(data); }
    if (typeof json !== 'string') json = String(json);
    return json.replace(JSON_TOKEN_RE, (m) => {
      let cls = 'number';
      if (m[0] === '"') cls = /:\s*$/.test(m) ? 'key' : 'string';
      else if (m === 'true' || m === 'false') cls = 'boolean';
      else if (m === 'null') cls = 'null';
      return `<span class="tok-${cls}">${esc(m)}</span>`;
    });
  }

  function parseEvt(e) {
    try { return JSON.parse(e.data); } catch { return null; }
  }

  // Two-step "are you sure?" for destructive buttons — no native confirm().
  function armButton(btn, confirmHtml) {
    if (btn.dataset.armed === 'true') return true;
    btn.dataset.armed = 'true';
    btn.dataset.origHtml = btn.innerHTML;
    btn.classList.add('armed');
    btn.innerHTML = confirmHtml;
    setTimeout(() => {
      if (document.contains(btn) && btn.dataset.armed === 'true') {
        btn.dataset.armed = 'false';
        btn.classList.remove('armed');
        btn.innerHTML = btn.dataset.origHtml;
      }
    }, 2600);
    return false;
  }

  // ------------------------------------------------------------- derived --
  const activeEndpoint = () => state.endpoints.find((e) => e.slug === state.slug) || null;
  const hookUrl = () => (state.slug ? `${location.origin}/h/${state.slug}` : '');

  function bannerCurl() {
    if (!state.slug) return '';
    const payload = JSON.stringify({ event: 'test.ping', message: 'Hello from JanHook!' });
    return [
      `curl -X POST '${hookUrl()}' \\`,
      `  -H 'Content-Type: application/json' \\`,
      `  --data-raw '${payload.replace(/'/g, "'\\''")}'`,
    ].join('\n');
  }

  const SKIP_CURL_HEADERS = new Set(['host', 'content-length', 'connection', 'accept-encoding']);

  function requestCurl(req) {
    const q = (s) => String(s).replace(/'/g, "'\\''");
    const parts = [`curl -X ${req.method} '${location.origin}${req.url}'`];
    for (const [k, v] of Object.entries(req.headers || {})) {
      if (SKIP_CURL_HEADERS.has(k)) continue;
      parts.push(`  -H '${q(k)}: ${q(Array.isArray(v) ? v.join(', ') : v)}'`);
    }
    if (req.rawBody) parts.push(`  --data-raw '${q(req.rawBody)}'`);
    return parts.join(' \\\n');
  }

  // -------------------------------------------------------------- render --
  function renderAll() {
    renderEndpoints();
    renderBanner();
    renderFeed();
    renderDetail();
  }

  function renderEndpoints() {
    const sel = $('#endpointSelect');
    if (state.endpoints.length === 0) {
      sel.innerHTML = '<option value="">No endpoints</option>';
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    sel.innerHTML = state.endpoints
      .map((ep) => {
        const label = ep.name && ep.name !== ep.slug ? `${ep.name} · /h/${ep.slug}` : `/h/${ep.slug}`;
        return `<option value="${esc(ep.slug)}" ${ep.slug === state.slug ? 'selected' : ''}>${esc(label)}</option>`;
      })
      .join('');
  }

  function renderBanner() {
    const ep = activeEndpoint();
    $('#hookUrl').textContent = hookUrl() || '—';
    $('#curlPreview').textContent = bannerCurl() || '—';
    if (ep) {
      $('#respStatus').value = String(ep.response?.status ?? 200);
      $('#respBody').value = ep.response?.body ?? '{"ok":true}';
    }
  }

  function filteredRequests() {
    const f = state.filter.trim().toLowerCase();
    if (!f) return state.requests;
    return state.requests.filter((r) =>
      r.method.toLowerCase().includes(f)
      || (r.url || '').toLowerCase().includes(f)
      || (r.sourceIp || '').toLowerCase().includes(f)
      || (r.rawBody || '').toLowerCase().includes(f)
    );
  }

  function renderFeed() {
    const list = $('#requestList');
    const items = filteredRequests();
    $('#requestCount').textContent = String(state.requests.length);

    if (items.length === 0) {
      list.innerHTML = state.requests.length === 0
        ? `<li class="feed-empty">
             <div class="empty-glyph">⌁</div>
             <p class="empty-title">Waiting for requests…</p>
             <p class="empty-sub">Send any HTTP request to<br><code class="mono">/h/${esc(state.slug || '<slug>')}</code><br>and it will appear here instantly.</p>
           </li>`
        : `<li class="feed-empty">
             <p class="empty-title">No matches</p>
             <p class="empty-sub">Nothing matches “${esc(state.filter)}”.</p>
           </li>`;
      return;
    }

    list.innerHTML = items.map(feedItemHtml).join('');
    for (const r of items) delete r.__fresh;
  }

  function feedItemHtml(r) {
    const cls = `feed-item${r.id === state.selectedId ? ' selected' : ''}${r.__fresh ? ' fresh' : ''}`;
    return `<li class="${cls}" data-id="${esc(r.id)}">
      <div class="feed-line1">
        <span class="method ${methodClass(r.method)}">${esc(r.method)}</span>
        <span class="feed-path mono" title="${esc(r.url)}">${esc(r.url)}</span>
        <span class="feed-time" data-time="${esc(r.receivedAt)}">${relTime(r.receivedAt)}</span>
      </div>
      <div class="feed-line2">
        <span class="muted">${esc(r.sourceIp || 'unknown')}</span>
        <span class="dot-sep">·</span>
        <span>${fmtBytes(r.size)}</span>
        ${r.contentType
          ? `<span class="dot-sep">·</span><span class="muted ct" title="${esc(r.contentType)}">${esc(shortCt(r.contentType))}</span>`
          : ''}
      </div>
    </li>`;
  }

  function kvTableHtml(pairs, keyHead, valHead, sep) {
    if (!pairs || pairs.length === 0) return '<div class="empty-note">Nothing here.</div>';
    const rows = pairs
      .map(([k, v]) => {
        const val = Array.isArray(v) ? v.join(', ') : String(v);
        return `<tr>
          <td class="mono key">${esc(k)}</td>
          <td class="mono val">${esc(val)}</td>
          <td class="td-copy"><button class="icon-btn row-copy" data-k="${esc(k)}" data-v="${esc(val)}" data-sep="${esc(sep)}" title="Copy">${ICON_COPY}</button></td>
        </tr>`;
      })
      .join('');
    return `<table class="kv-table">
      <thead><tr><th>${esc(keyHead)}</th><th>${esc(valHead)}</th><th class="td-copy"></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  function renderDetail() {
    const pane = $('#detailPane');
    const req = state.requests.find((r) => r.id === state.selectedId);
    if (!req) {
      pane.innerHTML = `<div class="detail-empty">
        <div class="empty-glyph lg">⌁</div>
        <p class="empty-title">No request selected</p>
        <p class="empty-sub">Pick a request from the feed, or send a test webhook from the banner above.</p>
      </div>`;
      return;
    }
    if (state.tab === 'query' && !(req.query && req.query.length > 0)) state.tab = 'body';
    pane.innerHTML = detailHtml(req);
  }

  function detailHtml(req) {
    const hasQuery = req.query && req.query.length > 0;
    const tabs = [
      `<button class="tab ${state.tab === 'body' ? 'active' : ''}" data-tab="body">Body</button>`,
      `<button class="tab ${state.tab === 'headers' ? 'active' : ''}" data-tab="headers">Headers <span class="tab-count">${Object.keys(req.headers || {}).length}</span></button>`,
      hasQuery
        ? `<button class="tab ${state.tab === 'query' ? 'active' : ''}" data-tab="query">Query <span class="tab-count">${req.query.length}</span></button>`
        : '',
    ].join('');

    return `
    <div class="detail-summary">
      <div class="ds-top">
        <span class="method lg ${methodClass(req.method)}">${esc(req.method)}</span>
        <span class="ds-url mono" title="${esc(req.url)}">${esc(req.url)}</span>
        <div class="ds-actions">
          <button class="btn btn-ghost sm" id="copyCurlReqBtn" title="Copy this request as a curl command">${ICON_TERM} Copy as cURL</button>
          <button class="btn btn-ghost sm" id="replayBtn" title="Forward this request to another target">${ICON_REPLAY} Replay Request</button>
          <button class="btn btn-danger sm" id="deleteReqBtn" data-armed="false" title="Delete this captured request">${ICON_TRASH} Delete</button>
        </div>
      </div>
      <div class="ds-meta">
        ${req.contentType
          ? `<span class="ct-badge" title="${esc(req.contentType)}">${esc(shortCt(req.contentType))}</span>`
          : '<span class="ct-badge ghost">no content-type</span>'}
        <span class="muted" title="${esc(new Date(req.receivedAt).toString())}">${esc(new Date(req.receivedAt).toISOString())}</span>
        <span class="dot-sep">·</span><span class="muted">${fmtBytes(req.size)}</span>
        <span class="dot-sep">·</span><span class="muted">from ${esc(req.sourceIp || 'unknown')}</span>
      </div>
    </div>
    <div class="tabs">${tabs}</div>
    <div class="tab-body" data-pane="body" ${state.tab !== 'body' ? 'hidden' : ''}>${bodySectionHtml(req)}</div>
    <div class="tab-body" data-pane="headers" ${state.tab !== 'headers' ? 'hidden' : ''}>${headersSectionHtml(req)}</div>
    ${hasQuery ? `<div class="tab-body" data-pane="query" ${state.tab !== 'query' ? 'hidden' : ''}>${querySectionHtml(req)}</div>` : ''}
    `;
  }

  function bodySectionHtml(req) {
    const b = req.body || { type: 'empty', data: null };
    const hasDisplay = b.type !== 'empty' && b.type !== 'binary';

    let content;
    if (b.type === 'empty') {
      content = '<div class="empty-note">No request body.</div>';
    } else if (b.type === 'binary') {
      content = `<div class="empty-note">Binary body (${fmtBytes(req.size)}) — stored as raw bytes, not rendered. Use <strong>Replay</strong> to forward it.</div>`;
    } else if (state.bodyMode === 'raw' || b.type === 'text') {
      content = `<pre class="mono body-pre">${esc(req.rawBody || '')}</pre>`;
    } else if (b.type === 'json') {
      content = `<pre class="mono body-pre">${highlightJSON(b.data)}</pre>`;
    } else if (b.type === 'form') {
      content = kvTableHtml((b.pairs || []).map((p) => [p.key, p.value]), 'Field', 'Value', '=');
    } else {
      content = '<div class="empty-note">No preview available.</div>';
    }

    const controls = hasDisplay
      ? `<div class="seg-toggle" role="group" aria-label="Body view mode">
           <button class="seg ${state.bodyMode === 'pretty' ? 'on' : ''}" data-mode="pretty">Pretty</button>
           <button class="seg ${state.bodyMode === 'raw' ? 'on' : ''}" data-mode="raw">Raw</button>
         </div>`
      : '';
    const copyBtn = hasDisplay
      ? `<button class="btn btn-ghost sm" id="copyBodyBtn">${ICON_COPY} ${b.type === 'json' ? 'Copy JSON' : 'Copy Body'}</button>`
      : '';

    return `<div class="section">
      <div class="section-head">
        <span class="section-title">Body</span>
        ${controls}
        ${copyBtn}
      </div>
      ${content}
    </div>`;
  }

  function headersSectionHtml(req) {
    const rows = Object.entries(req.headers || {});
    return `<div class="section">
      <div class="section-head">
        <span class="section-title">Headers</span>
        <span class="muted small">${rows.length} header${rows.length === 1 ? '' : 's'}</span>
      </div>
      ${kvTableHtml(rows, 'Key', 'Value', ': ')}
    </div>`;
  }

  function querySectionHtml(req) {
    return `<div class="section">
      <div class="section-head">
        <span class="section-title">Query Parameters</span>
        <span class="muted small">${req.query.length} parameter${req.query.length === 1 ? '' : 's'}</span>
      </div>
      ${kvTableHtml(req.query.map((q) => [q.key, q.value]), 'Key', 'Value', '=')}
    </div>`;
  }

  // ------------------------------------------------------------- actions --
  async function loadRequests() {
    if (!state.slug) {
      state.requests = [];
      state.selectedId = null;
      return;
    }
    const { requests } = await api(`/api/endpoints/${state.slug}/requests`);
    state.requests = requests;
    state.selectedId = null;
  }

  async function selectEndpoint(slug) {
    state.slug = slug;
    if (slug) localStorage.setItem('janhook.activeSlug', slug);
    await loadRequests();
    renderAll();
  }

  async function createEndpoint() {
    const { endpoint } = await api('/api/endpoints', { method: 'POST', body: {} });
    state.endpoints.push(endpoint);
    await selectEndpoint(endpoint.slug);
    toast(`Endpoint /h/${endpoint.slug} created`);
  }

  async function deleteEndpoint() {
    const slug = state.slug;
    if (!slug) return;
    await api(`/api/endpoints/${slug}`, { method: 'DELETE' });
    state.endpoints = state.endpoints.filter((e) => e.slug !== slug);
    if (state.slug === slug) {
      state.slug = state.endpoints[0]?.slug || null;
      await loadRequests();
    }
    renderAll();
    toast('Endpoint deleted');
  }

  async function clearRequests() {
    if (!state.slug || state.requests.length === 0) return;
    await api(`/api/endpoints/${state.slug}/requests`, { method: 'DELETE' });
    state.requests = [];
    state.selectedId = null;
    renderFeed();
    renderDetail();
    toast('All captured requests cleared');
  }

  async function deleteRequest(id) {
    if (!state.slug) return;
    await api(`/api/requests/${state.slug}/${id}`, { method: 'DELETE' });
    state.requests = state.requests.filter((r) => r.id !== id);
    if (state.selectedId === id) state.selectedId = null;
    renderFeed();
    renderDetail();
    toast('Request deleted');
  }

  async function saveResponseConfig() {
    const ep = activeEndpoint();
    if (!ep) return;
    const status = Number.parseInt($('#respStatus').value, 10);
    const body = $('#respBody').value.trim();
    if (body) {
      try { JSON.parse(body); } catch {
        toast('Response body is not valid JSON', 'err');
        return;
      }
    }
    const { endpoint } = await api(`/api/endpoints/${state.slug}`, {
      method: 'PATCH',
      body: { response: { status, body } },
    });
    const i = state.endpoints.findIndex((e) => e.slug === endpoint.slug);
    if (i >= 0) state.endpoints[i] = endpoint;
    renderBanner();
    toast(`Response saved — callers will get HTTP ${endpoint.response.status}`);
  }

  async function sendTestWebhook() {
    if (!state.slug) return;
    const payload = {
      event: 'test.ping',
      message: 'Hello from JanHook!',
      sentAt: new Date().toISOString(),
      source: 'janhook-ui',
    };
    try {
      const res = await fetch(`/h/${state.slug}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      toast(`Test webhook sent — HTTP ${res.status}`);
    } catch (err) {
      toast(`Test failed: ${err.message}`, 'err');
    }
  }

  // --------------------------------------------------------------- replay --
  let replayCtx = null;

  function openReplay(req) {
    replayCtx = { slug: req.slug, id: req.id };
    $('#replayTarget').value = localStorage.getItem('janhook.replayTarget') || '';
    $('#replayTarget').placeholder = `${location.origin}/h/${state.slug}`;
    $('#replayResult').hidden = true;
    $('#replayModal').hidden = false;
    $('#replayTarget').focus();
  }

  function closeReplay() {
    $('#replayModal').hidden = true;
    replayCtx = null;
  }

  async function submitReplay() {
    if (!replayCtx) return;
    const target = $('#replayTarget').value.trim();
    if (!target) {
      toast('Enter a target URL', 'err');
      return;
    }
    localStorage.setItem('janhook.replayTarget', target);

    const btn = $('#replaySubmitBtn');
    btn.disabled = true;
    btn.textContent = 'Replaying…';
    try {
      const result = await api('/api/replay', {
        method: 'POST',
        body: { slug: replayCtx.slug, id: replayCtx.id, target },
      });
      const badge = $('#replayStatusBadge');
      badge.className = `replay-status ${statusClass(result.status)}`;
      badge.textContent = `${result.status} ${result.statusText || ''}`.trim();
      $('#replayFinalUrl').textContent = result.finalUrl;
      $('#replayBody').textContent = result.body || '(empty response body)';
      $('#replayResult').hidden = false;
      $('#replayResult').dataset.body = result.body || '';
    } catch (err) {
      const badge = $('#replayStatusBadge');
      badge.className = 'replay-status s5xx';
      badge.textContent = 'Error';
      $('#replayFinalUrl').textContent = '';
      $('#replayBody').textContent = err.message;
      $('#replayResult').hidden = false;
      $('#replayResult').dataset.body = '';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Replay →';
    }
  }

  // ----------------------------------------------------------------- SSE --
  function setStatus(connected) {
    const badge = $('#statusBadge');
    const text = $('#statusText');
    badge.classList.toggle('on', connected);
    badge.classList.toggle('off', !connected);
    text.textContent = connected ? 'Listening' : 'Reconnecting…';
  }

  function connectSSE() {
    const es = new EventSource('/api/events');
    es.onopen = () => setStatus(true);
    es.onerror = () => setStatus(false); // EventSource auto-reconnects

    es.addEventListener('hello', () => setStatus(true));

    es.addEventListener('request', (e) => {
      const data = parseEvt(e);
      if (!data || data.slug !== state.slug) return;
      const { request } = data;
      request.__fresh = true;
      state.requests.unshift(request);
      if (state.requests.length > 1000) state.requests.length = 1000;
      if (!state.selectedId) state.selectedId = request.id;
      renderFeed();
      renderDetail();
    });

    es.addEventListener('requests-cleared', (e) => {
      const data = parseEvt(e);
      if (!data || data.slug !== state.slug) return;
      state.requests = [];
      state.selectedId = null;
      renderFeed();
      renderDetail();
    });

    es.addEventListener('request-deleted', (e) => {
      const data = parseEvt(e);
      if (!data || data.slug !== state.slug) return;
      state.requests = state.requests.filter((r) => r.id !== data.id);
      if (state.selectedId === data.id) state.selectedId = null;
      renderFeed();
      renderDetail();
    });

    es.addEventListener('endpoint-created', (e) => {
      const data = parseEvt(e);
      if (!data || state.endpoints.some((x) => x.slug === data.endpoint.slug)) return;
      state.endpoints.push(data.endpoint);
      renderEndpoints();
    });

    es.addEventListener('endpoint-updated', (e) => {
      const data = parseEvt(e);
      if (!data) return;
      const i = state.endpoints.findIndex((x) => x.slug === data.endpoint.slug);
      if (i >= 0) state.endpoints[i] = data.endpoint;
      if (data.endpoint.slug === state.slug) renderBanner();
    });

    es.addEventListener('endpoint-deleted', async (e) => {
      const data = parseEvt(e);
      if (!data) return;
      state.endpoints = state.endpoints.filter((x) => x.slug !== data.slug);
      if (state.slug === data.slug) {
        state.slug = state.endpoints[0]?.slug || null;
        await loadRequests();
      }
      renderAll();
    });
  }

  // --------------------------------------------------------------- ticks --
  function tickTimes() {
    for (const el of document.querySelectorAll('[data-time]')) {
      el.textContent = relTime(el.dataset.time);
    }
  }

  // -------------------------------------------------------------- wiring --
  function wire() {
    $('#endpointSelect').addEventListener('change', (e) => selectEndpoint(e.target.value));
    $('#newEndpointBtn').addEventListener('click', () => createEndpoint().catch((err) => toast(err.message, 'err')));
    $('#copyUrlBtn').addEventListener('click', () => copyText(hookUrl(), 'Webhook URL copied'));
    $('#copyHookUrlBtn').addEventListener('click', () => copyText(hookUrl(), 'Webhook URL copied'));
    $('#copyCurlBtn').addEventListener('click', () => copyText(bannerCurl(), 'curl command copied'));
    $('#sendTestBtn').addEventListener('click', sendTestWebhook);
    $('#saveRespBtn').addEventListener('click', () => saveResponseConfig().catch((err) => toast(err.message, 'err')));
    $('#deleteEndpointBtn').addEventListener('click', (e) => {
      const btn = e.currentTarget;
      if (!state.slug) return;
      if (!armButton(btn, 'Really delete endpoint?')) return;
      deleteEndpoint().catch((err) => toast(err.message, 'err'));
    });

    $('#filterInput').addEventListener('input', (e) => {
      state.filter = e.target.value;
      renderFeed();
    });

    $('#clearAllBtn').addEventListener('click', (e) => {
      const btn = e.currentTarget;
      if (!armButton(btn, 'Really clear all?')) return;
      clearRequests().catch((err) => toast(err.message, 'err'));
    });

    $('#requestList').addEventListener('click', (e) => {
      const li = e.target.closest('.feed-item');
      if (!li || !li.dataset.id) return;
      state.selectedId = li.dataset.id;
      renderFeed();
      renderDetail();
    });

    $('#detailPane').addEventListener('click', (e) => {
      const req = state.requests.find((r) => r.id === state.selectedId);

      const tab = e.target.closest('.tab');
      if (tab) {
        state.tab = tab.dataset.tab;
        renderDetail();
        return;
      }
      const seg = e.target.closest('.seg');
      if (seg) {
        state.bodyMode = seg.dataset.mode;
        renderDetail();
        return;
      }
      const rowCopy = e.target.closest('.row-copy');
      if (rowCopy) {
        copyText(`${rowCopy.dataset.k}${rowCopy.dataset.sep}${rowCopy.dataset.v}`, 'Copied');
        return;
      }
      if (!req) return;

      if (e.target.closest('#copyBodyBtn')) {
        if (req.body && req.body.type === 'json') copyText(JSON.stringify(req.body.data, null, 2), 'JSON copied');
        else if (req.rawBody) copyText(req.rawBody, 'Body copied');
        else toast('No body to copy', 'err');
        return;
      }
      if (e.target.closest('#copyCurlReqBtn')) {
        copyText(requestCurl(req), 'cURL command copied');
        return;
      }
      if (e.target.closest('#replayBtn')) {
        openReplay(req);
        return;
      }
      const delBtn = e.target.closest('#deleteReqBtn');
      if (delBtn) {
        if (!armButton(delBtn, 'Really delete?')) return;
        deleteRequest(req.id).catch((err) => toast(err.message, 'err'));
      }
    });

    // Replay modal
    $('#replayCloseBtn').addEventListener('click', closeReplay);
    $('#replayCancelBtn').addEventListener('click', closeReplay);
    $('#replaySubmitBtn').addEventListener('click', submitReplay);
    $('#replayTarget').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitReplay();
    });
    $('#replayModal').addEventListener('mousedown', (e) => {
      if (e.target === $('#replayModal')) closeReplay();
    });
    $('#replayCopyBtn').addEventListener('click', () => {
      copyText($('#replayResult').dataset.body || '', 'Response body copied');
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('#replayModal').hidden) closeReplay();
      if (e.key === '/' && !e.ctrlKey && !e.metaKey
          && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) {
        e.preventDefault();
        $('#filterInput').focus();
      }
    });
  }

  // ---------------------------------------------------------------- init --
  async function init() {
    wire();

    let { endpoints } = await api('/api/endpoints');
    state.endpoints = endpoints;

    // Fresh install: create the first endpoint automatically.
    if (state.endpoints.length === 0) {
      const { endpoint } = await api('/api/endpoints', { method: 'POST', body: {} });
      state.endpoints.push(endpoint);
    }

    const saved = localStorage.getItem('janhook.activeSlug');
    state.slug = state.endpoints.some((e) => e.slug === saved)
      ? saved
      : state.endpoints[0].slug;

    await loadRequests();
    renderAll();
    connectSSE();
    setInterval(tickTimes, 5000);
  }

  init().catch((err) => {
    console.error(err);
    setStatus(false);
    toast(`Failed to load: ${err.message}`, 'err');
  });
})();
