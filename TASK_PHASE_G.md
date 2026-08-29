# Phase G — the ops surface

**ROADMAP row:** #8 *Ops surface (/healthz, /metrics, /events, ledger, auth)*,
currently NOT BUILT. Five phases of library code arrive here: this phase is the
first thing in the repo a stranger can reach over HTTP. Three routes, one
bearer-token table, and a JSONL ledger of what the process did.

**Already committed (do not rebuild):** `sql/007_api.sql` (the `api_tokens`
table under RLS, plus its leak-suite fixtures), `src/server/auth.ts`,
`src/ops/events.ts`, `src/ops/metrics.ts`, `src/ops/opslog.ts`,
`src/server/app.ts`, the optional `events` bus on `RunnerOptions` in
`src/runner/run.ts`, and the test helper `test/helpers/server.ts`. Sections
§G1–§G3 are those commits; the tasks below start at §G4. **Every task below
writes tests or docs — no task in this phase needs you to write new `src/`
code.**

**Gate for every task below** (all three, always):
`pnpm typecheck` && `pnpm test` && `bash scripts/scrub-check.sh`.

**Seven facts that will cost you a red gate if you guess them wrong:**

1. **`makeTenant` from `test/helpers/db.ts` is the right helper this phase.**
   Phase F needed `provisionTenant` because it asserted on entitlements;
   nothing here does. `makeTenant(db, 'slug')` returns `{ id, slug }`.
2. **Start a real server, never `app.inject()`.** `test/helpers/server.ts`
   exports `startTestServer(engine, options?)`, which returns
   `{ url, app, opsLog, get(path, token?), close() }`. `get` is a `fetch`
   wrapper that adds `Authorization: Bearer <token>` when you pass one. Always
   `await server.close()` and `await db.close()` in `afterAll`.
3. **An operator token must be at least 16 characters.** Pass it in as
   `startTestServer(db, { operatorToken: 'operator-token-long-enough' })`.
   Shorter values are refused; omitting it disables the operator routes.
4. **Minting a token needs `withTenant`.** `mintApiToken(sql, tenantId, {name})`
   takes a `Session`. The helper `mintTestToken(db, tenantId, name?)` does that
   for you and returns the RAW token string — that is the only place it exists.
5. **The SSE stream and the app must share one bus.** Build it yourself
   (`new EventBus()` from `src/ops/events.js`), pass it as
   `startTestServer(db, { bus })`, and publish onto that same object.
6. **A hijacked SSE response never "finishes".** Read it with
   `readSseEvents(response, want, timeoutMs?)` from the helper, which returns
   the parsed `data:` payloads and then cancels the body.
7. **The ops ledger is written asynchronously.** Before asserting on
   `server.opsLog.records()`, `await new Promise((r) => setTimeout(r, 50))`.

---

## §G4 — test/auth.test.ts: the bearer-token seam

**Create:** `test/auth.test.ts`. **Pattern file:** `test/members.test.ts` — it
tests the same shape (a raw token handed out once, only its hash stored) for
invites, and its database setup is the one to copy.

Under test: `mintApiToken`, `resolveApiToken`, `revokeApiToken`,
`listApiTokens`, `hashApiToken`, `parseBearer` from `src/server/auth.ts`. No
HTTP server in this file — these are functions.

`mintApiToken(sql, tenantId, { name, userId?, ttlMs? })` runs under
`withTenant`. `resolveApiToken(engine, rawToken)` takes the ENGINE, not a
session, and returns `{ tenantId, userId, tokenId }` or `null`.

Assert:

1. A minted token resolves to the tenant that minted it, and the returned
   `tokenId` matches the mint's.
2. **The raw token is never stored.** Select `token_hash` for the row under
   `withAdmin` and assert it equals `hashApiToken(token)` and does not contain
   the raw token string.
3. A revoked token resolves to `null`, and so does a made-up string — the two
   are indistinguishable from outside.
4. A token minted with `ttlMs: 1` resolves to `null` once it has expired (sleep
   a few milliseconds first; expiry is computed by the database).
5. `listApiTokens` shows one tenant only its own tokens, and no field of the
   summary contains the raw token.
6. `parseBearer` accepts `'Bearer abc'` and `'bearer abc'`, and returns `null`
   for `undefined`, `''`, `'Basic abc'` and `'Bearer'` alone.

---

## §G5 — test/opslog.test.ts: the JSONL ledger redacts

