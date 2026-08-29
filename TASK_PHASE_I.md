# Phase I — the operator console

**ROADMAP row:** #7 *Operator console (grants, audit, fleet panel)*, currently
NOT BUILT. This is the last page in the spec. `GET /operator` is one
self-contained HTML file under the dashboard's rules, made of `/api/operator/*`
routes behind the operator bearer — a tenant table with state and entitlements,
a provision form, entitlement edits, support-access grants with a required
reason and a TTL countdown, the audit trail, and the fleet panel.

**Already committed (do not rebuild):** `sql/008_operator.sql` (`support_grants`,
`audit_log`, both tenant-scoped, plus their leak fixtures),
`src/operator/grants.ts`, `src/operator/audit.ts`, `src/operator/tenants.ts`,
`src/operator/fleet.ts`, `src/server/operator-api.ts`, `src/console/page.ts`,
the `GET /operator` route and the `registerOperatorApi` call in
`src/server/app.ts`, and `GET /api/audit` + `GET /api/grants` in
`src/server/api.ts`. Sections §I1–§I3 are those commits; the tasks below start
at §I4. **Every task below writes tests or docs — no task in this phase needs
you to write new `src/` code.**

**Gate for every task below** (all three, always):
`pnpm typecheck` && `pnpm test` && `bash scripts/scrub-check.sh`.

**Nine facts that will cost you a red gate if you guess them wrong:**

1. **`provisionTenant` is the helper, not `makeTenant`.** The console reads
   entitlements, and a bare tenant has none.
   `provisionTenant(db, { slug, name, ownerEmail })` returns `{ tenantId, … }`;
   pass `entitlements: { dailyTokenBudget: 4242 }` to override one limit. Slugs
   must be unique per test file — sql/001 has a unique index on them.
2. **The two writes take the tenant from the seam, not from a parameter.**
   `grantSupportAccess` and `recordAudit` insert with `app_tenant_id()`, so they
   only work inside `withTenant(db, tenantId, (sql) => …)`. Calling them under
   `withAdmin` raises a row-level-security error.
3. **Start a real server** with `startTestServer(db, { operatorToken: OP })` from
   `test/helpers/server.ts`, where `OP` is any string of 16+ characters. It
   returns `{ url, app, opsLog, get, post, getJson, postJson, close }`; always
   `await server.close()` and `await db.close()` in `afterAll`.
4. **No operator token configured is 503, not 401.** A server started without
   `operatorToken` answers `503 operator-api-disabled` on every operator route:
   a missing secret means "off", never "unguarded".
5. **A tenant's own bearer gets 401 on operator routes**, exactly like a made-up
   one. The two credentials do not overlap.
6. **Every write is a POST.** There is no PATCH anywhere — `test/helpers/server.ts`
   only speaks GET and POST, and the routes are shaped to match.
7. **The refusal codes ARE the assertion.** 400 = malformed body or a bad
   entitlement value (carries a `field`); 404 = unknown or malformed tenant id
   (`no-such-tenant`) or grant id; 409 = a slug already taken; 422 = a grant the
   rules refused, carrying `reason` of `reason-too-short`, `reason-too-long` or
   `ttl-out-of-range`.
8. **A grant needs a reason of 8+ characters and a `ttlMs` of 60000..86400000.**
   Anything outside that is a `GrantRefusedError` before any write.
9. **The audit trail is newest first.** `at` is a `Date`, `detail` is a parsed
   object (not a string), and `grantId` is null unless the entry is about a grant.

---

## §I4 — test/operator-grants.test.ts: grants and the trail they leave

**Create:** `test/operator-grants.test.ts`. **Pattern file:** `test/auth.test.ts`
— same shape: a database, `withTenant`, no HTTP server. Do not start a server.

Under test: `grantSupportAccess`, `listSupportGrants`, `activeSupportGrant`,
`revokeSupportGrant`, `isGrantActive`, `grantRemainingMs` from
`src/operator/grants.js`, and `recordAudit`, `listAudit`, `clampAuditLimit` from
`src/operator/audit.js`. Facts 1, 2, 8 and 9 are what this file lives on.

Provision two tenants and assert:

1. A grant made with a real reason comes back with that `reason`, its
   `grantedBy`, an `expiresAt` later than its `createdAt`, and `revokedAt` null.
