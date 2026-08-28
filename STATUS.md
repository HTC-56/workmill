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
