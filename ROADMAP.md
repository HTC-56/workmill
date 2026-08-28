# Roadmap — the v1 scoreboard

One row per SPEC.md feature. The planning lane keeps status current; row edits here
are the one permitted exception to append-only docs.

| # | Feature (SPEC.md) | Status | Phase | Note |
|---|---|---|---|---|
| 1 | Tenancy core under RLS + leak-test suite | SHIPPED | A, B | five nouns built and leak suite covers every one of them |
| 2 | Workflows as tenant data (template + schema + model, versioned) | SHIPPED | C | definitions, versioning and the order pin are complete as tenant data; the pages that expose them are rows #6 and #7 |
| 3 | Work orders → durable jobs on Postgres (SKIP LOCKED, leases, DLQ, cancel) | PARTIAL | A, E | claim proven in A; E adds the lifecycle (heartbeat, backoff, dead-letter, requeue, cancel), the runner tick and the durable `job_results` row — §E1–§E3 committed, tests §E4–§E8 open |
| 4 | Model calls through the gateway (schema validation, bounded re-ask, usage capture) | SHIPPED | D, E | client, JSON Schema subset validator and the bounded re-ask with usage capture, proven against the stub; E attributes each call's usage to its job in `job_results`, and aggregating it is the ledger (row #5) |
| 5 | Metering + entitlements at the data layer | NOT BUILT | — | |
| 6 | Tenant dashboard (self-contained page) | NOT BUILT | — | hero screenshot |
| 7 | Operator console (grants, audit, fleet panel) | NOT BUILT | — | |
| 8 | Ops surface (/healthz, /metrics, /events, ledger, auth) | NOT BUILT | — | |
| 9 | Demo mode + deploy-grade packaging (seed/reset, config, units, dual-engine CI, quickstart) | PARTIAL | A | dual-engine CI landed early — it is the only place the Postgres half of Phase A's proof runs; everything else pending |
| — | docs/PROCESS.md (three PoCs → one product, the loop story) | NOT BUILT | — | written near the end, when there is a ledger to excerpt |

When every row reads SHIPPED and verify.sh is green, the project is done — the
planning lane declares PROJECT SPEC COMPLETE rather than inventing scope.

## Reservations ledger — small deferred calls recorded inside phase specs

- **job lifecycle beyond claim** — heartbeat, lease reaper, retries with backoff,
  dead-letter, cancel — deferred to the phase that builds the runner;
- **users, memberships, invites and entitlements** — the rest of ROADMAP row #1; discharged in Phase B;
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
  gateway phase (feature 4) ships.
- **The validator covers a documented subset of JSON Schema** and ignores keywords
  outside it; widening it waits until a real workflow needs one.
- ~~**Usage is captured per call but persisted nowhere yet** — the result and its token
  counts vanish when the process restarts; durability belongs to the runner phase.~~
  **Discharged in Phase E**: `job_results` holds the output, the raw text and the
  summed token counts, one row per job.
- **`scripts/live-check.sh` exists but neither CI nor `verify.sh` runs it** — it
  requires a real gateway, and a human runs it before a demo deployment.