2. **The pure helpers agree with the row.** `isGrantActive` is true for a fresh
   grant and `grantRemainingMs` is above zero; both are false/zero for a grant
   object you build by hand with an `expiresAt` in the past, and for one with a
   `revokedAt` set even though its `expiresAt` is in the future.
3. A reason of under eight characters throws `GrantRefusedError` with
   `reason: 'reason-too-short'`, and a `ttlMs` of `5` throws one with
   `reason: 'ttl-out-of-range'`. Neither writes a row.
4. `revokeSupportGrant` is `true` the first time and `false` the second, and
   `activeSupportGrant` returns null afterwards.
5. **Grants are tenant-scoped**: the second tenant's session sees `[]` from
   `listSupportGrants` and gets `false` from `revokeSupportGrant` on the first
   tenant's grant id.
6. `recordAudit` then `listAudit` returns the entry with its `detail` as an
   OBJECT and its `at` as a `Date`; a second tenant's `listAudit` does not see
   it. `clampAuditLimit` is pure: `'abc'` and `0` give 50, `9999` gives 500,
   `'7'` gives 7.

---

## §I5 — test/operator-tenants.test.ts: the table and the two edits

**Create:** `test/operator-tenants.test.ts`. **Pattern file:**
`test/entitlements.test.ts` for the entitlement half, `test/auth.test.ts` for
the `withTenant` shape. No HTTP server in this file.

Under test: `listTenantRows`, `tenantExists`, `updateEntitlements`,
`setTenantState` and `EntitlementValueError` from `src/operator/tenants.js`.

Note the split: `listTenantRows` and `tenantExists` take the ENGINE (they are
cross-tenant), while `updateEntitlements` and `setTenantState` take a `Session`
and must run inside `withTenant(db, tenantId, …)`.

Provision two tenants, one of them with `entitlements: { maxItemChars: 512 }`,
and assert:

1. `listTenantRows` returns both, newest first, each with its `slug`, `state`
   `'active'`, a `limits` object carrying the five numbers, and `supportActive`
   false.
2. The counts are present and zero on a fresh tenant: `pendingJobs`,
   `runningJobs`, `deadJobs`, `openOrders` and `tokensToday` are all `0` — not
   `undefined`.
3. `tenantExists` is true for a real id and false for
   `'00000000-0000-4000-8000-000000000000'`.
4. `updateEntitlements` with `{ maxItemChars: 99, allowedModels: ['default','fast'] }`
   returns the new limits, and a later `listTenantRows` shows them — the patch
   is partial, so `maxConcurrentJobs` is unchanged.
5. `maxConcurrentJobs: 0`, `maxItemChars: -1` and `allowedModels: []` each throw
   `EntitlementValueError` carrying the offending `field`. An empty patch `{}`
   throws too.
6. `setTenantState(sql, 'suspended')` is `true`, calling it again is `false`
   (nothing changed), and `listTenantRows` reports the new state. **The edit
   does not reach the other tenant** — assert the second tenant is still
   `'active'`.

---

## §I6 — test/operator-fleet.test.ts: the probe and the snapshot

**Create:** `test/operator-fleet.test.ts`. **Pattern file:**
`test/metrics.test.ts` — same shape: a pure half with no database, then
`collectFleet` against a migrated one. No HTTP server, and **no real network**.

Under test: `probeGateway` and `collectFleet` from `src/operator/fleet.js`.

`probeGateway(config, { fetchImpl })` takes an injected fetch, so both branches
are provable in-process. A config is
`{ baseUrl: 'http://localhost:8080/v1', timeoutMs: 100, models: {} }`. Assert:

1. `probeGateway(null)` answers `reachable: false`, `status: null` and
   `error: 'not-configured'` — a missing gateway is never a green light.
2. With a `fetchImpl` returning `new Response('{}', { status: 200 })`, it
   answers `reachable: true`, `status: 200`, a numeric `latencyMs`, and echoes
   the `baseUrl` back.
3. With a `fetchImpl` returning status 503, `reachable` is false and `error`
   contains `503`.
4. With a `fetchImpl` that throws, `reachable` is false, `status` is null and
   `error` carries the thrown message. **It does not throw** — a fleet panel
   that 500s when the gateway is down breaks exactly when it is needed.
