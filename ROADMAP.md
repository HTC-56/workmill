# Roadmap — the v1 scoreboard

One row per SPEC.md feature. The planning lane keeps status current; row edits here
are the one permitted exception to append-only docs.

| # | Feature (SPEC.md) | Status | Phase | Note |
|---|---|---|---|---|
| 1 | Tenancy core under RLS + leak-test suite | SHIPPED | A, B, G | five nouns built and leak suite covers every one of them; Phase G's `api_tokens` brings it to twelve tenant-scoped tables |
| 2 | Workflows as tenant data (template + schema + model, versioned) | SHIPPED | C | definitions, versioning and the order pin are complete as tenant data; the pages that expose them are rows #6 and #7 |
| 3 | Work orders → durable jobs on Postgres (SKIP LOCKED, leases, DLQ, cancel) | SHIPPED | A, E | claim proven in A; E adds lifecycle (heartbeat, backoff, dead-letter, requeue, cancel), runner tick, and durable `job_results` with output and token counts |
| 4 | Model calls through the gateway (schema validation, bounded re-ask, usage capture) | SHIPPED | D, E | client, JSON Schema subset validator and the bounded re-ask with usage capture, proven against the stub; usage attributed to jobs in `job_results`; aggregating it is the ledger (row #5) |
| 5 | Metering + entitlements at the data layer | SHIPPED | F | `token_ledger` under RLS, item caps as triggers, concurrency cap and daily budget in the claim query, budget exhaustion stamps orders; nothing serves it over HTTP yet |
| 6 | Tenant dashboard (self-contained page) | NOT BUILT | — | hero screenshot |
| 7 | Operator console (grants, audit, fleet panel) | NOT BUILT | — | |
| 8 | Ops surface (/healthz, /metrics, /events, ledger, auth) | PARTIAL | G | routes, both bearers and the JSONL ledger are committed; Phase G's remaining tasks are their tests and the docs |
| 9 | Demo mode + deploy-grade packaging (seed/reset, config, units, dual-engine CI, quickstart) | PARTIAL | A | dual-engine CI landed early — it is the only place the Postgres half of Phase A's proof runs; everything else pending |
| — | docs/PROCESS.md (three PoCs → one product, the loop story) | NOT BUILT | — | written near the end, when there is a ledger to excerpt |

When every row reads SHIPPED and verify.sh is green, the project is done — the
planning lane declares PROJECT SPEC COMPLETE rather than inventing scope.

## Reservations ledger — small deferred calls recorded inside phase specs

- **job lifecycle beyond claim** — heartbeat, lease reaper, retries with backoff,
  dead-letter, cancel — deferred to the phase that builds the runner; **Discharged
  in Phase E**: all four mechanisms are committed and tested;
- **users, memberships, invites and entitlements** — the rest of ROADMAP row #1;
  discharged in Phase B;
- **`verify.sh` does not yet run `scripts/live-check.sh`** — that lands with the
  gateway;
- **the CI workflow will need a `verify` step** once more gates exist;
- **entitlement enforcement** — budget refusal, concurrency cap, allowed-model check —
  belongs to the metering phase;
- **`DEFAULT_ENTITLEMENTS` values** in `src/tenancy/provision.ts` are provisional
  starting values, to be tuned when there is a token ledger to measure against.
- ~~**`work_orders.workflow_version_id`** is nullable for now; the runner phase makes it
  `NOT NULL` once the submit path always supplies a version.~~ **Discharged in Phase E**
  (`sql/005_runner.sql`); `enqueueOrder` now takes the pin as a required argument.
- **The output schema is stored but not validated** against a model's output until the
  gateway phase (feature 4) ships. **Discharged in Phase D**: `src/gateway/schema.ts`
  validates against a documented subset of JSON Schema; re-ask loops in
  `src/gateway/complete.ts` use it.
- **The validator covers a documented subset of JSON Schema** and ignores keywords
  outside it; widening it waits until a real workflow needs one.
- ~~**Usage is captured per call but persisted nowhere yet** — the result and its token
  counts vanish when the process restarts; durability belongs to the runner phase.~~
  **Discharged in Phase E**: `job_results` holds the output, the raw text and the
  summed token counts, one row per job.
- **the runner has no schedule** — `runOnce` is a function nobody calls on a
  timer; wiring it to the server or a systemd timer belongs to the packaging
  phase;
- **`max_attempts` is 3 by column default** and no caller sets it per job;
  an operator-facing knob waits for the console;
- **jobs in a batch run one after another** — `max_concurrent_jobs` is an
  entitlement, and enforcing it belongs to the metering phase;
- **`job_results` holds usage but nothing aggregates it** — the per-tenant
  token ledger is ROADMAP row #5.
- **`scripts/live-check.sh` exists but neither CI nor `verify.sh` runs it** — it
  requires a real gateway, and a human runs it before a demo deployment.
- **a tenant with no entitlements row has no limits** — a named fail-open seam;
  making it fail-closed waits until no test fixture makes a bare tenant;
- **two runners claiming at the same instant** can exceed `max_concurrent_jobs` by
  the headroom each one sees, because the cap is read from a snapshot inside the
  claim; one runner never exceeds it, and the lease bounds the damage;
- ~~**Usage is captured per call but persisted nowhere yet** — the result and its
  token counts vanish when the process restarts; durability belongs to the runner
  phase.~~ **Discharged in Phase F**: `token_ledger` holds usage under RLS, billed
  in the same transaction as the result.
- ~~**`job_results` holds usage but nothing aggregates it** — the per-tenant token
  ledger is ROADMAP row #5.~~ **Discharged in Phase F**: `token_ledger` aggregates
  usage per tenant, per day, and per order.
- **`DEFAULT_ENTITLEMENTS` is still provisional** — there is a ledger to measure
  against now, but no real-model corpus to measure;
- **the budget refuses, it does not reserve** — a job already claimed finishes and
  is billed even if that takes the tenant past the budget.
