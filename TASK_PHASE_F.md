# Phase F — metering and entitlements at the data layer

**ROADMAP row:** #5 *Metering + entitlements at the data layer*, currently NOT
BUILT. Migration 003 created the `entitlements` table and said out loud that
nothing enforced it. This phase is where the numbers start refusing things: a
per-tenant token ledger, item caps enforced by database triggers, a
concurrency cap and a daily token budget enforced inside the claim query, and
an order that says why it stopped when the budget runs out.

**Already committed (do not rebuild):** `sql/006_metering.sql` (the
`token_ledger` table under RLS, `work_orders.blocked_reason` / `blocked_at`,
and the two BEFORE INSERT triggers), `src/metering/ledger.ts` (`recordUsage`,
`tokensUsedToday`, `tokensUsedForOrder`, `usageByDay`), `src/metering/limits.ts`
(`readLimits`, `assertSubmitAllowed`, `budgetStatus`, `blockOpenOrders`,
`clearOrderBlocks`, `EntitlementRefusedError`, `BUDGET_EXHAUSTED`), plus the
wiring: `finishJob` writes the ledger row, `enqueueOrder` calls
`assertSubmitAllowed`, `claimJobs` derives its own LIMIT from the entitlements
row and the day's ledger, `runOnce` stamps blocked orders and reports
`blocked`. The leak suite already has its `token_ledger` fixture. Sections
§F1–§F4 are those commits; the tasks below start at §F5. **Every task below
writes tests or docs — no task in this phase needs you to write new `src/`
code.**

**Gate for every task below** (all three, always):
`pnpm typecheck` && `pnpm test` && `bash scripts/scrub-check.sh`.

**Eight facts that will cost you a red gate if you guess them wrong:**

1. **`makeTenant` is the wrong helper for this phase.** It makes a tenant with
   NO entitlements row, and a tenant with no entitlements row has no limits —
   every refusal you are trying to assert simply will not happen. Use
   `provisionTenant` from `src/tenancy/provision.ts` with an `entitlements`
   override, e.g. `{ dailyTokenBudget: 100, maxConcurrentJobs: 2,
   maxItemsPerOrder: 3, maxItemChars: 20, allowedModels: ['default'] }`. It
   returns `{ tenantId, ownerUserId, membershipId, entitlementsId }` — the id
   you want is `tenantId`. `test/tenancy.test.ts` shows the call.
2. **A workflow slug is 3–40 lowercase characters** (`workflows_slug_check`).
   `'w'` fails; `'ledger-fixture'` passes. Every order must pin a workflow
   version, so make one workflow and one `workflow_versions` row in
   `beforeAll` under `withAdmin` and reuse its id — copy the `beforeAll` block
   of `test/claim.test.ts`.
3. **`sum()` and `count(*)` come back as strings** on the server driver and
   numbers on PGlite. The ledger functions already do the `Number()` for you;
   any raw `sql.query` you write yourself must do it too.
4. **The stub gateway** (`test/helpers/stub-gateway.ts`): `startStubGateway()`
   gives `stub.baseUrl`, `stub.requests`, `stub.queue(...)`,
   `stub.setDefault(b)`, `stub.close()`. A `{ kind: 'content', content }`
   behaviour reports **11 prompt + 7 completion = 18 total** tokens per call.
   Its out-of-the-box answer is `'{}'`, which fails a schema with `required`,
   so call `stub.setDefault({ kind: 'content', content: '{"brief":"ok"}' })`
   when you want a job to succeed.
5. **Both an ok and a failed answer are billed.** The tokens were spent either
   way, so `finishJob` writes a `token_ledger` row for both. Only a `dead` job
   (the model never answered) has no ledger row.
6. **`assertSubmitAllowed` throws `EntitlementRefusedError`**, which carries
   `.reason` — one of `'too-many-items'`, `'item-too-long'`,
   `'model-not-allowed'`. Match on `.reason`, not on message text.
7. **The triggers raise a Postgres error, not a JS one.** Assert with
   `await expect(...).rejects.toThrow(/max_item_chars/)` — the message names
   the entitlement.
8. `noUncheckedIndexedAccess` is on, so `rows[0]` is possibly-undefined: use
   `rows[0]!`. Close the stub and the db in `afterAll` or the run hangs.

---

## §F5 — test/ledger.test.ts: the token ledger

**Create:** `test/ledger.test.ts`. **Pattern file:** `test/lifecycle.test.ts`
for the database setup and the `withTenant` call shape.

Under test: `recordUsage`, `tokensUsedToday`, `tokensUsedForOrder` and
`usageByDay` from `src/metering/ledger.ts`.

Set-up: one provisioned tenant (fact 1), one workflow version (fact 2), and
one order via `enqueueOrder` whose job ids you keep. `recordUsage` takes
`{ jobId, orderId, model, usage: { promptTokens, completionTokens,
totalTokens } }` and needs a real job row, so bill the jobs that order made.

