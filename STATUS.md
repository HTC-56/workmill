# Status

Repo scaffolded 2026-08-27. Nothing built yet. SPEC.md is the product;
DECISIONS.md locks the fence; ROADMAP.md is the scoreboard. The planning lane
authors Phase A from SPEC.md (Phase A must prove the RLS refusal path AND the
`FOR UPDATE SKIP LOCKED` claim on both engines before anything else is
built).

Per-phase sections append below as phases ship.

## Phase A — the two proofs

Phase A proves two load-bearing mechanisms, each half verified by a different engine.

- **Four-verb tenant isolation** (SELECT, INSERT, UPDATE, DELETE) holds on every
  catalog-discovered `tenant-scoped` table — PGlite enforces RLS fully: cross-tenant
  SELECT returns zero rows, INSERT raises a policy violation, UPDATE/DELETE match
  zero rows with victim data intact.
- **`FOR UPDATE SKIP LOCKED` queue claim** works correctly on Postgres: deterministic
  ordering via `(run_at, created_at, order_id, idx)`, no shuffling of related items.

PGlite proved the RLS half (running in every CI job). The Postgres half (concurrent
claimants) runs only in the `postgres` CI job — this build box has no Postgres server.
See [DECISIONS.md §Recorded during Phase A](DECISIONS.md) for measured results.

## Phase B — the tenancy core is complete

Five nouns from SPEC.md feature 1 now exist, all under RLS: tenants, memberships,
invites, entitlements, and defaults. The leak suite proves all four verbs (SELECT,
INSERT, UPDATE, DELETE) plus the re-home refusal across seven tables. Entitlement
numbers are stored but not yet enforced.

## Phase C — workflows are tenant data

The `workflows` and `workflow_versions` tables live under RLS, so the catalog-driven
leak suite now proves nine tenant-scoped tables. Editing a workflow appends a version;
a work order pins the version it ran under. Three example workflows ship (extract,
classify, summarize). The `{{input}}` substitution is the entire template language —
a deliberate non-goal that prevents code execution. Nothing yet executes a workflow,
so the stored output schema has not met a model's output.

## Phase D — model calls through the gateway

One configured base URL is the only outbound HTTP in `src/`; logical model names
resolve through config. The stored output schema finally meets a model's output,
validated against a documented subset of JSON Schema and re-asked at most twice; an
invalid-after-re-asks output is a returned failure carrying its errors, raw text and
token usage, not an exception. Every gateway path is proven against the in-process
stub and `scripts/live-check.sh` proves the same contract against a real gateway.
Results and usage are now persisted in `job_results` (Phase E), but nothing
aggregates or enforces usage — the token ledger is ROADMAP row #5.

## Phase E — the job runner

ROADMAP row #3 is complete: claim, lease, heartbeat, backoff, dead-letter, requeue
and cancel all hold, and a completion's output and token counts are durable. The
lifecycle engine tracks attempt counts, retries with exponential backoff, and moves
jobs to a dead-letter queue after three failures; `cancelOrder` marks an order so
`runOnce` aborts the next tick. Results and usage are persisted in `job_results`,
one row per job, with summed token counts across all gateway calls.

Two things are deliberately left: usage is recorded per job but nothing aggregates
or enforces it, and nothing schedules the runner — there is no server yet.

## Phase F — metering and entitlements

The `token_ledger` table lives under RLS and is billed in the same transaction as
the job result. Item caps are enforced by SQL triggers on `token_ledger_items`; the
concurrency cap and the daily budget are enforced inside the claim query so the
queue refuses to hand out work when limits are reached. Budget exhaustion stamps
the order (it says why) but does not cancel a running job.

Nothing serves any of this over HTTP, and `DEFAULT_ENTITLEMENTS` is still provisional.

## Phase G — the ops surface

Three routes now exist and are covered by tests: `/healthz` (liveness probe),
`/metrics` (Prometheus exposition behind the operator bearer), and `/events`
(tenant-scoped SSE stream of job and order transitions, authenticated with a
tenant bearer). `api_tokens` makes twelve tenant-scoped tables the leak suite
proves. `/metrics` sits behind the operator bearer and carries no tenant labels.
The runner publishes transitions to an in-process bus when given one. Deliberately
left: no page renders any of it, and nothing schedules the runner or serves the
process.

## Phase I — the operator console

`GET /operator` serves one self-contained HTML file behind the operator bearer.
A support grant is a row with a required reason and a mandatory expiry, so a grant
with no justification or no end cannot be written. Every operator write appends an
audit row in the same transaction as the change, and the tenant reads those rows
with its own bearer at `GET /api/audit`. `support_grants` and `audit_log` make
fourteen tenant-scoped tables the leak suite proves. Deliberately left: demo mode
and deploy packaging are ROADMAP row #9, and nothing schedules the runner or serves
the process.

## Phase H — the tenant dashboard

`GET /` serves one self-contained HTML file — no framework, no build step, no
external request. The page is made of six panels: a workflow selector, a submit
form, an orders table with per-item progress, a results view with a validated-
JSON download, a usage meter, and the dead letter with requeue. Every panel is
driven by a `/api/*` route behind the tenant bearer, and the tenant is never a
request parameter. The operator console is ROADMAP row #7, and nothing schedules
the runner or serves the process outside tests.

## Phase J — demo mode and deploy-grade packaging

workmill is a process now — `src/main.ts` opens the engine, migrates, serves both
pages and the API, and ticks the runner on a non-overlapping timer, stopping
runner-then-listener-then-engine. Config is one YAML file with an environment
override for every field and two secrets the file refuses to hold. The demo is two
ordinary tenants with small entitlements, seeded and reset by scripts that refuse
to run against the in-process engine because its database dies with the process.
`deploy/` carries example units and CI now runs `verify.sh` and `pnpm build`.
Deliberately left: the demo DEPLOYMENT is human-gated (host, tunnel, public URL,
reset cadence — DECISIONS.md), and `DEFAULT_ENTITLEMENTS` is still provisional.