5. `collectFleet(db, { gateway: null })` on a migrated database with two
   provisioned tenants answers `tenants.total` 2, `tenants.suspended` 0,
   `tenants.withActiveGrant` 0, and every `queue` and `throughput` number `0`.
6. After granting support access to one tenant (see §I4 fact 2 for the
   `withTenant` shape), `tenants.withActiveGrant` is `1`.

---

## §I7 — test/operator-api.test.ts: the wall, the table, the provision form

**Create:** `test/operator-api.test.ts`. **Pattern file:** `test/api-auth.test.ts`
— its `beforeAll`/`afterAll` shape and its use of `startTestServer` are the ones
to copy. Facts 3, 4, 5 and 7 are what this file lives on.

Under test: `GET /api/operator/tenants`, `POST /api/operator/tenants` and
`GET /api/operator/fleet` in `src/server/operator-api.js`.

Provision one tenant and mint a TENANT bearer with `mintTestToken(db, tenantId)`.
Assert:

1. With no bearer, `GET /api/operator/tenants` and `GET /api/operator/fleet` are
   401 and carry a `WWW-Authenticate` header. A made-up bearer is the same 401.
2. **The tenant's own bearer is also 401** on both — the two credentials do not
   overlap.
3. A SECOND server started with no `operatorToken` answers 503
   `operator-api-disabled` on `GET /api/operator/tenants`, even when given the
   right-looking bearer. Close that server in the test that made it.
4. With the operator bearer, `GET /api/operator/tenants` is 200 and `tenants`
   holds one row with a `slug`, a `state` and a `limits` object.
5. `POST /api/operator/tenants` with `{ slug, name, ownerEmail }` is 201 with a
   `tenantId`; the same slug again is 409 `slug-taken`; a body with an invalid
   slug (`'NO'`) is 400.
6. `GET /api/operator/tenants/<the new id>/audit` is 200 and its first entry's
   `action` is `'tenant.provisioned'` — provisioning starts the trail.
7. `GET /api/operator/tenants/not-a-uuid/audit` and the same route with a real
   uuid that is no tenant are both 404 `no-such-tenant`, never 500.

---

## §I8 — test/operator-writes.test.ts: edits, grants, and the receipt

**Create:** `test/operator-writes.test.ts`. **Pattern file:** §I7's file for the
set-up. Facts 6, 7 and 8 are the ones that matter here.

Under test: the entitlement, state and grant routes in
`src/server/operator-api.js`, plus `GET /api/audit` and `GET /api/grants` in
`src/server/api.js`.

Provision one tenant, mint a tenant bearer for it, start a server with an
operator token, and assert:

1. `POST /api/operator/tenants/:id/entitlements` with `{ maxItemChars: 512 }` is
   200 and returns the new `limits`. With `{ maxConcurrentJobs: 0 }` it is 400
   carrying `field: 'maxConcurrentJobs'`.
2. `POST /api/operator/tenants/:id/state` with `{ state: 'suspended' }` is 200
   with `changed: true`; sending it again is 200 with `changed: false`; a state
   of `'nope'` is 400.
3. `POST /api/operator/tenants/:id/grants` with a reason under eight characters
   is 422 with `reason: 'reason-too-short'`. With a real reason and
   `ttlMs: 1800000` it is 201, and the body carries `active: true` and a
   `remainingMs` above zero.
4. `GET /api/operator/tenants/:id/grants` then shows that grant as `active`, and
   `GET /api/operator/tenants` shows the tenant with `supportActive: true`.
5. The revoke route is 200 the first time and 404 `no-such-grant` the second.
6. **The trail is the receipt.** `GET /api/operator/tenants/:id/audit` contains
   the actions `entitlements.updated`, `tenant.state-changed`,
   `support.granted` and `support.revoked`.
7. **The tenant reads the same rows with its OWN bearer.** `GET /api/audit` with
   the TENANT token is 200 and its actions include `support.granted`;
   `GET /api/grants` with the tenant token is 200 and lists the grant. Both are
   401 with no bearer.

---

## §I9 — test/console-page.test.ts: the console is self-contained

**Create:** `test/console-page.test.ts`. **Pattern file:** `test/page.test.ts` —
copy its shape exactly; this is the same set of questions asked of the second
page. Import `CONSOLE_HTML`, `CONSOLE_CSP` and `OPERATOR_TOKEN_STORAGE_KEY`
from `src/console/page.js`.

Under test: `GET /operator` in `src/server/app.js` and the document itself.