Assert:

1. A fresh tenant has `tokensUsedToday` of 0 and `usageByDay` of `[]`.
2. Billing two jobs of one order sums: `tokensUsedToday` and
   `tokensUsedForOrder` both report the total of the two.
3. **The ledger does not double-bill.** Calling `recordUsage` twice for the
   SAME `jobId` with different numbers leaves one row, and the total reflects
   the second call only — that is at-least-once delivery made safe.
4. `usageByDay` returns one entry for today with `totalTokens` matching, a
   `jobs` count matching the number of billed jobs, and a `day` string of the
   form `YYYY-MM-DD`.
5. A second provisioned tenant that bills nothing still reports 0 — the ledger
   is tenant-scoped and one tenant's spend is invisible to the other.

---

## §F6 — test/limits.test.ts: what a submission is refused for

**Create:** `test/limits.test.ts`. **Pattern file:** `test/tenancy.test.ts`
for `provisionTenant`, plus §F5's `beforeAll` for the workflow version.

Under test: `readLimits` and `assertSubmitAllowed` from
`src/metering/limits.ts`, reached both directly and through `enqueueOrder`
(which calls it before it writes a single row).

Provision the tenant with the tight numbers in fact 1 so the caps are easy to
cross.

Assert:

1. `readLimits` returns the provisioned numbers for a provisioned tenant, and
   `null` for a tenant made with `makeTenant` — a missing entitlements row is
   an absence, not an exception.
2. `enqueueOrder` with more items than `maxItemsPerOrder` rejects with
   `EntitlementRefusedError` and `.reason === 'too-many-items'`.
3. `enqueueOrder` with one item longer than `maxItemChars` rejects with
   `.reason === 'item-too-long'`.
4. **The refusal happens before anything is written**: after case 2, no new
   `work_orders` row exists for the tenant. Count under `withTenant`.
5. `assertSubmitAllowed` against a workflow version whose `model` is not in
   `allowedModels` rejects with `.reason === 'model-not-allowed'`. Make a
   second version with `model = 'forbidden'` under `withAdmin` for this.
6. A submission inside every limit succeeds and returns as many job ids as it
   had items.

---

## §F7 — test/limits.test.ts: the caps are in the database, not the code

**Edit:** `test/limits.test.ts`, adding a new `describe` block. **Keep every
existing case.**

Under test: the two BEFORE INSERT triggers from `sql/006_metering.sql`. The
point of these cases is the difference between a limit and a check: §F6 proved
the submit path refuses, this proves the DATABASE refuses, so hand-written SQL
that skips `enqueueOrder` cannot get past it either.

Write the inserts by hand with `sql.query`, not through `enqueueOrder`.

Assert:

1. Inserting a `jobs` row whose `input` is longer than the tenant's
   `max_item_chars` is rejected, and the error message names
   `max_item_chars` (fact 7). Insert its `work_orders` row first.
2. The same insert is rejected under `withAdmin` too — the cap is not a
   property of which role is writing.
3. Inserting a `work_orders` row whose `item_count` exceeds
   `max_items_per_order` is rejected and names `max_items_per_order`.
4. An insert inside both caps succeeds, so the trigger refuses the wrong rows
   rather than all of them.
5. The same oversized insert for a `makeTenant` tenant — no entitlements row —
   succeeds. That is the fail-open seam `sql/006_metering.sql` names in its
   header, and it is deliberate: assert it so it cannot change by accident.

---

## §F8 — test/limits.test.ts: the budget and the order's reason

**Edit:** `test/limits.test.ts`, adding a new `describe` block. **Keep every
existing case.**

Under test: `budgetStatus`, `blockOpenOrders` and `clearOrderBlocks`. Spend
tokens with `recordUsage` (§F5) rather than by running anything — this file has
no gateway.

Assert:

1. Before any spend, `budgetStatus` reports `used: 0`, `remaining` equal to
   `dailyTokenBudget`, and `exhausted: false`.
2. After billing more tokens than the budget, `used` is the amount billed,
   `remaining` is 0 — never negative — and `exhausted` is true.
3. A tenant with no entitlements row reports `budget: null`,
   `remaining: null`, `exhausted: false`.
4. `blockOpenOrders` stamps an open order that still has pending jobs:
   `blocked_reason` reads `'daily-token-budget-exhausted'` and `blocked_at` is
   set. It returns 1.
5. Running it a second time returns 0 — an order already stamped is not
   stamped again.
6. `clearOrderBlocks` puts both columns back to null.
7. An order whose jobs have all finished is NOT stamped: it stopped because it
   was done, not because the budget ran out.

---

## §F9 — test/claim.test.ts: the claim query enforces the entitlements

**Edit:** `test/claim.test.ts`, adding a new `describe` block. **Keep every
existing case, and do not touch the two-competing-claimants skip.**

