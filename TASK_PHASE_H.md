# Phase H — the tenant dashboard

**ROADMAP row:** #6 *Tenant dashboard (self-contained page)*, currently NOT BUILT.
Seven phases of library code and one ops surface arrive here: this is the page a
stranger opens. One HTML document, one JSON API behind the tenant bearer, and
the panels SPEC.md feature 6 names — workflows, submit, orders with live
progress, results with a download, the usage meter, the dead letter.

**Already committed (do not rebuild):** `src/dashboard/queries.ts` (the three
read models), `src/server/api.ts` (`/api/*` behind the tenant bearer),
`src/dashboard/page.ts` (`DASHBOARD_HTML`, `DASHBOARD_CSP`,
`TOKEN_STORAGE_KEY`), `src/server/guards.ts`, the `GET /` route and the
`registerTenantApi` call in `src/server/app.ts`, and four new methods on
`test/helpers/server.ts`. Sections §H1–§H2 are those commits; the tasks below
start at §H3. **Every task below writes tests or docs — no task in this phase
needs you to write new `src/` code.**

**Gate for every task below** (all three, always):
`pnpm typecheck` && `pnpm test` && `bash scripts/scrub-check.sh`.

**Eight facts that will cost you a red gate if you guess them wrong:**

1. **`provisionTenant` is the right helper this phase, not `makeTenant`.** The
   API reads entitlements and the budget, and a bare tenant has neither.
   `provisionTenant(db, { slug, name, ownerEmail })` returns `{ tenantId, … }`;
   pass `entitlements: { maxItemsPerOrder: 2 }` to override one limit.
2. **Start a real server.** `startTestServer(db, options?)` from
   `test/helpers/server.ts` returns `{ url, app, opsLog, get, post, getJson,
   postJson, close }`. `getJson(path, token?)` and `postJson(path, body, token?)`
   answer `{ status, ok, body, headers }` with the body already parsed. Always
   `await server.close()` and `await db.close()` in `afterAll`.
3. **A tenant bearer comes from `mintTestToken(db, tenantId)`** — the raw token,
   and that call is the only place it exists.
4. **Seeding is one line.** `withTenant(db, tenantId, (sql) =>
   seedExampleWorkflows(sql))` from `src/workflows/examples.js` returns
   `[{ workflowId, slug }]` for the three examples. That is the fastest way to
   get a workflow you can submit against.
5. **A submit answers 201, not 200**, with a body of
   `{ orderId, itemCount, workflowVersionId, version }`.
6. **The three refusal codes ARE the assertion.** 400 = malformed body,
   404 = no such workflow / order / job, 422 = entitlement refused, carrying a
   `reason` of `too-many-items`, `item-too-long` or `model-not-allowed`.
7. **A malformed uuid in a path is a 404, never a 500** — the route refuses it
   before the database sees a cast.
8. **The ops ledger is written asynchronously.** Before asserting on
   `server.opsLog.records()`, `await new Promise((r) => setTimeout(r, 50))`.

---

## §H3 — test/dashboard-queries.test.ts: the read models

**Create:** `test/dashboard-queries.test.ts`. **Pattern file:**
`test/ledger.test.ts` — same shape: a database, `withTenant`, no HTTP server.
Do not start a server in this file.

Under test: `listOrders`, `getOrderSummary`, `getOrderDetail`, `listDeadLetter`,
`listWorkflowCards` and `clampPageSize` from `src/dashboard/queries.ts`.

Provision two tenants, seed the examples into each, and submit through
`enqueueOrder` (the version id comes from `listWorkflowCards`). Assert:

1. `listOrders` returns the tenant's orders newest first, each with its
   `itemCount`, its `workflowSlug` and `version`, and `finished` 0.
2. **A zero state is present, not absent.** On a freshly submitted order
   `counts.pending` equals the item count and `counts.dead` is `0` — not
   `undefined`. A progress bar built from a map with holes reports a wrong total.
3. `getOrderSummary` returns `null` for the OTHER tenant's order id, run under
   that other tenant's session — under RLS it is the same answer as an id that
   never existed.
4. `getOrderDetail` returns items in `idx` order 0,1,2 with `inputPreview` equal
   to the submitted text, and `output` null before anything has run.
5. `listDeadLetter` is empty until a job is dead; stamp one dead under
   `withAdmin` (see §H7 fact: `state = 'dead'` needs `dead_at` set too) and it
   comes back with `attempts`, `lastError`, `workflowSlug` and an ARRAY
   `failureTrail`.
6. `clampPageSize` is pure: `'abc'` and `0` give 25, `1000` gives 100, `'7'`
   gives 7.

---

## §H4 — test/api-auth.test.ts: the bearer wall and /api/me

**Create:** `test/api-auth.test.ts`. **Pattern file:** `test/server.test.ts` —
its `beforeAll`/`afterAll` shape and its use of `startTestServer` are the ones
to copy. Facts 1, 2, 3 and 8 above are what this file lives on.

