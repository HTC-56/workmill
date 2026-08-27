# Phase A — prove the two load-bearing mechanisms

**ROADMAP row:** #1 *Tenancy core under RLS + leak-test suite* and #3 *Work orders
→ durable jobs on Postgres*, both NOT BUILT. SPEC.md pre-registers this phase: the
RLS refusal path and the `FOR UPDATE SKIP LOCKED` claim must be proven on both
engines before anything else is built.

**Already committed (do not rebuild):** `src/db/` (Engine, PGlite + Postgres
drivers, migrator), `src/seam/withTenant.ts` + `catalog.ts`, `src/queue/claim.ts`
+ `enqueue.ts`, `sql/001_tenancy.sql` + `sql/002_queue.sql`, `test/helpers/db.ts`,
`test/leak.test.ts`, `test/claim.test.ts`, `.github/workflows/ci.yml`.
Sections §A1–§A3 are those commits; the tasks below start at §A4.

**Gate for every task below** (all three, always):
`pnpm typecheck` && `pnpm test` && `bash scripts/scrub-check.sh` (once §A4 lands).

---

## §A4 — scripts/scrub-check.sh, the public-repo gate

**Create:** `scripts/scrub-check.sh`. Nothing else. No new dependency.

This repo will be published. The script greps the tracked tree and exits 1 if it
finds anything that must not ship. Use `git ls-files` for the file list, plain
`grep -nE`, `#!/usr/bin/env bash` and `set -euo pipefail`.

Fail on any of:
1. A private hostname: any `.local` or `.lan` hostname.
2. An IPv4 literal that is not `127.0.0.1`, `0.0.0.0`, or inside `192.0.2.`
   (the documentation range). Version strings like `1.2.3` are not IPv4 —
   require four dot-separated numbers standing alone.
3. An absolute home path: `/home/<name>/` or `/Users/<name>/`.
4. Key material: a `-----BEGIN … PRIVATE KEY-----` header, or a token that looks
   like `sk-…` or `ghp_…`.

**The trap that will make this fail forever if you miss it:** the script's own
patterns match the script itself, and `pnpm-lock.yaml` carries integrity hashes
that trip rule 4. Exclude exactly those two paths from the scanned file list, and
say so in a comment.

**Output:** on a hit, print `file:line: <what rule>` for every hit and exit 1. On
success print one green line naming how many files were scanned and exit 0.

**Verify by hand before committing:** run it (must pass on the current tree);
then temporarily add a line with a fake LAN IP to a scratch file, confirm it
fails, and remove the scratch file.

---

## §A5 — test/migrate.test.ts, the migrator's own assertions

**Create:** `test/migrate.test.ts`. **Pattern file:** `test/claim.test.ts` — copy
its import style, its `beforeAll`/`afterAll` shape and its use of
`freshDb()` from `test/helpers/db.ts`.

Under test: `loadMigrations` and `migrate`, both exported from
`src/db/migrate.ts`. For the malformed cases build a throwaway migrations
directory with `mkdtemp` from `node:fs/promises` and `tmpdir` from `node:os`,
write files into it, and pass that path as the second argument — never touch the
real `sql/` directory.

Assert:
1. `loadMigrations()` with no argument returns the real migrations in ascending
   version order, and the first is version 1 named `001_tenancy.sql`.
2. A temp directory holding `001_x.sql` and `003_y.sql` makes `loadMigrations`
   reject, with a message mentioning dense versions.
3. A temp directory holding a file named `nope.sql` makes `loadMigrations`
   reject.
4. After `freshDb()`, `schema_migrations` holds exactly one row per file in
   `sql/`, and calling `migrate()` again returns an empty array — already-applied
   migrations are not re-run.

---

## §A6 — test/seam.test.ts, proving the door closes behind itself

**Create:** `test/seam.test.ts`. **Pattern file:** `test/leak.test.ts` — mirror
its `beforeAll` (`freshDb`, two tenants via `makeTenant`) and `afterAll` shape.

Under test: `withTenant`, `withAdmin`, `InvalidTenantIdError` from
`src/seam/withTenant.ts`.

Assert:
1. `withTenant` with a string that is not a uuid (try `'not-a-uuid'` and `''`)
   rejects with `InvalidTenantIdError`, and the callback never runs — set a flag
   in the callback and assert it stayed false.
2. Inside `withTenant`, `SELECT current_user` is `workmill_app`.
3. Inside `withAdmin`, `current_user` is **not** `workmill_app` — the admin path
   is a different, privileged role.
4. The tenant pin does not survive the transaction: after a `withTenant` call
   returns, a later `withAdmin` reading
   `current_setting('app.tenant_id', true)` gets null or empty string, never the
   previous tenant's id. Both settings are `SET LOCAL`; this proves it.
5. When the callback throws, `withTenant` rejects with that same error and the
   transaction's writes are rolled back — insert a `work_orders` row, then
   throw, then confirm via `withAdmin` that the row is absent.

---

