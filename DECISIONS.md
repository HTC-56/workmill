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