Under test: the guard on every route in `src/server/api.ts`, plus `GET /api/me`.

Provision one tenant with a known `dailyTokenBudget` (pass it in
`entitlements`). Assert:

1. With NO bearer, every one of `/api/me`, `/api/workflows`, `/api/orders`,
   `/api/dead`, `/api/usage` answers 401, and so does `POST /api/orders`.
2. The 401 carries a `WWW-Authenticate` header.
3. **A made-up bearer is the same 401** — a wrong token and no token are
   indistinguishable from outside.
4. With a real token, `GET /api/me` is 200 and its body carries `tenantId`,
   `slug`, `limits` and `budget`.
5. `limits.dailyTokenBudget` is the number the tenant was provisioned with, and
   `budget.used` is `0` with `budget.exhausted` false on a tenant that has run
   nothing.
6. The ops ledger holds a `kind: 'request'` record whose `path` is the ROUTE
   `'/api/me'`, with a status and a numeric `ms`.

---

## §H5 — test/api-workflows.test.ts: the list and the submit

**Create:** `test/api-workflows.test.ts`. **Pattern file:** `test/api-auth.test.ts`
from §H4 for the set-up. Facts 4, 5 and 6 above are the ones that matter here.

Under test: `GET /api/workflows` and `POST /api/orders` in `src/server/api.ts`.

Provision two tenants and seed the examples into both. Assert:

1. `GET /api/workflows` returns three cards ordered by `slug`, each with
   `version` 1, a `versionId`, a `model` and an `outputSchema` object.
2. **A token sees only its own workflows** — the second tenant's card ids are
   disjoint from the first's.
3. `POST /api/orders` with `{ workflowId, items: ['a','b','c'] }` answers 201
   with `itemCount` 3 and `version` 1.
4. A malformed body is 400: no `workflowId`, an empty `items` array, and an
   `items` array holding a number are three separate cases.
5. Submitting the FIRST tenant's `workflowId` with the SECOND tenant's token is
   404 `no-such-workflow` — not 403, because under RLS it is not there.
6. A tenant provisioned with `maxItemsPerOrder: 2` submitting three items gets
   422 with `reason: 'too-many-items'`. The refusal is the entitlement's, not
   the route's — nothing in `src/server/api.ts` counts items.

---

## §H6 — test/api-orders.test.ts: progress, results, cancel

**Create:** `test/api-orders.test.ts`. **Pattern file:** `test/metering.test.ts`
for the stub-gateway and `runUntilIdle` half; §H5's file for the server half.

Under test: `GET /api/orders`, `GET /api/orders/:orderId`,
`GET /api/orders/:orderId/results.json` and `POST /api/orders/:orderId/cancel`.

Provision two tenants (give the first a large `dailyTokenBudget` so the run is
not stopped by the budget), seed the examples, submit a three-item order over
HTTP, and run it with `runUntilIdle` against `startStubGateway`. Assert:

1. Before the run, `GET /api/orders` lists the order with
   `counts.pending` equal to `itemCount`, `finished` 0 and `totalTokens` 0.
2. **The list is tenant-scoped**: the second tenant's token sees `orders: []`,
   `GET /api/orders/<first tenant's order id>` is 404 for it, and
   `GET /api/orders/not-a-uuid` is 404 rather than 500.
3. `GET /api/orders/:orderId` returns `{ order, items }` with the items in `idx`
   order and `output` null before the run.
4. After `runUntilIdle`, the order's `state` is `'done'`, its `totalTokens` is
   greater than 0, and every item's state is `succeeded` or `failed`.
5. `results.json` answers 200 with a `content-disposition` header containing
   `attachment`, and a body carrying `orderId`, `validatedCount` and a `results`
   array. **Only validated items are in it** — assert `results.length` equals
   `validatedCount`, and that each entry has an `idx` and an `output`.
6. `POST /api/orders/:orderId/cancel` answers 200 with numeric `cancelled` and
   `requested` fields.

Set the stub's default to a completion whose content is a JSON object matching
the seeded workflow's schema, the way `test/metering.test.ts` does.

---

## §H7 — test/api-dead.test.ts: the dead letter, requeue, the meter

**Create:** `test/api-dead.test.ts`. **Pattern file:** `test/api-workflows.test.ts`
from §H5. No runner and no stub gateway in this file — stamp the dead job by
hand.

Under test: `GET /api/dead`, `POST /api/jobs/:jobId/requeue` and `GET /api/usage`.

**The one fact this file turns on:** a job is only dead with its stamp. The
CHECK in `sql/005_runner.sql` refuses `state = 'dead'` unless `dead_at` is set,
so the fixture UPDATE under `withAdmin` sets `state`, `dead_at`, `attempts` and
`last_error` together.