The existing file's tenant comes from `makeTenant` and so has no limits, which
is exactly why the cases below need their own provisioned tenant and their own
workflow version, made in the new block's own `beforeAll` (fact 1, fact 2).
Provision with `maxConcurrentJobs: 2` and `dailyTokenBudget: 100`.

Under test: `claimJobs` from `src/queue/claim.ts`. Nothing about its signature
changed — the enforcement is inside the query.

Assert:

1. With three pending jobs and `maxConcurrentJobs: 2`, a claim asking for
   `limit: 10` returns exactly **2**. The cap wins over the caller's number.
2. A second claim immediately after returns **0** — two jobs are already
   running, so there is no headroom.
3. Releasing one (`UPDATE jobs SET state='pending', lease_expires_at=NULL`
   under `withAdmin`) lets the next claim take exactly 1.
4. After billing more than `dailyTokenBudget` with `recordUsage` and putting
   every job back to pending, a claim returns **0** — a spent budget refuses
   the claim itself, with no runner involved.
5. The original `makeTenant` tenant in this file still claims its full
   `limit` — no entitlements row, no cap. This is the case that proves the
   cases above are measuring the entitlement and not something else.

---

## §F10 — test/metering.test.ts: the runner bills and reports

**Create:** `test/metering.test.ts`. **Pattern file:** `test/runner.test.ts` —
copy its `beforeAll`/`afterAll` shape wholesale (database + stub gateway,
`gatewayConfig()` and `runnerOpts()` helpers), then change the tenant to a
provisioned one (fact 1) with `dailyTokenBudget: 30` and
`maxConcurrentJobs: 1`.

Under test: `runOnce` and `runUntilIdle` from `src/runner/run.ts`, end to end
against the stub.

Assert:

1. One `runOnce` on a four-item order claims exactly **1** — the runner asks
   for `batchSize` and the claim query gives it the cap.
2. That job's tokens are in the ledger: `tokensUsedForOrder` is greater than
   0, and `tokensUsedToday` equals it.
3. `runUntilIdle` then stops with `blocked` of at least 1 rather than
   spinning, and the order's `blocked_reason` reads
   `'daily-token-budget-exhausted'`.
4. **The blocked order is still `open`**, and its remaining jobs are still
   `pending`. A budget block is not a cancel: nothing is lost, and the work
   resumes when there is budget again.
5. Raising the tenant's `daily_token_budget` (an `UPDATE entitlements` under
   `withAdmin`) and ticking again clears `blocked_reason` and claims work
   once more.

---

## §F11 — README.md: Phase F status and the metering layout

**Edit:** `README.md`. **Pattern:** the Phase E paragraph and Layout list you
are appending next to — match their length and tone, and do not restructure
the file.

Three edits, nothing else:

1. The status paragraph: Phase F is done — a per-tenant token ledger, item
   caps and a concurrency cap and a daily budget all enforced at the data
   layer, and an order that says when the budget stopped it. Still missing:
   no HTTP surface, no dashboard, nothing schedules the runner.
2. One Layout line for `src/metering/` — the token ledger and the entitlement
   refusals.
3. One line in the migrations list for `sql/006_metering.sql`, matching how
   the other migrations are listed there.

**Every command shown in README.md must already exist** — `verify.sh`'s fourth
gate lints exactly that, so do not add a `pnpm <name>` that is not in
`package.json`. Gate: `bash verify.sh` green.

---

## §F12 — Close the phase

**Edit:** `STATUS.md` (append only) and `ROADMAP.md` (row edit + ledger).

1. Append a `## Phase F — metering and entitlements` section to `STATUS.md`,
   in the voice of the Phase E section above it: the ledger is per-tenant and
   billed in the same transaction as the result; item caps are triggers, the
   concurrency cap and the daily budget are in the claim query; budget
   exhaustion stamps the order and does not cancel it. Say plainly what is
   still missing: nothing serves any of this over HTTP, and
   `DEFAULT_ENTITLEMENTS` is still provisional.
2. In `ROADMAP.md`, flip row **#5** to `SHIPPED`, phase `F`, with a one-line
   note. Leave every other row alone.
3. Add these four entries to the ROADMAP reservations ledger, and strike
   through the two the ledger already carries that this phase discharged (the
   `job_results` aggregation one and the `max_concurrent_jobs` one), the way
   earlier phases struck theirs:
   - a tenant with **no entitlements row has no limits** — a named fail-open
     seam; making it fail-closed waits until no test fixture makes a bare
     tenant;
   - **two runners claiming at the same instant** can exceed
     `max_concurrent_jobs` by the headroom each one sees, because the cap is
     read from a snapshot inside the claim; one runner never exceeds it, and
     the lease bounds the damage;
   - **`DEFAULT_ENTITLEMENTS` is still provisional** — there is a ledger to
     measure against now, but no real-model corpus to measure;
   - **the budget refuses, it does not reserve** — a job already claimed
     finishes and is billed even if that takes the tenant past the budget.

Gate: `bash verify.sh` green.
