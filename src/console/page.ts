import { DASHBOARD_CSP } from '../dashboard/page.js';

/**
 * The operator console (SPEC.md feature 7): `GET /operator`, one self-contained
 * page under the same rules as the dashboard — inline CSS, inline JS, no
 * framework, no build step, no CDN, no web font, nothing fetched from anywhere.
 *
 * The policy is literally the dashboard's, imported rather than retyped. Two
 * copies of a security header are two things that will one day disagree, and
 * the copy that drifts is always the one nobody is looking at.
 *
 * Like the dashboard, this document carries no data and no credential: it is
 * static, and everything it shows it fetches from `/api/operator/*` with the
 * operator bearer a person pastes into it. That is why serving it needs no
 * guard while every route it calls does.
 *
 * Two mechanical constraints on editing the template below: it is a template
 * literal, so the page's own JavaScript uses single quotes and string
 * concatenation — a backtick or a dollar-brace inside it would be read by
 * TypeScript instead of by the browser.
 */

/** The console obeys the dashboard's policy; one definition, two documents. */
export const CONSOLE_CSP = DASHBOARD_CSP;

/** Where the pasted operator bearer lives. Named here so a test can assert on it. */
export const OPERATOR_TOKEN_STORAGE_KEY = 'workmill.operator-token';

