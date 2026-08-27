# workmill — v1 spec

A multi-tenant AI batch-work platform you run on your own hardware. A tenant
defines a **workflow** — a prompt template + a JSON output schema + a model
pick — then submits **work orders** of many items against it. Every item
becomes a durable job that runs through an OpenAI-compatible local-model
gateway, gets validated against the schema, and lands tenant-scoped with a
full paper trail: model, tokens, latency, spend against the tenant's budget.
Built end-to-end by an autonomous local-model coding loop; the commit history
is part of the deliverable (see `docs/PROCESS.md` when it lands).

Composition, not invention: the queue mechanics follow
[worklane](https://github.com/HTC-56/worklane) re-proven on Postgres inside
the tenant boundary; models are consumed through
[local-ai-gateway](https://github.com/HTC-56/local-ai-gateway)'s
OpenAI-compatible contract as an upstream service; the tenancy core follows
[tenant-kernel](https://github.com/HTC-56/tenant-kernel)'s proven shape —
RLS enforcement, catalog-driven leak suite, audited operator access.

## v1 features (all of these, nothing more)

1. **Tenancy core under RLS** (tenant-kernel's shape): tenants, users,
   memberships (owner/admin/member), invites, entitlements; plain numbered
   `.sql` migrations applied by a tiny in-repo migrator, no ORM;
   `withTenant()` seam as the only query door; the app connects as a
   non-superuser role; a catalog-driven leak-test suite discovers every
   tenant-scoped table at runtime and proves cross-tenant SELECT / INSERT /
   UPDATE / DELETE all refuse — an unprotected table is a failing build.
   Jobs and results are tenant-scoped rows, so **the leak suite covers the
   queue itself**.
2. **Workflows as tenant data, not code.** Name + prompt template
   (`{{input}}` interpolation) + JSON Schema for the output + logical model
   name + params (temperature, max output tokens). CRUD + versioning: edits
   create a new version; every run pins the version it ran under. Three
   seeded examples: extract (text → fields), classify (text → label from a
   fixed set), summarize (doc → brief).
3. **Work orders → durable jobs on Postgres.** Submit N items (API: array
   of strings; dashboard: one-per-line textarea or CSV column pick; item
   size and count capped by entitlement) → N jobs claimed with
   `FOR UPDATE SKIP LOCKED` under leases with heartbeat; at-least-once
   delivery, documented as such; retries with exponential backoff + jitter;
   dead-letter preserving the full failure trail, requeue by verb; real
   cancel (PENDING flips; RUNNING aborts the in-flight model call and
   records that it did).
4. **Model calls through the gateway.** OpenAI-compatible HTTP to a
   configured base URL; logical model names; workmill never talks to a model
   server directly. Output validated against the workflow's schema with a
   bounded re-ask (max 2); invalid-after-retries is a first-class failure
   state, not an exception. Token usage captured from the response per job.
5. **Metering + entitlements at the data layer.** Per-tenant token ledger;
   daily token budget, max concurrent running jobs, allowed-model list —
   enforced by constraints, policies, and the claim query, not UI checks.
   Budget exhaustion refuses further claims mid-order and the order says so.
6. **The tenant dashboard.** `GET /` — one self-contained HTML page (inline
   CSS/JS, no framework, no build step, no CDN, no web fonts): workflow
   list, submit form, running orders with live per-item progress, results
   table with validated-JSON download, usage meter against budget,
   dead-letter view with requeue. The README hero screenshot.
7. **The operator console.** `GET /operator` — same self-contained-page
   rules: tenant table with state + entitlements, provision form,
   entitlement edits, support-access grants with required reason + TTL
   countdown, append-only audit trail **the tenant itself can read**
   (RLS-scoped), fleet panel (gateway health, queue depth, jobs/hour).
8. **Ops surface.** `/healthz`, `/metrics` (Prometheus text), `/events`
   (SSE job + order transitions), JSONL ops ledger, static bearer auth on
   the operator API.
9. **Demo mode + deploy-grade packaging.** A seed script provisions demo
   tenants with tight budgets and example workflows; a reset script restores
   seed state (run from a timer in the reference deployment). YAML config;
   example systemd units (workmill + its gateway); README quickstart (two
   tenants, one workflow, a five-item order through a real local model, a
   cross-tenant read refused, a budget exhaustion refused — in 10 minutes);
   GitHub Actions CI running the full suite on BOTH engines (below).
   `docs/PROCESS.md` — how three PoCs became one product, plus the
   autonomous-loop architecture in one page.

## Engines & seams — pre-registered rules

- Database rule inherited from tenant-kernel verbatim: default dev/test
  engine is **PGlite** (`@electric-sql/pglite`, real Postgres compiled to
  WASM, in-process) — `pnpm test` needs zero setup on any box.
  `DATABASE_URL` switches the SAME suite to a real Postgres server; CI runs
  a PGlite job AND a Postgres 16 service-container job. The real-Postgres
  job is authoritative.
- **Phase A must prove BOTH load-bearing mechanisms on both engines before
  anything else is built**: (a) the RLS refusal path, (b) the
  `FOR UPDATE SKIP LOCKED` claim under two competing claimants. PGlite is
  single-connection; any claim-concurrency case it cannot express is skipped
  on PGlite with the decision recorded in DECISIONS.md — recorded, never
  silent. If PGlite cannot enforce RLS at all, tests require `DATABASE_URL`
  and CI keeps only the service-container job.
- Gateway seam: tests run against an in-process stub OpenAI-compatible
  server (canned completions, canned `usage` token counts, injectable
  failures: timeout, 5xx, malformed JSON, schema-invalid output) — CI needs
  no model server. `scripts/live-check.sh` (not CI) proves the same paths
  against a real gateway + model and must pass before any demo deployment.
- Demo-mode safety is part of the spec, not the deploy: demo tenants get
  small daily budgets, low concurrency, small item caps, and the reset
  script; abuse of a public demo is bounded by the same entitlements every
  tenant gets, not by special cases.

## Non-goals (v1 refuses these)

- No billing/payments, no plans/pricing.
- No SSO, no OAuth, no password reset — opaque bearer session tokens minted
  by a CLI helper and test fixtures. Auth is a seam, not the product.
- **No arbitrary code execution.** Workflows are prompt + schema ONLY; no
  `exec` handler, no child processes touched by tenant data, no template
  logic beyond `{{input}}` substitution. A multi-tenant surface that runs
  tenant-supplied code is a spec bug here, not a feature.
- No chains, no DAGs, no cross-order dependencies.
- No RAG, no embeddings, no vector store. No streaming chat UI — this is
  batch work, not a chatbot.
- No file storage beyond capped text items; no images, no PDFs.
- No multi-box workers, no external broker, no replication, no multi-region.
- No ORM. No UI framework, no build step for either page — React/Vite/
  Next.js anywhere in this repo is a spec bug.

## Stack & shape

- TypeScript, Fastify, Zod, Vitest, pnpm; `postgres` driver;
  `@electric-sql/pglite` as dev-dependency. Dependency surface deliberately
  tiny — a task that adds a dependency must name it and why.
- Layout: `src/` (server, db, seam, queue, workflows, runner, operator,
  dashboard, console), `sql/` (numbered migrations), `test/` (unit + leak
  suite + seam + queue-claim + stub-gateway integration), `deploy/` (systemd
  unit examples, example YAML, demo seed + reset scripts), `README.md`,
  `docs/PROCESS.md`.

## Gates

- `pnpm typecheck` + `pnpm test` green at every phase end; the leak suite is
  part of `pnpm test` from the phase that creates the first tenant-scoped
  table onward.
- `bash scripts/scrub-check.sh` green from phase 1: greps the tree for
  private hostnames, non-documentation IPs, absolute home paths, and key
  material. Docs use `localhost` and `192.0.2.x` only.
- `verify.sh` = typecheck + test + scrub-check + README-quickstart lint
  (commands shown in the README must exist in the repo).

## Done means

A stranger clones the repo: `pnpm install && pnpm test` is green with no
database and no model server installed (PGlite + stub gateway); pointed at a
real Postgres via `DATABASE_URL` and a real gateway via `live-check.sh`, the
same paths hold. The README quickstart stands up two tenants, defines a
workflow, runs a five-item work order through a real local model, shows a
cross-tenant read refused at the database layer AND a budget exhaustion
refused mid-order, grants time-boxed support access with a reason, and the
tenant reads its own audit trail. Both pages breathe. CI badge green on both
engine jobs. The demo seed + reset scripts work from a clean database.
PROCESS.md tells the composition story in one page.
