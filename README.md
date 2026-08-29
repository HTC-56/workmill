# workmill

A multi-tenant AI batch-work platform you run on your own hardware. A tenant
defines a **workflow** — a prompt template + a JSON output schema + a model
pick — then submits **work orders** of many items against it. Every item
becomes a durable job that runs through an OpenAI-compatible local-model
gateway, gets validated against the schema, and lands tenant-scoped with a
full paper trail: model, tokens, latency, spend against the tenant's budget.

Built end-to-end by an autonomous local-model coding loop; the commit history
is part of the deliverable.

Composition, not invention: the queue mechanics follow
[worklane](https://github.com/HTC-56/worklane) re-proven on Postgres inside
the tenant boundary; models are consumed through
[local-ai-gateway](https://github.com/HTC-56/local-ai-gateway)'s
OpenAI-compatible contract as an upstream service; the tenancy core follows
[tenant-kernel](https://github.com/HTC-56/tenant-kernel)'s proven shape —
RLS enforcement, catalog-driven leak suite, audited operator access.

## Status

**Phase A** — the two load-bearing mechanisms are proven:

- **Tenant isolation under RLS** across all four SQL verbs (SELECT, INSERT,
  UPDATE, DELETE). A catalog-driven leak test suite discovers every
  tenant-scoped table at runtime and proves cross-tenant access refuses by
  matching zero rows, not by throwing.
- **Durable job claiming** via `FOR UPDATE SKIP LOCKED` on Postgres, with
  leases and heartbeat.

**Phase B** — the tenancy core is complete: tenants, users, memberships,
invites, and entitlements, all under RLS, all covered by the catalog-driven
leak suite. Entitlement limits are stored but **not yet enforced**; the rest
of the spec (`SPEC.md`) is not built yet.

**Phase C** — workflows are tenant data: a prompt template with
`{{input}}`, a JSON output schema, a logical model name, temperature and
max output tokens, all under RLS and all covered by the leak suite. Edits
append a version instead of rewriting one, and a work order pins the
version it was submitted against. Three example workflows ship — extract,
classify, summarize — but **nothing runs them yet**. The gateway and the
job runner are not built, so a stored output schema is not yet validated
against any model output.

**Phase D** — model calls go through one configured OpenAI-compatible base
URL and nowhere else; a logical model name resolves through config, so
swapping the model behind `'default'` is not a data migration; output is
parsed and validated against the workflow's stored schema with a re-ask
bounded at two, and an output still invalid after them is a returned
failure, not a thrown error; token usage is read off every response.
Nothing stores those results or that usage yet — the job runner and the
token ledger are not built, so no work order runs end to end.

**Phase E** — work orders now run end to end. Leases are renewed by a
heartbeat, a transport failure is retried with exponential backoff and
jitter and dead-letters after three attempts, a dead job is requeued by
verb, and cancelling an order aborts the in-flight model call. Results
and their token counts are durable in `job_results`. Nothing enforces a
budget or a concurrency cap yet (that is the metering phase), and there
is no HTTP surface — no server, no dashboard.

**Phase F** — metering and entitlements are complete: a per-tenant token
ledger records usage in the same transaction as the result, item caps
and concurrency limits are enforced by triggers at the data layer, a
daily budget stops new submissions when spent, and an order reports
exactly when the budget ran out.

**Phase G** — the ops surface is live: `/healthz` (liveness probe),
`/metrics` (operator-bearer-protected Prometheus exposition), and
`/events` (tenant-scoped SSE stream of job and order transitions,
authenticated with a tenant bearer token). The operator bearer is read
from `WORKMILL_OPERATOR_TOKEN`; an unset value disables the operator
routes. Still missing: neither page exists yet (the console is
ROADMAP row #7), and nothing schedules the runner.

**Phase H** — the tenant dashboard is live: `GET /` serves one
self-contained HTML file with no framework, no build step, and no
external request. It pulls tenant data through the same `/api/*`
routes that `/events` uses, all behind a tenant bearer token. The
page holds the tenant token in the browser's `localStorage`; tokens
are minted by tests today. Still missing: the operator console
(ROADMAP row #7), and nothing schedules the runner or serves the
process outside tests.

## Quickstart

```bash
pnpm install
pnpm test
```

This needs no database and no model server — the default engine is PGlite, a
serverless Postgres that runs in-process.

## Engines

`pnpm test` uses PGlite by default. Set `DATABASE_URL` to run the identical
suite against a real Postgres:

```bash
docker run --rm -p 5432:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=workmill \
  postgres:17-alpine
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/workmill pnpm test
```

The PGlite run is the happy path; the real-Postgres run is the authoritative one.

## Gates

Three gates must pass for every commit:

```bash
pnpm typecheck   # tsc --noEmit — zero type errors
pnpm test        # vitest run — all tests green
bash scripts/scrub-check.sh   # public-repo gate — no secrets, no private hostnames
bash scripts/live-check.sh    # real-gateway proof — needs a real gateway and model; a human runs this before a demo deployment
```

## Layout

- `src/db/` — database engine abstraction, migration runner, PGlite and Postgres adapters
- `src/queue/` — durable job enqueue and claim with `FOR UPDATE SKIP LOCKED`
- `src/seam/` — `withTenant()` RLS seam and the leak-test catalog
- `src/tenancy/` — tenant provisioning, invites, memberships, entitlement reads
- `src/workflows/` — workflow definitions, versioning, the `{{input}}` renderer, three example workflows
- `src/gateway/` — the OpenAI-compatible client, the JSON Schema subset validator, the bounded re-ask
- `src/runner/run.ts` — the tick: claim, call the gateway, record results and usage
- `src/metering/` — the token ledger and the entitlement refusals
- `src/server/` — the HTTP app (Fastify), the auth seam, and the operator bearer guard
- `src/ops/` — events (in-process bus, SSE helpers), metrics (Prometheus exposition), the JSONL ops log
- `src/dashboard/` — the tenant dashboard page (one self-contained HTML file with no framework, no build step, no external request) and its read models
- `sql/` — numbered SQL migrations (append-only), including `sql/006_metering.sql` and `sql/007_api.sql`
- `test/` — leak suite, seam tests, claim tests, migration tests
- `scripts/` — `scrub-check.sh` public-repo gate

Routes: `GET /`, `/api/me`, `/api/workflows`, `/api/orders` (GET and POST), `/api/orders/:id`, `/api/dead`, `/api/usage`.