## §A7 — leak suite: the UPDATE and DELETE halves

**Edit only:** `test/leak.test.ts`. Add cases inside the existing
`describe.each(EXPECTED_TABLES)` block; keep every existing case.

The file already proves cross-tenant SELECT and INSERT. It does not yet prove
UPDATE and DELETE, and SPEC.md feature 1 requires all four verbs.

**Read this before writing an assertion:** UPDATE and DELETE do not throw. A
policy refuses them by matching zero rows, so the correct assertion is "zero rows
affected AND the victim row is still there". A test that expects a thrown error
here will fail against a perfectly protected table.

Add a fixture helper next to the existing `seedRow` and `insertForeignRow`,
in the same shape: given a table name it returns a harmless `SET …` clause for
that table (the tables have different columns and different CHECK constraints, so
one clause cannot serve all three).

Assert, per discovered table:
1. As tenant alice, an UPDATE whose WHERE targets bob's seeded row id (available
   as `seeded.get(table)!.bob`) returns zero rows when written with `RETURNING id`.
2. After that attempt, `withAdmin` still finds bob's row — it was not modified.
3. As alice, a DELETE whose WHERE targets bob's seeded row id returns zero rows
   with `RETURNING id`.
4. After that attempt, `withAdmin` still finds bob's row.
5. The strongest one: as alice, an UPDATE with **no WHERE clause at all** returns
   only rows whose tenant column is alice's id. The policy, not the query, is
   what protects bob.

---

## §A8 — README.md

**Create:** `README.md` at the repo root. Prose only; change no code.

Cover, in this order and nothing more:
- One paragraph on what workmill is — lift it from the top of `SPEC.md`, do not
  invent a new pitch.
- **Status**: Phase A. What is proven so far — tenant isolation under RLS across
  all four verbs, and the `FOR UPDATE SKIP LOCKED` claim. Say plainly that the
  rest of SPEC.md is not built yet.
- **Quickstart**: `pnpm install`, then `pnpm test`. State that this needs no
  database and no model server, because the default engine is PGlite.
- **Engines**: `pnpm test` uses PGlite; setting `DATABASE_URL` runs the identical
  suite against a real Postgres, and that run is the authoritative one. Give the
  Postgres command line using `localhost` only.
- **Gates**: `pnpm typecheck`, `pnpm test`, `bash scripts/scrub-check.sh`.
- **Layout**: a short list of `src/`, `sql/`, `test/`, one line each.

Rules: every command you show must already work in this repo — §A9 adds a lint
that fails the build otherwise. No hostnames but `localhost`, no IPs but
`192.0.2.x`, no absolute home paths. No badge yet, no screenshot yet.

---

## §A9 — verify.sh

**Create:** `verify.sh` at the repo root. **Pattern file:**
`scripts/scrub-check.sh` from §A4 — same shebang, same `set -euo pipefail`, same
"print a line per failure, exit 1" style.

It runs, in order, stopping at the first failure:
1. `pnpm typecheck`
2. `pnpm test`
3. `bash scripts/scrub-check.sh`
4. The README-quickstart lint, described next.

**The lint:** every command shown in a fenced code block in `README.md` must
actually exist in this repo. Two rules are enough:
- a `pnpm <name>` command must have `<name>` as a key under `"scripts"` in
  `package.json` (`pnpm install` is exempt — it is not a repo script);
- a `bash <path>` command must name a file that exists on disk.
Print each violation as `README.md: <command> — <why>` and exit 1.

Finish with one line reporting all four gates passed.

**Verify by hand before committing:** run `bash verify.sh` (must pass); then
temporarily add a fenced block to README.md containing `pnpm nonexistent`,
confirm the lint fails, and remove it.

---

## §A10 — close Phase A: STATUS.md and the ROADMAP ledger

**Edit:** `STATUS.md` (append a section) and `ROADMAP.md` (reservations ledger
only — the feature rows are already current). Change no code.

Run `bash verify.sh` first. It must be green before you write either file.

**STATUS.md** — append a `## Phase A — the two proofs` section, at most 15 lines:
what is now provable (four-verb tenant isolation on every catalog-discovered
table; the SKIP LOCKED claim), which engine proved which half, and the one thing
still outstanding — the Postgres half of the proof runs only in the `postgres` CI
job, because the build box has no Postgres server. Point at
DECISIONS.md "Recorded during Phase A" rather than restating it.

**ROADMAP.md** — under `## Reservations ledger`, replace the
`*(empty at scaffold…)*` line with these four entries, one line each, each naming
Phase A as its home:
- job lifecycle beyond claim — heartbeat, lease reaper, retries with backoff,
  dead-letter, cancel — deferred to the phase that builds the runner;
- users, memberships, invites and entitlements — the rest of ROADMAP row #1;
- `verify.sh` does not yet run `scripts/live-check.sh`; that lands with the
  gateway;
- the CI workflow will need a `verify` step once more gates exist.

Do not flip any feature row to SHIPPED — Phase A completes no row on its own.