**Create:** `test/opslog.test.ts`. **Pattern file:** `test/render.test.ts` — a
pure-function test file with no database and no network. Do not open a database
in this file.

Under test: `redact`, `formatOpsLine`, `memoryOpsLog`, `nullOpsLog` and the
constant `REDACTED` from `src/ops/opslog.ts`.

Assert:

1. `redact` replaces the value of a field named `input`, `output`, `prompt` or
   `authorization` with `REDACTED`, and leaves `jobId`, `status` and `ms`
   untouched.
2. **A token COUNT is not a secret.** `redact` leaves `total_tokens` and
   `promptTokens` alone — the rule is "ends in tokens is a count" — while still
   redacting `token_hash`.
3. Matching is case-insensitive and by substring: a field named `userInput` or
   `Authorization` is redacted too.
4. `formatOpsLine(record, at)` returns exactly one line: it ends with `\n` and
   contains no other newline, even when a field value itself contains `\n`.
5. The parsed line carries the `at` you passed and the record's `kind`.
6. `memoryOpsLog()` appends in order and `records()` parses them back;
   `nullOpsLog()` discards without throwing.

---

## §G6 — test/events.test.ts: the bus and the SSE frames

**Create:** `test/events.test.ts`. **Pattern file:** `test/render.test.ts` —
again pure functions, no database, no server.

Under test: `EventBus` (`publish`, `subscribe`, `replay`, `hasGapSince`,
`lastSeq`, `subscriberCount`) and `formatSse`, `sseComment`, `parseLastEventId`
from `src/ops/events.ts`.

`publish` takes `{ kind, tenantId, id, state }` plus optional `orderId`, `idx`,
`reason`, and returns the stamped event with `seq` and `at` filled in.

Assert:

1. **A subscriber hears only its own tenant.** Subscribe for tenant A, publish
   one event for A and one for B, and the listener saw exactly the A event.
2. `seq` increases by one per publish across all tenants, and the returned
   event's `at` parses as a date.
3. The function `subscribe` returns unsubscribes: after calling it,
   `subscriberCount` is back to 0 and a further publish reaches nobody.
4. **A throwing listener does not break the publisher.** Subscribe one listener
   that throws and one that records; publish once; the recording listener still
   saw the event and `publish` did not reject.
5. `replay(tenantId, afterSeq)` returns only that tenant's events with a
   greater `seq`, oldest first. On a bus built as `new EventBus(2)`, publishing
   four events keeps only the last two, and `hasGapSince(1)` is then `true`.
6. `formatSse` produces a frame ending in a blank line whose `id:` is the seq
   and whose `data:` line parses back to the event. `parseLastEventId` returns
   `0` for `undefined` and for `'abc'`, and `7` for `'7'`.

---

## §G7 — test/metrics.test.ts: the Prometheus text

**Create:** `test/metrics.test.ts`. **Pattern file:** `test/ledger.test.ts` for
the database half; the render half needs no database.

Under test: `renderMetrics`, `escapeLabelValue` and `collectMetrics` from
`src/ops/metrics.ts`. `collectMetrics(engine, { uptimeSeconds,
eventSubscribers })` runs cross-tenant as admin.

Assert:

1. `renderMetrics` on a hand-built snapshot emits, for every metric, a
   `# HELP` line then a `# TYPE` line then its samples, and the whole body ends
   with a newline.
2. **A zero series is still printed.** Every state in `JOB_STATES` appears as a
   `workmill_jobs{state="…"}` sample even when the snapshot's `jobsByState` is
   empty — a series that vanishes at zero makes a rate lie.
3. `workmill_up` is always `1`, and a non-finite count in the snapshot renders
   as `0` rather than `NaN`.
4. **No metric carries a tenant label.** Assert the rendered body contains
   neither `tenant_id=` nor a tenant's uuid.
5. `escapeLabelValue` escapes a backslash, a double quote and a newline.
6. Against a migrated database with two tenants and one enqueued order,
   `collectMetrics` reports `tenants: 2` and a `jobsByState.pending` equal to
   the number of items submitted. Use `enqueueOrder`; `test/ledger.test.ts`
   shows the workflow-version set-up it needs.

---

## §G8 — test/server.test.ts: healthz, metrics and the 404

**Create:** `test/server.test.ts`. **Pattern file:** `test/runner.test.ts` for
the `beforeAll`/`afterAll` database shape; facts 2, 3 and 7 above for the
server. Do NOT test `/events` here — §G9 owns it.

Under test: the routes in `src/server/app.ts`.