Provision two tenants, seed, submit an order, then assert:

1. `GET /api/dead` is 200 and `jobs` is `[]` before anything dies.
2. After the fixture UPDATE, the job comes back with its `attempts`,
   `lastError`, `workflowSlug`, an `inputPreview` and an ARRAY `failureTrail`.
3. **The dead letter is tenant-scoped**: the second tenant's token sees `[]`,
   and `POST /api/jobs/<that job id>/requeue` is 404 for it.
4. `POST /api/jobs/:jobId/requeue` is 200 with `requeued: true` the first time
   and 404 the second — the job is no longer dead, so there is nothing to move.
5. After the requeue, `GET /api/dead` is empty again.
6. `GET /api/usage` is 200 with a `budget` carrying `budget`, `used`,
   `remaining` and `exhausted`, and a `byDay` array. On a tenant that has run
   nothing, `used` is 0.

---

## §H8 — test/page.test.ts: the page is self-contained

**Create:** `test/page.test.ts`. **Pattern file:** `test/server.test.ts` for the
server set-up. Import `DASHBOARD_HTML`, `DASHBOARD_CSP` and
`TOKEN_STORAGE_KEY` from `src/dashboard/page.js` for the string assertions.

Under test: `GET /` in `src/server/app.ts` and the document itself.

Assert:

1. `GET /` answers 200, its `content-type` contains `text/html`, and the body
   starts with `<!doctype html>`.
2. **It needs no bearer.** The same request WITH a made-up bearer is still 200 —
   it is a static document that carries no tenant data.
3. The response carries a `content-security-policy` containing
   `default-src 'none'` and `connect-src 'self'`.
4. **Nothing is fetched from anywhere.** The body contains no `<script src`, no
   `<link `, no `http://`, no `https://`, and no `cdn`. This is the assertion
   that keeps SPEC.md's no-framework, no-CDN, no-web-font rule true as the page
   grows.
5. The document contains the panel ids it is made of — `submit-workflow`,
   `orders`, `dead`, `usage-meter` — and the string `TOKEN_STORAGE_KEY` holds.
6. An unknown path is still the JSON 404 with an `error` field: adding `GET /`
   did not turn the not-found handler into HTML.

---

## §H9 — README.md: Phase H status

**Edit:** `README.md`. Nothing else. **Gate:** `bash verify.sh` green — gate 4
lints that every `pnpm <name>` and `bash <path>` the README shows really exists,
so do not invent a command.

Do three things and no more:

1. Update the status paragraph to Phase H: workmill now has a page. `GET /` is
   the tenant dashboard — one self-contained HTML file with no framework, no
   build step and no external request — and it is made of `/api/*` routes behind
   the same tenant bearer as `/events`. Say plainly what is still missing: the
   operator console (ROADMAP row #7), and nothing schedules the runner or serves
   the process outside tests.
2. Add one Layout line for `src/dashboard/` (the page and its read models),
   matching the existing Layout lines' wording.
3. Name the routes in one short list: `GET /`, `/api/me`, `/api/workflows`,
   `/api/orders` (GET and POST), `/api/orders/:id`, `/api/dead`, `/api/usage`.

Say that the page holds the tenant token in the browser's `localStorage` and
that tokens are minted by tests today. Use `localhost` in any URL you write —
never a LAN address.

---

## §H10 — close the phase

**Edit:** `STATUS.md` and `ROADMAP.md`. **Gate:** `bash verify.sh` green.

1. Append a `## Phase H — the tenant dashboard` section to `STATUS.md`, after
   the Phase G section, in the voice of the sections above it. Say: `GET /`
   serves one self-contained page; the panels are workflows, submit, orders with
   per-item progress, results with a validated-JSON download, the usage meter and
   the dead letter with requeue; every panel is a `/api/*` route behind the
   tenant bearer, and the tenant is never a request parameter. Say what is
   deliberately left: the operator console is row #7, and nothing schedules the
   runner or serves the process.
2. In `ROADMAP.md`, flip row **#6** to `SHIPPED`, phase `H`, with a one-line
   note. Do not touch any other row's status.
3. Append these four reservations to the ROADMAP.md reservations ledger, each
   one line, in the existing style:
   - **the page is served without a bearer** — it carries no tenant data and
     fetches everything with a token the person pastes; the CLI helper that
     mints that token belongs with the demo seed script;
   - **the live stream is read with `fetch`, not `EventSource`** — EventSource
     cannot send an Authorization header and a bearer in a query string would be
     logged; the page also polls every five seconds, so a browser that cannot
     stream still updates;
   - **item parsing lives in the page's inline JS** — one-per-line and the CSV
     column pick are the browser's; the API's contract is an array of strings,
     and that is the half the tests cover;
   - **no page writes a workflow yet** — create, edit and archive exist in the
     store but on no page; where workflow editing lives is the console phase's
     call.
