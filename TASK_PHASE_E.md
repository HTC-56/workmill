# Phase E — the job runner

**ROADMAP row:** #3 *Work orders → durable jobs on Postgres (SKIP LOCKED,
leases, DLQ, cancel)*, currently PARTIAL. Phase A proved the claim. This phase
is everything that happens after it: leases with heartbeat, retries with
exponential backoff and jitter, a dead-letter preserving the full failure
trail, requeue by verb, real cancel, and the durable result row that finally
gives Phase D's token counts somewhere to live.

**Already committed (do not rebuild):** `sql/005_runner.sql` (the `job_results`
table, the new `jobs` columns, and `work_orders.workflow_version_id` becoming
NOT NULL), `src/queue/lifecycle.ts` (`backoffMs`, `heartbeat`, `finishJob`,
`failAttempt`, `reapExpiredLeases`, `requeueJob`, `cancelOrder`,
`markCancelled`, `orderProgress`), `src/runner/run.ts` (`runOnce`,
`runUntilIdle`, `cancelOrderNow`), and the abort seam in `src/gateway/client.ts`
(`GatewayAbortedError`). Sections §E1–§E3 are those commits; the tasks below
start at §E4. **Every task below writes tests or docs — no task in this phase
needs you to write new `src/` code.**

**Gate for every task below** (all three, always):
`pnpm typecheck` && `pnpm test` && `bash scripts/scrub-check.sh`.

**Seven facts that will cost you a red gate if you guess them wrong:**

1. **Every order must pin a workflow version.** `enqueueOrder(sql, tenantId,
   items, { workflowVersionId })` — the option is required now. Make one
   workflow and one `workflow_versions` row in `beforeAll` as admin and reuse
   its id, exactly the way `test/claim.test.ts` does in its `beforeAll`. Copy
   that block.
2. **`failed` and `dead` are different states and not synonyms.** `failed` =
   the model answered but the answer never validated; terminal, and a
   `job_results` row is written. `dead` = the model never answered, after
   `max_attempts` transport failures; no result row, and only a requeue moves
   it. Asserting one where the code produces the other is the likeliest way to
   waste this session.
3. **jsonb columns come back already parsed** on both engines: `failure_trail`
   is an array of objects, `output` and `errors` are an object and an array.
   Do not `JSON.parse` them. But `count(*)` comes back as a **string** on the
   server driver — always `Number(row.n)`, like the existing suites.
4. **A retried job is not due yet.** `failAttempt` sets `run_at` into the
   future, so a second `runOnce` claims nothing. To make it due without
   waiting, run `UPDATE jobs SET run_at = now() WHERE id = $1` under
   `withAdmin` between ticks.
5. **The stub gateway**, from `test/helpers/stub-gateway.ts`:
   `await startStubGateway()` gives `stub.baseUrl`, `stub.requests`,
   `stub.queue(...behaviors)` (one behaviour consumed per call, in order),
   `stub.setDefault(b)` and `await stub.close()`. Behaviours used in this
   phase: `{ kind: 'content', content }`, `{ kind: 'status', status }`,
   `{ kind: 'delay', ms, content? }`. A `content` behaviour reports **11 prompt
   + 7 completion = 18 total** tokens per call.
6. **Build a `GatewayConfig` as a literal**: `{ baseUrl: stub.baseUrl,
   timeoutMs: 2000, models: {} }`. Never mutate `process.env`.
7. `noUncheckedIndexedAccess` is on, so `rows[0]` is possibly-undefined. Use
   `rows[0]!` or `rows.at(-1)!`, the way the existing tests do. Close the stub
   and the db in `afterAll` or the run hangs.

---

## §E4 — test/lifecycle.test.ts: the backoff law, the heartbeat, finishJob

**Create:** `test/lifecycle.test.ts`. **Pattern file:** `test/claim.test.ts` —
copy its `beforeAll` shape (freshDb, makeTenant, and the admin block that makes
a workflow version), its `submit()` helper, and its `afterAll`. No stub gateway
is needed in this task: nothing here calls a model.

Under test: `backoffMs`, `heartbeat` and `finishJob` from
`src/queue/lifecycle.ts`. Read that file's header comment and the doc comment
above each of the three functions first.

To get a job into `running` so a heartbeat has something to renew, claim it:
`claimJobs(sql, { limit: 1, workerId: 'w1', leaseMs: 5000 })` from
`src/queue/claim.ts`, the same call `test/claim.test.ts` makes.

Assert:

1. `backoffMs` is exact under an injected random: with `() => 0` attempt 1 is
   500 and attempt 2 is 1000; with `() => 1` attempt 1 is 1000 and attempt 3 is
   4000. It is a pure function — no database in these assertions.
