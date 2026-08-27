# Roadmap — the v1 scoreboard

One row per SPEC.md feature. The planning lane keeps status current; row edits here
are the one permitted exception to append-only docs.

| # | Feature (SPEC.md) | Status | Phase | Note |
|---|---|---|---|---|
| 1 | Tenancy core under RLS + leak-test suite | PARTIAL | A | RLS + catalog-driven leak suite proven, queue tables included; users/memberships/invites/entitlements not built |
| 2 | Workflows as tenant data (template + schema + model, versioned) | NOT BUILT | — | |
| 3 | Work orders → durable jobs on Postgres (SKIP LOCKED, leases, DLQ, cancel) | PARTIAL | A | orders, jobs and the SKIP LOCKED claim proven inside the tenant boundary; leases, retries, DLQ, cancel deferred |
| 4 | Model calls through the gateway (schema validation, bounded re-ask, usage capture) | NOT BUILT | — | stub server in CI |
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
- **users, memberships, invites and entitlements** — the rest of ROADMAP row #1;
- **`verify.sh` does not yet run `scripts/live-check.sh`** — that lands with the
  gateway;
- **the CI workflow will need a `verify` step** once more gates exist.