export const CONSOLE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>workmill — operator console</title>
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
  textarea { min-height: 70px; resize: vertical; font-family: ui-monospace, monospace; }
  button { width: auto; cursor: pointer; background: #232838; }
  button:hover { background: #2d3446; }
  button.primary { background: var(--run); border-color: var(--run); color: #fff; }
  button.small { padding: 3px 8px; font-size: 12px; }
  button.danger { border-color: var(--bad); color: var(--bad); }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line);
           vertical-align: top; }
  th { color: var(--dim); font-weight: 500; font-size: 12px; }
  tr.picked td { background: #202636; }
  code, pre { font-family: ui-monospace, monospace; font-size: 12px; }
  pre { margin: 0; white-space: pre-wrap; word-break: break-word; color: var(--dim); }
  .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .grow { flex: 1 1 auto; }
  .dim { color: var(--dim); }
  .mono { font-family: ui-monospace, monospace; }
  .num { font-variant-numeric: tabular-nums; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 999px;
          font-size: 11px; border: 1px solid var(--line); color: var(--dim); }
  .pill.ok { color: var(--ok); border-color: var(--ok); }
  .pill.bad { color: var(--bad); border-color: var(--bad); }
  .pill.warn { color: var(--warn); border-color: var(--warn); }
  .grid4 { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px; }
  .stat { border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; }
  .stat .v { font-size: 20px; font-variant-numeric: tabular-nums; }
  .stat .k { font-size: 11px; color: var(--dim); text-transform: uppercase; }
  .err { color: var(--bad); margin-top: 8px; min-height: 18px; font-size: 12px; }
  .ok { color: var(--ok); }
</style>
</head>
<body>
<header>
  <h1>workmill · operator console</h1>
  <span id="conn" class="pill">no token</span>
  <span class="grow"></span>
  <input id="token" type="password" placeholder="operator bearer" style="max-width:320px">
  <button id="connect" class="primary">Connect</button>
</header>

<main>

<section id="fleet" class="wide">
  <h2>Fleet</h2>
  <div class="row" style="margin-bottom:10px">
    <span id="gateway-pill" class="pill">gateway unknown</span>
    <span id="gateway-url" class="dim mono"></span>
  </div>
  <div class="grid4" id="fleet-stats"></div>
</section>

<section id="tenants" class="wide">
  <h2>Tenants</h2>
  <table>
    <thead><tr>
      <th>Slug</th><th>State</th><th>Budget/day</th><th>Conc.</th><th>Items</th>
      <th>Chars</th><th>Models</th><th>Queue</th><th>Dead</th><th>Today</th><th>Support</th><th></th>
    </tr></thead>
    <tbody id="tenants-body"></tbody>
  </table>
  <div id="tenants-err" class="err"></div>
</section>

<section id="provision">
  <h2>Provision a tenant</h2>
  <label for="p-slug">Slug</label>
  <input id="p-slug" placeholder="acme-demo">
  <label for="p-name">Name</label>
  <input id="p-name" placeholder="Acme Demo">
  <label for="p-email">Owner email</label>
  <input id="p-email" placeholder="owner@example.test">
  <label for="p-budget">Daily token budget (optional)</label>
  <input id="p-budget" class="num" placeholder="200000">
  <div class="row" style="margin-top:12px">
    <button id="p-go" class="primary">Provision</button>
  </div>
  <div id="provision-err" class="err"></div>
</section>

<section id="entitlements">
  <h2>Entitlements</h2>
  <div class="dim" id="ent-who">Pick a tenant above.</div>
  <label for="e-budget">Daily token budget</label>
  <input id="e-budget" class="num">
  <label for="e-conc">Max concurrent jobs</label>
  <input id="e-conc" class="num">
  <label for="e-items">Max items per order</label>
  <input id="e-items" class="num">
  <label for="e-chars">Max item characters</label>
  <input id="e-chars" class="num">
  <label for="e-models">Allowed models (comma separated)</label>
  <input id="e-models">
  <div class="row" style="margin-top:12px">
    <button id="e-go" class="primary">Save limits</button>
    <button id="e-suspend">Suspend</button>
    <button id="e-resume">Resume</button>
  </div>
  <div id="entitlements-err" class="err"></div>
</section>

<section id="grants">
  <h2>Support access</h2>
  <div class="dim" id="grants-who">Pick a tenant above.</div>
  <div class="row" style="margin:8px 0"><span id="grant-countdown" class="pill">no live grant</span></div>
  <label for="g-reason">Reason (required, 8 characters or more)</label>
  <textarea id="g-reason" placeholder="Investigating stuck order 4f2c for the tenant"></textarea>
  <label for="g-ttl">Minutes</label>
  <input id="g-ttl" class="num" value="60">
  <div class="row" style="margin-top:12px">
    <button id="g-go" class="primary">Grant access</button>
  </div>
  <div id="grants-err" class="err"></div>
  <table style="margin-top:12px">
    <thead><tr><th>Reason</th><th>By</th><th>Ends</th><th></th></tr></thead>
    <tbody id="grants-body"></tbody>
  </table>
</section>

<section id="audit" class="wide">
  <h2>Audit trail — the tenant can read this too</h2>
  <table>
    <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Detail</th></tr></thead>
    <tbody id="audit-body"></tbody>
  </table>
  <div id="audit-err" class="err"></div>
</section>

</main>

<script>
(function () {
  'use strict';
  var KEY = '${OPERATOR_TOKEN_STORAGE_KEY}';
  var token = '';
  var picked = null;
  var tenants = [];

  function $(id) { return document.getElementById(id); }
  function text(el, s) { el.textContent = s === null || s === undefined ? '' : String(s); }
  function cell(row, s, cls) {
    var td = document.createElement('td');
    td.textContent = s === null || s === undefined ? '' : String(s);
    if (cls) td.className = cls;
    row.appendChild(td);
    return td;
  }

  function api(path, method, body) {
    var opts = { method: method || 'GET', headers: { accept: 'application/json' } };
    if (token) opts.headers.authorization = 'Bearer ' + token;
    if (body !== undefined) {
      opts.headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (b) {
        return { status: r.status, ok: r.ok, body: b };
      });
    });
  }

  function fail(el, res) {
    var b = res.body || {};
    text(el, 'HTTP ' + res.status + ' — ' + (b.message || b.reason || b.error || 'failed'));
  }

  function plural(n, one) { return n + ' ' + one + (n === 1 ? '' : 's'); }

  function countdown(ms) {
    if (!ms || ms <= 0) return 'expired';
    var mins = Math.floor(ms / 60000);
    if (mins < 60) return plural(mins, 'minute') + ' left';
    return plural(Math.floor(mins / 60), 'hour') + ' ' + (mins % 60) + 'm left';
  }

  function setConnected(ok, note) {
    var pill = $('conn');
    pill.className = 'pill ' + (ok ? 'ok' : 'bad');
    text(pill, note);
  }

  function loadFleet() {
    return api('/api/operator/fleet').then(function (res) {
      if (!res.ok) { setConnected(false, 'HTTP ' + res.status); return; }
      setConnected(true, 'connected');
      var f = res.body;
      var g = f.gateway || {};
      var pill = $('gateway-pill');
      pill.className = 'pill ' + (g.reachable ? 'ok' : 'bad');
      text(pill, g.reachable ? 'gateway up · ' + g.latencyMs + 'ms' : 'gateway down · ' + (g.error || '?'));
      text($('gateway-url'), g.baseUrl || 'no gateway configured');
      var q = f.queue || {}, t = f.throughput || {}, n = f.tenants || {};
      var stats = [
        ['pending', q.pending], ['running', q.running], ['dead', q.dead],
        ['oldest wait (s)', q.oldestPendingSeconds],
        ['jobs / hour', t.jobsLastHour], ['ok / hour', t.succeededLastHour],
        ['failed / hour', t.failedLastHour], ['tokens today', t.tokensToday],
        ['tenants', n.total], ['suspended', n.suspended], ['support open', n.withActiveGrant]
      ];
      var host = $('fleet-stats');
      host.innerHTML = '';
      for (var i = 0; i < stats.length; i++) {
        var box = document.createElement('div');
        box.className = 'stat';
        var v = document.createElement('div');
        v.className = 'v';
        v.textContent = String(stats[i][1] === undefined ? 0 : stats[i][1]);
        var k = document.createElement('div');
        k.className = 'k';
        k.textContent = stats[i][0];
        box.appendChild(v); box.appendChild(k); host.appendChild(box);
      }
    });
  }

  function loadTenants() {
    return api('/api/operator/tenants').then(function (res) {
      if (!res.ok) { fail($('tenants-err'), res); return; }
      text($('tenants-err'), '');
      tenants = res.body.tenants || [];
      var body = $('tenants-body');
      body.innerHTML = '';
      for (var i = 0; i < tenants.length; i++) {
        (function (t) {
          var tr = document.createElement('tr');
          if (picked && picked.tenantId === t.tenantId) tr.className = 'picked';
          var lim = t.limits || {};
          cell(tr, t.slug, 'mono');
          cell(tr, t.state, t.state === 'active' ? 'ok' : 'dim');
          cell(tr, lim.dailyTokenBudget, 'num');
          cell(tr, lim.maxConcurrentJobs, 'num');
          cell(tr, lim.maxItemsPerOrder, 'num');
          cell(tr, lim.maxItemChars, 'num');
          cell(tr, (lim.allowedModels || []).join(', '), 'mono dim');
          cell(tr, t.pendingJobs + '/' + t.runningJobs, 'num');
          cell(tr, t.deadJobs, 'num');
          cell(tr, t.tokensToday, 'num');
          cell(tr, t.supportActive ? 'open' : '—', t.supportActive ? 'warn' : 'dim');
          var pick = document.createElement('button');
          pick.className = 'small';
          pick.textContent = 'Manage';
          pick.addEventListener('click', function () { choose(t); });
          var td = document.createElement('td');
          td.appendChild(pick);
          tr.appendChild(td);
          body.appendChild(tr);
        })(tenants[i]);
      }
    });
  }

  function choose(t) {
    picked = t;
    var lim = t.limits || {};
    text($('ent-who'), 'Editing ' + t.slug);
    text($('grants-who'), 'Support access to ' + t.slug);
    $('e-budget').value = lim.dailyTokenBudget === undefined ? '' : lim.dailyTokenBudget;
    $('e-conc').value = lim.maxConcurrentJobs === undefined ? '' : lim.maxConcurrentJobs;
    $('e-items').value = lim.maxItemsPerOrder === undefined ? '' : lim.maxItemsPerOrder;
    $('e-chars').value = lim.maxItemChars === undefined ? '' : lim.maxItemChars;
    $('e-models').value = (lim.allowedModels || []).join(', ');
    loadTenants();
    loadGrants();
    loadAudit();
  }

  function needTenant(el) {
    if (picked) return true;
    text(el, 'Pick a tenant first.');
    return false;
  }

  function num(id) {
    var raw = $(id).value.trim();
    if (raw === '') return undefined;
    var n = Number(raw);
    return isFinite(n) ? Math.floor(n) : undefined;
  }

  function loadGrants() {
    if (!picked) return Promise.resolve();
    return api('/api/operator/tenants/' + picked.tenantId + '/grants').then(function (res) {
      if (!res.ok) { fail($('grants-err'), res); return; }
      var active = res.body.active;
      var pill = $('grant-countdown');
      pill.className = 'pill ' + (active ? 'warn' : '');
      text(pill, active ? 'access open · ' + countdown(active.remainingMs) : 'no live grant');
      var rows = res.body.grants || [];
      var body = $('grants-body');
      body.innerHTML = '';
      for (var i = 0; i < rows.length; i++) {
        (function (g) {
          var tr = document.createElement('tr');
          cell(tr, g.reason);
          cell(tr, g.grantedBy, 'dim');
          cell(tr, g.active ? countdown(g.remainingMs) : (g.revokedAt ? 'revoked' : 'expired'),
               g.active ? 'warn' : 'dim');
          var td = document.createElement('td');
          if (g.active) {
            var b = document.createElement('button');
            b.className = 'small danger';
            b.textContent = 'Revoke';
            b.addEventListener('click', function () {
              api('/api/operator/tenants/' + picked.tenantId + '/grants/' + g.id + '/revoke', 'POST', {})
                .then(function (r) {
                  if (!r.ok) { fail($('grants-err'), r); return; }
                  text($('grants-err'), '');
                  loadGrants(); loadAudit(); loadTenants();
                });
            });
            td.appendChild(b);
          }
          tr.appendChild(td);
          body.appendChild(tr);
        })(rows[i]);
      }
    });
  }

  function loadAudit() {
    if (!picked) return Promise.resolve();
    return api('/api/operator/tenants/' + picked.tenantId + '/audit').then(function (res) {
      if (!res.ok) { fail($('audit-err'), res); return; }
      text($('audit-err'), '');
      var rows = res.body.entries || [];
      var body = $('audit-body');
      body.innerHTML = '';
      for (var i = 0; i < rows.length; i++) {
        var tr = document.createElement('tr');
        cell(tr, new Date(rows[i].at).toISOString().replace('T', ' ').slice(0, 19), 'mono dim');
        cell(tr, rows[i].actor);
        cell(tr, rows[i].action, 'mono');
        cell(tr, JSON.stringify(rows[i].detail), 'mono dim');
        body.appendChild(tr);
      }
    });
  }

  function refresh() {
    if (!token) return;
    loadFleet();
    loadTenants();
    loadGrants();
    loadAudit();
  }

  $('connect').addEventListener('click', function () {
    token = $('token').value.trim();
    try { localStorage.setItem(KEY, token); } catch (e) { /* private mode */ }
    refresh();
  });

  $('p-go').addEventListener('click', function () {
    var budget = num('p-budget');
    var body = {
      slug: $('p-slug').value.trim(),
      name: $('p-name').value.trim(),
      ownerEmail: $('p-email').value.trim()
    };
    if (budget !== undefined) body.entitlements = { dailyTokenBudget: budget };
    api('/api/operator/tenants', 'POST', body).then(function (res) {
      if (!res.ok) { fail($('provision-err'), res); return; }
      text($('provision-err'), '');
      $('p-slug').value = ''; $('p-name').value = ''; $('p-email').value = '';
      loadTenants();
    });
  });

  $('e-go').addEventListener('click', function () {
    if (!needTenant($('entitlements-err'))) return;
    var patch = {};
    var b = num('e-budget'); if (b !== undefined) patch.dailyTokenBudget = b;
    var c = num('e-conc'); if (c !== undefined) patch.maxConcurrentJobs = c;
    var it = num('e-items'); if (it !== undefined) patch.maxItemsPerOrder = it;
    var ch = num('e-chars'); if (ch !== undefined) patch.maxItemChars = ch;
    var models = $('e-models').value.split(',').map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; });
    if (models.length > 0) patch.allowedModels = models;
    api('/api/operator/tenants/' + picked.tenantId + '/entitlements', 'POST', patch)
      .then(function (res) {
        if (!res.ok) { fail($('entitlements-err'), res); return; }
        text($('entitlements-err'), '');
        loadTenants(); loadAudit();
      });
  });

  function setState(state) {
    if (!needTenant($('entitlements-err'))) return;
    api('/api/operator/tenants/' + picked.tenantId + '/state', 'POST', { state: state })
      .then(function (res) {
        if (!res.ok) { fail($('entitlements-err'), res); return; }
        text($('entitlements-err'), '');
        loadTenants(); loadAudit();
      });
  }
  $('e-suspend').addEventListener('click', function () { setState('suspended'); });
  $('e-resume').addEventListener('click', function () { setState('active'); });

  $('g-go').addEventListener('click', function () {
    if (!needTenant($('grants-err'))) return;
    var minutes = num('g-ttl');
    var body = { reason: $('g-reason').value, grantedBy: 'operator' };
    if (minutes !== undefined) body.ttlMs = minutes * 60000;
    api('/api/operator/tenants/' + picked.tenantId + '/grants', 'POST', body).then(function (res) {
      if (!res.ok) { fail($('grants-err'), res); return; }
      text($('grants-err'), '');
      $('g-reason').value = '';
      loadGrants(); loadAudit(); loadTenants();
    });
  });

  try {
    var saved = localStorage.getItem(KEY);
    if (saved) { token = saved; $('token').value = saved; }
  } catch (e) { /* private mode */ }

  // The countdown is the one thing that changes without anyone doing anything,
  // so the page re-reads itself on a timer rather than pretending it is live.
  setInterval(refresh, 10000);
  refresh();
})();
</script>
</body>
</html>
`;