2. `backoffMs` is clamped: a very large attempt count (say 99) with `() => 1`
   returns `MAX_BACKOFF_MS`, and attempt 0 is treated as attempt 1.
3. `heartbeat` on a job this worker claimed returns `'renewed'` and pushes
   `lease_expires_at` later than it was before the call.
4. `heartbeat` with a **different** `workerId` returns `'lost'` and does not
   move the lease — the row belongs to whoever claimed it.
5. After `cancelOrder` has stamped a running job, `heartbeat` returns
   `'cancel-requested'`.
6. `finishJob` with an `ok: true` outcome flips the job to `succeeded`, clears
   `lease_expires_at`, and writes one `job_results` row whose `output`,
   `total_tokens` and `attempts` are the values passed in.
7. `finishJob` with an `ok: false` outcome flips the job to `failed` and writes
   a result row carrying `failure_reason`, the raw text, and the errors.
8. `finishJob` on a job that is not `running` throws `JobNotRunningError`.

---

## §E5 — test/lifecycle.test.ts: retry, dead-letter, requeue

**Edit:** `test/lifecycle.test.ts`, adding a new `describe` block. **Keep every
existing case** — this task extends the file the way §A7 extended
`test/leak.test.ts`.

Under test: `failAttempt` and `requeueJob` from `src/queue/lifecycle.ts`. Pass
`() => 0` as the `random` argument so the backoff is deterministic.

Assert:

1. `failAttempt` on a job with attempts below `max_attempts` returns
   `state: 'pending'` with a positive `backoffMs`, clears the lease, and leaves
   `run_at` **in the future** — later than `now()`.
2. It appends exactly one entry to `failure_trail`, and that entry carries the
   `kind` and `error` that were passed in.
3. Three successive claim-then-fail rounds put the job in `dead` with a
   non-null `dead_at` and a three-entry trail. (Claim the job again between
   rounds; `failAttempt` reads `attempts`, and the claim is what increments it.
   Use the fact-4 `run_at` reset so the claim can see it.)
4. A dead job is **not claimable**: a following `claimJobs` returns nothing.
5. `requeueJob` on that dead job returns `true`, puts it back to `pending` with
   `attempts` reset to 0 and `dead_at` cleared, and **keeps** the existing trail
   entries while appending a `'requeued'` one.
6. `requeueJob` on a `pending` job returns `false` and changes nothing — only
   `dead` and `failed` jobs can be requeued.
7. Requeueing an item of an order that had closed puts the order back to
   `'open'`.

---

## §E6 — test/lifecycle.test.ts: cancel, the reaper, order progress

**Edit:** `test/lifecycle.test.ts`, adding a third `describe` block. **Keep
every existing case.**

Under test: `cancelOrder`, `markCancelled`, `reapExpiredLeases` and
`orderProgress` from `src/queue/lifecycle.ts`.

To make a lease look expired without waiting, set it into the past under
`withAdmin`: `UPDATE jobs SET lease_expires_at = now() - interval '1 minute'
WHERE id = $1` on a job that is already `running`.

Assert:

1. `cancelOrder` on an order whose items are all `pending` returns
   `{ cancelled: N, requested: 0 }`, flips every job to `cancelled`, and sets
   the order's own state to `cancelled`.
2. `cancelOrder` on an order with one **claimed** item returns `requested: 1`
   for it and leaves that job `running` with `cancel_requested_at` set — a
   running job is asked, not flipped.
3. `markCancelled` on that running job returns `true`, moves it to `cancelled`,
   clears the lease, and appends a trail entry whose `kind` is `'cancelled'`.
4. `markCancelled` on a job that is not `running` returns `false`.
5. `reapExpiredLeases` returns one entry per expired lease and puts each job
   back to `pending`; a running job whose lease is still valid is untouched.
6. `orderProgress` counts by state and reports the order's own state — assert
   it on an order with a mix (at least one succeeded and one cancelled) and
   check that `total` equals the number of items submitted.
7. A cancelled order does not become `done` when its last item finishes:
   `orderState` stays `'cancelled'`.

---

## §E7 — test/runner.test.ts: an order end to end

**Create:** `test/runner.test.ts`. **Pattern file:** `test/lifecycle.test.ts`
for the database setup you just wrote, plus fact 5 for the stub. This is the
first file in the repo that uses both a database and the stub gateway, so start
both in `beforeAll` and close both in `afterAll`.

Under test: `runOnce` and `runUntilIdle` from `src/runner/run.ts`.

The workflow version your `beforeAll` creates needs a real output schema for
this file — use `{"type":"object","properties":{"brief":{"type":"string"}},
"required":["brief"]}` and have the stub answer `'{"brief":"ok"}'`.

Assert:

1. `runUntilIdle` on a three-item order reports `succeeded: 3` and leaves every
   job `succeeded`.
