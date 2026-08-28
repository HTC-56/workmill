# Decisions

## Locked (2026-08-27, at scaffold)

- **SPEC.md is the whole product.** v1 is the nine features there, fenced by
  its non-goals. The planning lane derives phases from SPEC.md only; it never
  invents features. When every SPEC.md feature is built and gated,
  "PROJECT SPEC COMPLETE" is the desired terminal state — declare it, do not
  find more work. This project is meant to FINISH.
- **Composition is the story.** The queue follows worklane's mechanics
  re-proven on Postgres inside the tenant boundary; the gateway is consumed
  as an upstream service over its OpenAI-compatible contract (never merged
  in, never bypassed); the tenancy core follows tenant-kernel's shape.
  Patterns are rebuilt in this repo, not copied file-for-file — the commit
  ledger is its own deliverable.
- **Stack**: TypeScript + Fastify + Zod + Vitest, pnpm; `postgres` driver;
  `@electric-sql/pglite` dev-dependency; plain SQL migrations, no ORM. The
  dashboard and operator console are each one hand-written self-contained
  HTML file — no UI framework, no build step, no external requests.
- **Engines rule is pre-registered** (SPEC.md "Engines & seams"): PGlite is
  the zero-setup default, the real-Postgres CI job is authoritative, and
  Phase A proves BOTH the RLS refusal path AND the `FOR UPDATE SKIP LOCKED`
  claim on both engines before anything else is built. PGlite is
  single-connection: claim-concurrency cases it cannot express are expected
  to be Postgres-only — skipped on PGlite and recorded here, never silent.
- **Gateway seam is pre-registered**: CI runs against an in-process stub
  OpenAI-compatible server; `scripts/live-check.sh` (not CI) is the
  real-gateway proof and gates any demo deployment.
- **Safety fence**: no arbitrary code execution — workflows are prompt +
  schema only; no child processes on any tenant-reachable path; the only
  outbound HTTP in src/ is the configured gateway base URL.
- **Gates**: `pnpm typecheck`, `pnpm test`, `bash scripts/scrub-check.sh` —
  all green at every phase end. `verify.sh` composes them plus the
  README-quickstart lint.
- **Public-repo discipline from commit 1**: this repo will be published. No
  private hostnames, no real LAN IPs (docs use `localhost` / `192.0.2.x`),
  no absolute home paths in docs or code, no key material, no references to
  other private projects — in files AND commit messages. The three public
  HTC-56 repos this product composes may be named. `scrub-check.sh` enforces
  the file half; sessions carry the commit-message half.
- **Neutral git identity** until the publish decision (human-gated).

## Human-gated (never resolved by the loop)

- Publishing: flipping the repo public, name confirmation, license choice
  (default intent: MIT).
- The demo deployment itself: host, tunnel mechanism, public URL, reset
  timer. The repo ships the scripts; a human runs them.
- Any scope beyond SPEC.md v1.

## Open Questions

*(none — SPEC.md answers v1 in full)*

## Recorded during Phase A (2026-08-27) — measured, not assumed

These are results, not choices. The engines rule pre-registered what to measure;
this is what the measurement said.

- **PGlite enforces RLS in full.** Under `SET LOCAL ROLE workmill_app`, a
  cross-tenant SELECT returns nothing, a cross-tenant INSERT raises `new row
  violates row-level security policy`, and a cross-tenant UPDATE/DELETE reports
  zero rows affected with the victim row intact. The SPEC.md fallback ("if
  PGlite cannot enforce RLS at all, tests require `DATABASE_URL`") is therefore
  **not triggered** — both CI engine jobs stay.
- **Refusal shape differs by verb**, and leak-suite assertions must too: INSERT
  refuses with a thrown error (`WITH CHECK`), while SELECT/UPDATE/DELETE refuse
  by filtering to zero rows (`USING`). An UPDATE test written to expect a thrown
  error is testing the wrong thing.
- **The two-competing-claimants case is Postgres-only** (pre-registered).
  PGlite serves one connection, so two overlapping transactions cannot exist.
  It is skipped there, and `test/claim.test.ts` asserts the skip matches the
  engine's own `supportsConcurrentSessions` flag — the authoritative job cannot
  skip it quietly.
- **The Postgres half of Phase A's proof is unverified on the build box**: it
  has no Postgres server and no docker permission. The `postgres` CI job is the
  only place it executes. Treat a first green run of that job as the completion
  of Phase A's pre-registered proof.
- **Claim order is `(run_at, created_at, order_id, idx)`, not `id`.** Every item
  of one order shares a `created_at`, so a uuid tiebreak shuffles a five-item
  order into random order. Related: `UPDATE … RETURNING` has no defined row
  order in Postgres, so the claim wraps its update in a CTE and sorts the
  output. Both are commented at the query in `src/queue/claim.ts`.
- **Tenant-scoped tables declare themselves** with
  `COMMENT ON TABLE x IS 'tenant-scoped:<column>'`. The leak suite discovers
  them from the catalog at runtime; there is no hand-maintained list of what to
  check. Adding a tenant-scoped table means adding its marker, its policies, and
  one fixture in `test/leak.test.ts`.

## Recorded during Phase E (2026-08-28) — measured, not assumed

Two of these are bugs the runner's migration exposed rather than caused. Both had
been latent since Phase A and both were found by running the existing suite, not
by reading it.

- **`UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED LIMIT $1)` does not
  bound the claim.** The planner may treat the subquery as a re-runnable subplan,
  and the LIMIT then applies to each evaluation rather than to the statement. The
  shape was correct for two phases and broke the day `sql/005_runner.sql` added a
  unique index that shifted the plan: a claim for three jobs took five, then four
  — nondeterministically, on the same data. `src/queue/claim.ts` now computes the
  candidate set in a `WITH … AS MATERIALIZED` CTE, which is evaluated exactly
  once by definition. A claim query without `MATERIALIZED` is a latent bug even
  when its tests are green, because what makes it wrong is a cost estimate.
- **PGlite's nesting guard could not tell nesting from concurrency.** It tracked
  "a transaction is open" in a boolean and rejected any second caller. That is
  right for a call made from inside a transaction callback (which would queue
  behind its own parent and hang) and wrong for a call made from elsewhere while
  one happens to be open — which the promise queue already serialises correctly.
  The runner's heartbeat is the second kind, so it would have been rejected at
  random depending on timing. `src/db/pglite.ts` now uses `AsyncLocalStorage`, so
  the flag is set only inside the callback's own async context.
- **A cancel of a running job aborts a real socket, on PGlite, in-process.** With
  the stub answering after 3000ms and a 60ms heartbeat, the runner aborts and
  records the cancellation in roughly 300ms. SPEC.md feature 3's "RUNNING aborts
  the in-flight model call and records that it did" is therefore proven on the
  zero-setup engine, not deferred to a real server.
- **`jsonb_build_object` will not infer a parameter's type.** An untyped `$n`
  inside it is `unknown` to the planner and the statement is refused with "could
  not determine data type", even when the same parameter is used elsewhere in the
  statement in a text context. Every parameter inside one is cast explicitly in
  `src/queue/lifecycle.ts`.
