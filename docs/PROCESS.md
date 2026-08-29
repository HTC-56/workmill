# Process — three PoCs became one product

This page explains how workmill was built and what it is. Every fact here is
checkable against files in this repo.

## The composition half

workmill is composed from three public repos — each one a proof that was
re-proven, not copied file-for-file, and united by a single tenant boundary.

**worklane** ([github.com/HTC-56/worklane](https://github.com/HTC-56/worklane))
contributed the queue mechanics: `FOR UPDATE SKIP LOCKED` claim queries,
time-limited leases, heartbeat renewal, backoff on failure, and the dead-letter
queue. These patterns live here as tenant-scoped SQL migrations applied by the
in-repo migrator.

**local-ai-gateway**
([github.com/HTC-56/local-ai-gateway](https://github.com/HTC-56/local-ai-gateway))
is consumed as an upstream service over its OpenAI-compatible contract. It is
never merged into this repo; workmill sends it prompts and reads back validated
JSON with usage metadata.

**tenant-kernel** ([github.com/HTC-56/tenant-kernel](https://github.com/HTC-56/tenant-kernel))
contributed the tenancy core: RLS enforcement, the catalog-driven leak suite that
discovers every tenant-scoped table at runtime and proves cross-tenant
`SELECT` / `INSERT` / `UPDATE` / `DELETE` all refuse, and audited operator
access.

Patterns were rebuilt in this repo, not copied file-for-file. The thing that
makes them a product rather than three demos is that they share one tenant
boundary. The queue is inside RLS, so the leak suite covers the queue itself.

## The loop half

This repo was built by an autonomous local-model coding loop.

`TODO.md` is the work queue, ordered from top to bottom. Each task points at one
greppable section of a `TASK_PHASE_<letter>.md` spec file. A local model reads
the first unchecked task, implements it against the spec, and may only commit
when three gates are green:

- `pnpm typecheck` — the TypeScript compiler is the type referee;
- `pnpm test` — the test suite is the behavior referee;
- `bash scripts/scrub-check.sh` — the public-repo gate; no private hostnames,
  no home paths, no LAN addresses.

The composed script `verify.sh` runs all four gates (the fourth is a README
command lint). An autonomous loop needs a definition of done it cannot argue
with, and these gates provide one.

When the task list runs dry, a planning lane writes the next phase by reading
SPEC.md and producing a new `TASK_PHASE_<letter>.md` and the corresponding
`TODO.md` entries. `BLOCKED.md` is the escape hatch when a task cannot be
finished — it records what is blocking and the session stops cleanly.

`loop-ledger.tsv` is the per-session record that ships with the repo. Each row
captures the time, lane (loop or planning), model used, result, and resource
consumption.

The project now spans ten phases (A through J), eight SQL migrations, and forty
test files — all written by this loop.