2. Three `job_results` rows exist for that order, each `ok`, each with
   `output` matching what the stub returned, and each with `total_tokens` 18
   (fact 5 — one attempt, so one call's usage).
3. The order closes on its own: `orderProgress` reports `orderState: 'done'`
   once the last item finishes.
4. `runOnce` with `batchSize: 2` on a three-item order claims exactly 2, and a
   second `runOnce` claims the last 1.
5. `runOnce` on an empty queue returns a summary of all zeros and makes no
   request to the stub (`stub.requests` does not grow).
6. The prompt actually reached the model: the last request's user message
   contains the item's text, so the pinned template really was rendered.

---

## §E8 — test/runner.test.ts: the failure paths

**Edit:** `test/runner.test.ts`, adding a new `describe` block. **Keep every
existing case.** Pass `random: () => 0` in the runner options wherever a
backoff is involved.

Assert:

1. With the stub answering `{ kind: 'status', status: 503 }`, one `runOnce`
   reports `retried: 1` and the job is back to `pending` — a transport failure
   is retryable.
2. After three such rounds (fact 4 between them) the job is `dead`, the summary
   reports `dead: 1`, and **no** `job_results` row exists for it — the model
   never answered, so there is nothing to record.
3. With the stub answering content that misses the schema (e.g.
   `'{"wrong":1}'`), `runOnce` reports `failed: 1`, the job is `failed`, and a
   `job_results` row exists with `ok: false`, `failure_reason:
   'schema-invalid'`, the raw text, and `attempts: 3` — the bounded re-ask
   tried three times inside one run.
4. Cancel of a **running** job aborts the call. Set the stub to
   `{ kind: 'delay', ms: 3000 }`, start `runOnce` with `heartbeatMs: 60`
   **without awaiting it**, wait ~300ms, call `cancelOrderNow`, then await the
   runner. The summary reports `cancelled: 1`, the job is `cancelled` with a
   `'cancelled'` trail entry, and no result row was written. Give this `it` a
   longer timeout — `it('…', async () => { … }, 15_000)`.
5. That cancel really did abort rather than wait: the awaited `runOnce`
   resolves well under the stub's 3000ms delay.

---

## §E9 — README.md: Phase E status and the runner in the layout

**Edit:** `README.md`. **Pattern file:** the Phase D edit already in that file —
match its wording and length exactly; this is one status paragraph and one
layout line, not a rewrite.

Do three things:

1. Update the status section to say Phase E is complete: work orders now run
   end to end. Leases are renewed by a heartbeat, a transport failure is
   retried with exponential backoff and jitter and dead-letters after three
   attempts, a dead job is requeued by verb, and cancelling an order aborts the
   in-flight model call. Results and their token counts are durable in
   `job_results`. Say plainly what is still missing: nothing enforces a budget
   or a concurrency cap yet (that is the metering phase), and there is no HTTP
   surface — no server, no dashboard.
2. Add one Layout line for `src/runner/` — the tick that claims, calls the
   gateway and records the outcome. Add one for `src/queue/lifecycle.ts` if the
   layout lists files at that granularity; otherwise fold it into the existing
   `src/queue/` line.
3. Every command shown in the README must already work — `verify.sh`'s fourth
   gate checks that. Do not add a command that does not exist.

**Gate:** `bash verify.sh` green.

---

## §E10 — Close the phase

**Edit:** `STATUS.md` and `ROADMAP.md`. **Pattern:** the `## Phase D` section
already in `STATUS.md` — same length, same voice.

1. Append a `## Phase E — the job runner` section to `STATUS.md`. Say that
   ROADMAP row #3 is complete: claim, lease, heartbeat, backoff, dead-letter,
   requeue and cancel all hold, and a completion's output and token counts are
   durable. Name the two things deliberately left: usage is recorded per job
   but nothing aggregates or enforces it, and nothing schedules the runner —
   there is no server yet.
2. In `ROADMAP.md`, flip row #3 to **SHIPPED** with phase `A, E` and a one-line
   note. Row #4's note should stop saying usage attribution is pending — it
   lands here.
3. Add these to the reservations ledger, each as one bullet:
   - **the runner has no schedule** — `runOnce` is a function nobody calls on a
     timer; wiring it to the server or a systemd timer belongs to the packaging
     phase;
   - **`max_attempts` is 3 by column default** and no caller sets it per job;
     an operator-facing knob waits for the console;
   - **jobs in a batch run one after another** — `max_concurrent_jobs` is an
     entitlement, and enforcing it belongs to the metering phase;
   - **`job_results` holds usage but nothing aggregates it** — the per-tenant
     token ledger is ROADMAP row #5.
4. Mark the two Phase D reservations this phase discharged (the version pin
   becoming NOT NULL, and usage being persisted) rather than leaving them
   reading as open.

**Gate:** `bash verify.sh` green.
