/**
 * The tenant dashboard (SPEC.md feature 6): `GET /`, one self-contained page.
 *
 * The whole document is this file's single exported string — inline CSS, inline
 * JS, no framework, no build step, no CDN, no web font, no image fetched from
 * anywhere. That is a spec rule rather than a taste: a page that pulls one
 * script from a CDN is a page that stops working on the air-gapped box this
 * product is meant to run on, and it is a third party watching a tenant's work.
 * `Content-Security-Policy` on the response makes the rule the browser's to
 * enforce, not the reviewer's to remember.
 *
 * It is served as a static document with no bearer: it contains no tenant data.
 * Everything it shows it fetches from `/api/*` with a token the operator minted
 * and the person pasted, held in `localStorage`. SPEC.md's non-goals fence out
 * SSO and password reset — auth here is a seam, and this is the smallest thing
 * that honestly is one.
 *
 * Two constraints on editing the template below, both mechanical: it is a
 * template literal, so the page's own JavaScript uses string concatenation and
 * single quotes — a backtick or a dollar-brace inside it would be read by
 * TypeScript instead of by the browser.
 */

/** The policy that turns "no external requests" from a promise into a refusal. */
export const DASHBOARD_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "img-src data:",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "connect-src 'self'",
].join('; ');

/** Where the pasted bearer lives. Named here so a test can assert on it. */
export const TOKEN_STORAGE_KEY = 'workmill.token';

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>workmill — dashboard</title>
<style>
  :root {
    --bg: #12141a; --panel: #1a1d26; --line: #2b303d; --ink: #e6e8ef;
    --dim: #949bb0; --ok: #4ea88a; --warn: #d9a441; --bad: #d2685f;
    --run: #5b8dd9; --idle: #4a4f60;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  }
  header {
    display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
    padding: 14px 20px; border-bottom: 1px solid var(--line); background: var(--panel);
  }
  h1 { font-size: 16px; margin: 0; letter-spacing: 0.5px; }
  h2 { font-size: 13px; margin: 0 0 10px; color: var(--dim);
       text-transform: uppercase; letter-spacing: 1px; }
  main { padding: 20px; display: grid; gap: 20px;
         grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); }
  section { background: var(--panel); border: 1px solid var(--line);
            border-radius: 8px; padding: 16px; }
  section.wide { grid-column: 1 / -1; }
  label { display: block; font-size: 12px; color: var(--dim); margin: 10px 0 4px; }
  input, select, textarea, button {
    font: inherit; color: var(--ink); background: #0e1016;
    border: 1px solid var(--line); border-radius: 6px; padding: 7px 9px; width: 100%;
  }
  textarea { min-height: 120px; resize: vertical; font-family: ui-monospace, monospace; }
  button { width: auto; cursor: pointer; background: #232838; }
  button:hover { background: #2d3446; }
  button.primary { background: var(--run); border-color: var(--run); color: #fff; }
  button.small { padding: 3px 8px; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line);
           vertical-align: top; }
  th { color: var(--dim); font-weight: 500; font-size: 12px; }
  code, pre { font-family: ui-monospace, monospace; font-size: 12px; }
  pre { margin: 0; white-space: pre-wrap; word-break: break-word; color: var(--dim); }
  .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .grow { flex: 1 1 auto; }
  .dim { color: var(--dim); }
  .mono { font-family: ui-monospace, monospace; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 999px;
          font-size: 11px; border: 1px solid var(--line); color: var(--dim); }
  .pill.live { color: var(--ok); border-color: var(--ok); }
  .pill.off { color: var(--bad); border-color: var(--bad); }
  .bar { display: flex; height: 10px; border-radius: 5px; overflow: hidden;
         background: var(--idle); }
  .bar > span { display: block; height: 100%; }
  .seg-succeeded { background: var(--ok); }
  .seg-running { background: var(--run); }
  .seg-failed { background: var(--warn); }
  .seg-dead { background: var(--bad); }
  .seg-cancelled { background: #6b7183; }
  .meter { height: 14px; border-radius: 7px; background: var(--idle); overflow: hidden; }
  .meter > span { display: block; height: 100%; background: var(--ok); }
  .meter.hot > span { background: var(--bad); }
  .days { display: flex; align-items: flex-end; gap: 3px; height: 44px; margin-top: 10px; }
  .days > span { flex: 1 1 0; background: var(--run); min-height: 2px; border-radius: 2px; }
  .note { font-size: 12px; margin-top: 8px; min-height: 18px; }
  .note.bad { color: var(--bad); }
  .note.ok { color: var(--ok); }
  .empty { color: var(--dim); font-size: 13px; padding: 6px 0; }
  details > summary { cursor: pointer; color: var(--dim); font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>workmill</h1>
  <span id="who" class="dim">not connected</span>
  <span id="live" class="pill off">offline</span>
  <span class="grow"></span>
  <input id="token" type="password" placeholder="paste tenant token"
         autocomplete="off" style="width: 260px">
  <button id="connect" class="primary">connect</button>
  <button id="forget">forget</button>
</header>

<main>
  <section id="usage-panel">
    <h2>Usage today</h2>
    <div class="row"><strong id="usage-used">—</strong>
      <span class="dim">of</span><strong id="usage-budget">—</strong>
      <span class="dim">tokens</span><span class="grow"></span>
      <span id="usage-left" class="dim"></span></div>
    <div class="meter" id="usage-meter"><span style="width:0%"></span></div>
    <div class="days" id="usage-days"></div>
    <div class="note dim" id="usage-note"></div>
  </section>

  <section id="workflows-panel">
    <h2>Workflows</h2>
    <table><tbody id="workflows"></tbody></table>
    <div class="empty" id="workflows-empty">nothing loaded yet</div>
  </section>

  <section class="wide" id="submit-panel">
    <h2>Submit a work order</h2>
    <div class="row">
      <div class="grow">
        <label for="submit-workflow">workflow</label>
        <select id="submit-workflow"></select>
      </div>
      <div style="width: 150px">
        <label for="csv-column">CSV column (blank = whole line)</label>
        <input id="csv-column" type="number" min="1" placeholder="—">
      </div>
    </div>
    <label for="submit-items">items — one per line</label>
    <textarea id="submit-items" spellcheck="false"
              placeholder="one item per line"></textarea>
    <div class="row" style="margin-top:10px">
      <button id="submit" class="primary">submit order</button>
      <span id="submit-count" class="dim"></span>
    </div>
    <div class="note" id="submit-note"></div>
  </section>

  <section class="wide" id="orders-panel">
    <h2>Orders</h2>
    <table>
      <thead><tr>
        <th>workflow</th><th>state</th><th style="width:30%">progress</th>
        <th>items</th><th>tokens</th><th>submitted</th><th></th>
      </tr></thead>
      <tbody id="orders"></tbody>
    </table>
    <div class="empty" id="orders-empty">nothing loaded yet</div>
  </section>

  <section class="wide" id="detail-panel" hidden>
    <h2>Order items</h2>
    <div class="row">
      <span id="detail-title" class="mono dim"></span>
      <span class="grow"></span>
      <button id="download" class="small">download validated JSON</button>
      <button id="detail-close" class="small">close</button>
    </div>
    <table>
      <thead><tr>
        <th>#</th><th>state</th><th style="width:30%">input</th>
        <th style="width:40%">output</th><th>tokens</th>
      </tr></thead>
      <tbody id="detail-items"></tbody>
    </table>
  </section>

  <section class="wide" id="dead-panel">
    <h2>Dead letter</h2>
    <table>
      <thead><tr>
        <th>workflow</th><th>#</th><th>attempts</th><th>last error</th>
        <th>input</th><th></th>
      </tr></thead>
      <tbody id="dead"></tbody>
    </table>
    <div class="empty" id="dead-empty">nothing dead — good</div>
  </section>
</main>

<script>
(function () {
  'use strict';

  var STORAGE_KEY = '${TOKEN_STORAGE_KEY}';
  var POLL_MS = 5000;
  var token = '';
  var openOrderId = null;
  var refreshTimer = null;

  function $(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function note(id, message, kind) {
    var box = $(id);
    box.textContent = message || '';
    box.className = 'note' + (kind ? ' ' + kind : ' dim');
  }

  function headers() {
    return token ? { authorization: 'Bearer ' + token } : {};
  }

  function api(path, options) {
    var opts = options || {};
    var init = { method: opts.method || 'GET', headers: headers() };
    if (opts.body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    return fetch(path, init).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        return { ok: res.ok, status: res.status, body: body };
      });
    });
  }

  // ── the token seam ────────────────────────────────────────────────
  function connect(next) {
    token = next.trim();
    if (token) {
      try { localStorage.setItem(STORAGE_KEY, token); } catch (e) { /* private mode */ }
    }
    refreshAll();
    stream();
  }

  function forget() {
    token = '';
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* private mode */ }
    $('token').value = '';
    $('who').textContent = 'not connected';
    setLive(false, 'offline');
    $('orders').innerHTML = '';
    $('workflows').innerHTML = '';
    $('dead').innerHTML = '';
    $('detail-panel').hidden = true;
  }

  function setLive(on, label) {
    var pill = $('live');
    pill.textContent = label;
    pill.className = 'pill ' + (on ? 'live' : 'off');
  }

  // ── panels ────────────────────────────────────────────────────────
  function loadMe() {
    return api('/api/me').then(function (r) {
      if (!r.ok) {
        $('who').textContent = r.status === 401 ? 'token rejected' : 'error ' + r.status;
        setLive(false, 'offline');
        return false;
      }
      $('who').textContent = (r.body.name || r.body.slug || 'tenant');
      return true;
    });
  }

  function loadUsage() {
    return api('/api/usage').then(function (r) {
      if (!r.ok) return;
      var budget = r.body.budget || {};
      var used = budget.used || 0;
      $('usage-used').textContent = used.toLocaleString();
      $('usage-budget').textContent =
        budget.budget === null || budget.budget === undefined
          ? 'no limit' : Number(budget.budget).toLocaleString();
      var pct = budget.budget ? Math.min(100, (used / budget.budget) * 100) : 0;
      var meter = $('usage-meter');
      meter.className = 'meter' + (budget.exhausted ? ' hot' : '');
      meter.firstChild.setAttribute('style', 'width:' + pct.toFixed(1) + '%');
      $('usage-left').textContent =
        budget.remaining === null || budget.remaining === undefined
          ? '' : Number(budget.remaining).toLocaleString() + ' left';
      note('usage-note', budget.exhausted
        ? 'daily budget spent — the queue refuses new claims until UTC midnight'
        : '', budget.exhausted ? 'bad' : '');
      var days = r.body.byDay || [];
      var peak = 1;
      days.forEach(function (d) { peak = Math.max(peak, d.totalTokens || 0); });
      var strip = $('usage-days');
      strip.innerHTML = '';
      days.forEach(function (d) {
        var bar = el('span');
        var h = Math.max(2, Math.round(((d.totalTokens || 0) / peak) * 44));
        bar.setAttribute('style', 'height:' + h + 'px');
        bar.title = d.day + ' — ' + (d.totalTokens || 0) + ' tokens';
        strip.appendChild(bar);
      });
    });
  }

  function loadWorkflows() {
    return api('/api/workflows').then(function (r) {
      if (!r.ok) return;
      var list = r.body.workflows || [];
      var body = $('workflows');
      var select = $('submit-workflow');
      var chosen = select.value;
      body.innerHTML = '';
      select.innerHTML = '';
      list.forEach(function (w) {
        var tr = el('tr');
        var first = el('td');
        first.appendChild(el('div', null, w.name));
        first.appendChild(el('div', 'dim mono', w.slug + ' · v' + w.version));
        tr.appendChild(first);
        tr.appendChild(el('td', 'mono dim', w.model));
        body.appendChild(tr);
        var option = el('option', null, w.name + ' (v' + w.version + ')');
        option.value = w.workflowId;
        select.appendChild(option);
      });
      if (chosen) select.value = chosen;
      $('workflows-empty').hidden = list.length > 0;
    });
  }

  function progressBar(counts, total) {
    var bar = el('div', 'bar');
    ['succeeded', 'running', 'failed', 'dead', 'cancelled'].forEach(function (state) {
      var n = counts[state] || 0;
      if (!n) return;
      var seg = el('span', 'seg-' + state);
      seg.setAttribute('style', 'width:' + ((n / Math.max(1, total)) * 100) + '%');
      seg.title = n + ' ' + state;
      bar.appendChild(seg);
    });
    return bar;
  }

  function loadOrders() {
    return api('/api/orders').then(function (r) {
      if (!r.ok) return;
      var orders = r.body.orders || [];
      var body = $('orders');
      body.innerHTML = '';
      orders.forEach(function (o) {
        var tr = el('tr');
        var name = el('td');
        name.appendChild(el('div', null, o.workflowName));
        name.appendChild(el('div', 'dim mono', o.workflowSlug + ' · v' + o.version));
        tr.appendChild(name);
        var state = el('td');
        state.appendChild(el('span', 'pill', o.state));
        if (o.blockedReason) {
          state.appendChild(el('div', 'dim', o.blockedReason));
        }
        tr.appendChild(state);
        var progress = el('td');
        progress.appendChild(progressBar(o.counts, o.itemCount));
        progress.appendChild(el('div', 'dim', o.finished + ' / ' + o.itemCount + ' done'));
        tr.appendChild(progress);
        tr.appendChild(el('td', null, o.itemCount));
        tr.appendChild(el('td', 'mono', o.totalTokens));
        tr.appendChild(el('td', 'dim', new Date(o.createdAt).toLocaleString()));
        var actions = el('td');
        var open = el('button', 'small', 'items');
        open.addEventListener('click', function () { openOrder(o.orderId); });
        actions.appendChild(open);
        if (o.state === 'open') {
          var stop = el('button', 'small', 'cancel');
          stop.addEventListener('click', function () { cancelOrder(o.orderId); });
          actions.appendChild(stop);
        }
        tr.appendChild(actions);
        body.appendChild(tr);
      });
      $('orders-empty').hidden = orders.length > 0;
      if (!orders.length) $('orders-empty').textContent = 'no orders yet';
    });
  }

  function openOrder(orderId) {
    openOrderId = orderId;
    return loadDetail();
  }

  function loadDetail() {
    if (!openOrderId) return Promise.resolve();
    return api('/api/orders/' + openOrderId).then(function (r) {
      if (!r.ok) { $('detail-panel').hidden = true; openOrderId = null; return; }
      var order = r.body.order;
      var items = r.body.items || [];
      $('detail-panel').hidden = false;
      $('detail-title').textContent =
        order.workflowSlug + ' v' + order.version + ' · ' + order.orderId;
      var body = $('detail-items');
      body.innerHTML = '';
      items.forEach(function (item) {
        var tr = el('tr');
        tr.appendChild(el('td', 'mono', item.idx));
        var state = el('td');
        state.appendChild(el('span', 'pill', item.state));
        if (item.attempts > 1) state.appendChild(el('div', 'dim', item.attempts + ' attempts'));
        tr.appendChild(state);
        var input = el('td');
        input.appendChild(el('pre', null, item.inputPreview));
        tr.appendChild(input);
        var output = el('td');
        if (item.ok === true) {
          output.appendChild(el('pre', null, JSON.stringify(item.output, null, 2)));
        } else if (item.failureReason) {
          output.appendChild(el('div', 'dim', item.failureReason));
          if (item.errors && item.errors.length) {
            output.appendChild(el('pre', null, item.errors.join('\\n')));
          }
        } else if (item.lastError) {
          output.appendChild(el('pre', null, item.lastError));
        }
        tr.appendChild(output);
        tr.appendChild(el('td', 'mono', item.totalTokens));
        body.appendChild(tr);
      });
    });
  }

  function download() {
    if (!openOrderId) return;
    fetch('/api/orders/' + openOrderId + '/results.json', { headers: headers() })
      .then(function (res) { return res.ok ? res.blob() : null; })
      .then(function (blob) {
        if (!blob) return;
        var url = URL.createObjectURL(blob);
        var link = el('a');
        link.href = url;
        link.download = 'workmill-order-' + openOrderId + '.json';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      });
  }

  function cancelOrder(orderId) {
    api('/api/orders/' + orderId + '/cancel', { method: 'POST' }).then(refreshAll);
  }

  function loadDead() {
    return api('/api/dead').then(function (r) {
      if (!r.ok) return;
      var jobs = r.body.jobs || [];
      var body = $('dead');
      body.innerHTML = '';
      jobs.forEach(function (job) {
        var tr = el('tr');
        tr.appendChild(el('td', 'mono', job.workflowSlug));
        tr.appendChild(el('td', 'mono', job.idx));
        tr.appendChild(el('td', 'mono', job.attempts));
        tr.appendChild(el('td', 'dim', job.lastError || ''));
        var input = el('td');
        input.appendChild(el('pre', null, job.inputPreview));
        tr.appendChild(input);
        var actions = el('td');
        var again = el('button', 'small', 'requeue');
        again.addEventListener('click', function () {
          api('/api/jobs/' + job.jobId + '/requeue', { method: 'POST' }).then(refreshAll);
        });
        actions.appendChild(again);
        tr.appendChild(actions);
        body.appendChild(tr);
      });
      $('dead-empty').hidden = jobs.length > 0;
    });
  }

  // ── submit ────────────────────────────────────────────────────────
  function splitCsvLine(line) {
    var out = [];
    var field = '';
    var quoted = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line.charAt(i);
      if (quoted) {
        if (ch === '"' && line.charAt(i + 1) === '"') { field += '"'; i++; }
        else if (ch === '"') { quoted = false; }
        else { field += ch; }
      } else if (ch === '"') { quoted = true; }
      else if (ch === ',') { out.push(field); field = ''; }
      else { field += ch; }
    }
    out.push(field);
    return out;
  }

  function readItems() {
    var raw = $('submit-items').value.split('\\n');
    var column = parseInt($('csv-column').value, 10);
    var items = [];
    raw.forEach(function (line) {
      var value = line;
      if (column >= 1) {
        var cells = splitCsvLine(line);
        value = cells.length >= column ? cells[column - 1] : '';
      }
      value = value.trim();
      if (value) items.push(value);
    });
    return items;
  }

  function submit() {
    var items = readItems();
    var workflowId = $('submit-workflow').value;
    if (!workflowId) { note('submit-note', 'pick a workflow first', 'bad'); return; }
    if (!items.length) { note('submit-note', 'no items to submit', 'bad'); return; }
    note('submit-note', 'submitting ' + items.length + ' items…');
    api('/api/orders', { method: 'POST', body: { workflowId: workflowId, items: items } })
      .then(function (r) {
        if (r.ok) {
          note('submit-note', 'order ' + r.body.orderId + ' — ' +
            r.body.itemCount + ' items pinned to v' + r.body.version, 'ok');
          $('submit-items').value = '';
          updateCount();
          refreshAll();
        } else if (r.body.reason) {
          note('submit-note', 'refused: ' + r.body.reason + ' — ' + (r.body.message || ''), 'bad');
        } else {
          note('submit-note', 'refused (' + r.status + ') ' + (r.body.message || ''), 'bad');
        }
      });
  }

  function updateCount() {
    var n = readItems().length;
    $('submit-count').textContent = n ? n + ' items' : '';
  }

  // ── liveness ──────────────────────────────────────────────────────
  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(function () {
      refreshTimer = null;
      refreshAll();
    }, 400);
  }

  /**
   * The live stream, read with fetch rather than EventSource: EventSource
   * cannot send an Authorization header, and putting a bearer in a query
   * string would write it into every access log between here and the box.
   */
  function stream() {
    if (!token) return;
    var mine = token;
    fetch('/events', { headers: headers() }).then(function (res) {
      if (!res.ok || !res.body) { setLive(false, 'polling'); return; }
      setLive(true, 'live');
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';
      function pump() {
        return reader.read().then(function (chunk) {
          if (chunk.done) { setLive(false, 'reconnecting'); retry(mine); return; }
          buffer += decoder.decode(chunk.value, { stream: true });
          var split = buffer.indexOf('\\n\\n');
          while (split !== -1) {
            var frame = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            if (frame.indexOf('data: ') !== -1) scheduleRefresh();
            split = buffer.indexOf('\\n\\n');
          }
          return pump();
        });
      }
      return pump();
    }).catch(function () { setLive(false, 'reconnecting'); retry(mine); });
  }

  function retry(mine) {
    setTimeout(function () { if (token === mine) stream(); }, 3000);
  }

  function refreshAll() {
    if (!token) return Promise.resolve();
    return loadMe().then(function (ok) {
      if (!ok) return;
      return Promise.all([loadUsage(), loadWorkflows(), loadOrders(), loadDead(), loadDetail()]);
    });
  }

  // ── wiring ────────────────────────────────────────────────────────
  $('connect').addEventListener('click', function () { connect($('token').value); });
  $('forget').addEventListener('click', forget);
  $('submit').addEventListener('click', submit);
  $('submit-items').addEventListener('input', updateCount);
  $('csv-column').addEventListener('input', updateCount);
  $('detail-close').addEventListener('click', function () {
    openOrderId = null;
    $('detail-panel').hidden = true;
  });
  $('download').addEventListener('click', download);
  $('token').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') connect($('token').value);
  });

  var saved = '';
  try { saved = localStorage.getItem(STORAGE_KEY) || ''; } catch (e) { saved = ''; }
  if (saved) { $('token').value = saved; connect(saved); }

  setInterval(function () { if (token) refreshAll(); }, POLL_MS);
})();
</script>
</body>
</html>
`;