Assert:

1. `GET /operator` answers 200, its `content-type` contains `text/html`, and the
   body starts with `<!doctype html>`.
2. **It needs no bearer**, and the same request WITH a made-up bearer is still
   200 — it is a static document carrying no data and no credential.
3. The response carries a `content-security-policy` containing
   `default-src 'none'` and `connect-src 'self'`, and it equals `CONSOLE_CSP`.
4. **Nothing is fetched from anywhere.** `CONSOLE_HTML` contains no
   `<script src`, no `<link `, no `http://`, no `https://` and no `cdn`. This is
   the assertion that keeps SPEC.md's no-framework, no-CDN, no-web-font rule
   true as the page grows.
5. The document contains the six panel ids it is made of — `fleet`, `tenants`,
   `provision`, `entitlements`, `grants`, `audit` — and the string
   `OPERATOR_TOKEN_STORAGE_KEY`.
6. `GET /` is still the tenant dashboard and is a DIFFERENT document: assert the
   two bodies are not equal, and that an unknown path is still the JSON 404 with
   an `error` field.

---

## §I10 — README.md: Phase I status

**Edit:** `README.md`. Nothing else. **Gate:** `bash verify.sh` green — gate 4
lints that every `pnpm <name>` and `bash <path>` the README shows really exists,
so do not invent a command.

Do three things and no more:

1. Add a Phase I paragraph after the Phase H one: the operator console is live
   at `GET /operator`, one self-contained HTML file under the same rules as the
   dashboard, made of `/api/operator/*` routes behind the operator bearer. Name
   what it does: a tenant table with state and entitlements, a provision form,
   entitlement edits, support grants with a required reason and a countdown, the
   audit trail, and a fleet panel that probes the gateway. Say the thing that
   makes the trail matter: the tenant reads the same rows at `GET /api/audit`
   with its own bearer. Say what is still missing — demo mode and deploy
   packaging (ROADMAP row #9), and nothing schedules the runner or serves the
   process outside tests.
2. Add one Layout line for `src/operator/` (grants, the audit trail, the tenant
   table, the fleet probe) and one for `src/console/` (the operator console
   page), matching the existing Layout lines' wording. Extend the `sql/` line to
   mention `sql/008_operator.sql`.
3. Extend the Routes line at the bottom with `GET /operator`, `/api/audit`,
   `/api/grants` and `/api/operator/*`.

Use `localhost` in any URL you write — never a LAN address.

---

## §I11 — close the phase

**Edit:** `STATUS.md` and `ROADMAP.md`. **Gate:** `bash verify.sh` green.

1. Append a `## Phase I — the operator console` section to `STATUS.md`, after
   the Phase H section, in the voice of the sections above it. Say: `GET /operator`
   serves one self-contained page behind the operator bearer; a support grant is
   a row with a required reason and a mandatory expiry, so a grant with no
   justification or no end cannot be written; every operator write appends an
   audit row in the same transaction as the change, and the tenant reads those
   rows with its own bearer at `GET /api/audit`; `support_grants` and
   `audit_log` make fourteen tenant-scoped tables the leak suite proves. Say
   what is deliberately left: demo mode and deploy packaging are ROADMAP row #9,
   and nothing schedules the runner or serves the process.
2. In `ROADMAP.md`, flip row **#7** to `SHIPPED`, phase `I`, with a one-line
   note. Do not touch any other row's status.
3. Append these four reservations to the ROADMAP.md reservations ledger, each
   one line, in the existing style:
   - **`audit_log` is append-only by construction, not by grant** — the catalog
     leak suite asserts every tenant-scoped table accepts a same-tenant UPDATE,
     so a REVOKE or a `USING (false)` policy would change that assertion for all
     fourteen tables; nothing in `src/` reaches a verb that could rewrite an
     entry;
   - **a support grant records, it does not gate** — operator routes are already
     behind the operator bearer, and making a live grant a precondition of
     operator reads is a design with real questions (which reads, what happens
     mid-request) that this phase had no mandate to answer;
   - **tenant suspension is a label** — `state = 'suspended'` shows in the
     console and the fleet counts, but no claim, token or route consults it yet;
   - **the console holds the operator bearer in `localStorage`** — the same seam
     the dashboard uses, and the CLI helper that mints tokens still belongs with
     the demo seed script.