Assert:

1. `GET /healthz` with no bearer answers 200 and a JSON body whose `status` is
   `'ok'`, whose `database` is `'up'`, and whose `engine` matches `db.kind`.
2. `GET /metrics` with no bearer answers 401; with a WRONG bearer, 401; with
   the operator bearer, 200.
3. The 200 body's `content-type` header contains `text/plain`, and the body
   contains `workmill_up 1`.
4. **A missing secret means off, not unguarded.** On a second server started
   with no `operatorToken` at all, `GET /metrics` with any bearer answers 503.
5. An unknown path answers 404 with a JSON `error` field.
6. After the requests above, `server.opsLog.records()` contains one record per
   request with `kind: 'request'`, its `status`, and a numeric `ms`.

---

## §G9 — test/sse.test.ts: the live event stream

**Create:** `test/sse.test.ts`. **Pattern file:** `test/server.test.ts` from
§G8 for the set-up; facts 2, 5 and 6 above are the ones this file lives on.

Under test: `GET /events` in `src/server/app.ts`. Make the bus yourself and
pass it to `startTestServer`, then publish onto it directly — this file does
not need the runner.

Assert:

1. `GET /events` with no bearer answers 401, and so does a made-up bearer; the
   401 carries a `WWW-Authenticate` header.
2. With a token from `mintTestToken`, the response is 200 and its
   `content-type` contains `text/event-stream`.
3. **The stream is tenant-scoped.** Publish one event for another tenant and
   two for the connected one; `readSseEvents(response, 2)` returns exactly the
   two, in publish order, each with the connected tenant's id.
4. Every delivered payload carries `seq`, `at`, `kind`, `id` and `state`, and
   carries no field named `input` or `output`.
5. **A closed stream unsubscribes.** After the response body is cancelled, wait
   ~50ms and assert `app.bus.subscriberCount` is 0.
6. The ops ledger holds a `kind: 'stream'` record with `event: 'open'` and,
   after the close, one with `event: 'close'`.

---

## §G10 — README.md: Phase G status

**Edit:** `README.md`. Nothing else. **Gate:** `bash verify.sh` green — gate 4
lints that every `pnpm <name>` and `bash <path>` the README shows really
exists, so do not invent a command.

Do three things and no more:

1. Update the status paragraph to Phase G: workmill now has an HTTP surface —
   `/healthz`, `/metrics` and `/events` — with tenant bearer tokens and a
   static operator bearer. Say plainly what is still missing: neither page
   exists yet (the dashboard is ROADMAP row #6, the console row #7), and
   nothing schedules the runner.
2. Add one Layout line for `src/server/` (the HTTP app and the auth seam) and
   one for `src/ops/` (events, metrics, the JSONL ledger), matching the
   existing Layout lines' wording.
3. Add one migrations line for `sql/007_api.sql`, matching how
   `sql/006_metering.sql` is listed.

Mention that the operator bearer is read from `WORKMILL_OPERATOR_TOKEN` and
that an unset value disables the operator routes. Use `localhost` in any URL
you write — never a LAN address.

---

## §G11 — close the phase

**Edit:** `STATUS.md` and `ROADMAP.md`. **Gate:** `bash verify.sh` green.

1. Append a `## Phase G — the ops surface` section to `STATUS.md`, after the
   Phase F section, in the voice of the sections above it. Say: the three
   routes exist and are covered by tests; `api_tokens` makes twelve
   tenant-scoped tables the leak suite proves; `/metrics` sits behind the
   operator bearer and carries no tenant labels; the runner publishes
   transitions to a bus when given one. Say what is deliberately left: no page
   renders any of it, and nothing schedules the runner or serves the process.
2. In `ROADMAP.md`, flip row **#8** to `SHIPPED`, phase `G`, with a one-line
   note. Do not touch any other row's status.
3. Append these four reservations to the ROADMAP.md reservations ledger,
   each one line, in the existing style:
   - **the event bus is in-process** — one server sees only its own
     transitions, which is exactly the single-box deployment the spec fences;
   - **`/metrics` is behind the operator bearer** — a named call, recorded at
     the top of `src/server/app.ts`; a scraper must be configured with it;
   - **nothing listens yet** — `createApp` returns a Fastify instance that only
     tests call `listen()` on; the entrypoint and its systemd unit belong to
     the packaging phase;
   - **tokens are minted by tests only** — the CLI helper SPEC.md's non-goals
     name is not written yet; it belongs with the demo seed script.
