# Loop tasks

Ordered; each is one short session. Work the first unchecked box. Each task is
fully specced in ONE greppable section of its phase doc (`TASK_PHASE_A.md` §A1,
§A2, …) — grep your section, read it, build it.

*(no tasks yet — the planning lane authors Phase A from SPEC.md)*

## Phase A: prove the two load-bearing mechanisms — see TASK_PHASE_A.md

§A1–§A3 are already committed (db layer, seam + leak suite, queue claim). These
are the remaining tasks. Grep your section header in TASK_PHASE_A.md and read it.

- [x] §A4 — Write `scripts/scrub-check.sh`: the public-repo gate. Greps tracked
      files for private hostnames, non-doc IPv4, home paths, key material.
      Exclude the script itself and `pnpm-lock.yaml` or it fails forever.
      Gate: `pnpm typecheck` + `pnpm test` + the script passing on this tree.
- [x] §A5 — Write `test/migrate.test.ts`: assertions for `loadMigrations` and
      `migrate` in `src/db/migrate.ts`. Pattern file `test/claim.test.ts`.
      Gate: typecheck + test + scrub-check.
- [x] §A6 — Write `test/seam.test.ts`: prove `withTenant` pins the role and the
      tenant, and that neither survives the transaction. Pattern file
      `test/leak.test.ts`. Gate: typecheck + test + scrub-check.
- [x] §A7 — Extend `test/leak.test.ts` with the cross-tenant UPDATE and DELETE
      cases. They refuse by matching zero rows, not by throwing. Keep every
      existing case. Gate: typecheck + test + scrub-check.
- [x] §A8 — Write `README.md`: what workmill is, Phase A status, quickstart,
      the two engines, the gates, the layout. Every command shown must already
      work. Gate: typecheck + test + scrub-check.
- [x] §A9 — Write `verify.sh`: typecheck, test, scrub-check, plus a lint that
      every `pnpm <name>` / `bash <path>` shown in README.md really exists.
      Pattern file `scripts/scrub-check.sh`. Gate: `bash verify.sh` green.
- [x] §A10 — Close the phase: append a Phase A section to `STATUS.md` and fill
      the `ROADMAP.md` reservations ledger with the four deferrals named in
      §A10. No feature row flips to SHIPPED. Gate: `bash verify.sh` green.

## Phase B: finish the tenancy core — see TASK_PHASE_B.md

§B1–§B3 are already committed (sql/003_identity.sql, src/tenancy/provision.ts,
src/tenancy/members.ts, plus leak-suite fixtures for the four new tables). These
are the remaining tasks. Grep your section header in TASK_PHASE_B.md and read it.

- [x] §B4 — Extend `test/leak.test.ts` with one case per table: re-homing a row
      you own into another tenant is refused by the policy's WITH CHECK half.
      Keep every existing case. Gate: typecheck + test + scrub-check.
- [x] §B5 — Write `test/tenancy.test.ts`: assertions for `provisionTenant` in
      `src/tenancy/provision.ts` — the four rows, the defaults, the rollback.
      Pattern file `test/seam.test.ts`. Gate: typecheck + test + scrub-check.
- [x] §B6 — Write `test/members.test.ts`: invite, accept, become a member; the
      raw token is never stored; a spent token refuses. Pattern file
      `test/seam.test.ts`. Gate: typecheck + test + scrub-check.
- [x] §B7 — Extend `test/members.test.ts` with expiry, `revokeInvite`,
      `revokeMembership`, and the one-live-invite-per-address rule. Keep every
      existing case. Gate: typecheck + test + scrub-check.
- [x] §B8 — Write `src/tenancy/entitlements.ts`: a typed read of the current
      tenant's limits, plus `isModelAllowed`. Read only — no enforcement.
      Pattern file `src/queue/enqueue.ts`. Gate: typecheck + test + scrub-check.
- [x] §B9 — Write `test/entitlements.test.ts`: assertions for §B8, including a
      bare tenant with no entitlements row. Pattern file `test/tenancy.test.ts`.
      Gate: typecheck + test + scrub-check.
- [x] §B10 — Update `README.md`: Phase B status (tenancy core complete, limits
      stored but not enforced) and one Layout line for `src/tenancy/`. Every
      command shown must already work. Gate: `bash verify.sh` green.
- [x] §B11 — Close the phase: append a Phase B section to `STATUS.md`, flip
      `ROADMAP.md` row #1 to SHIPPED, and update the reservations ledger as
      §B11 describes. Gate: `bash verify.sh` green.

## Phase C: workflows as tenant data — see TASK_PHASE_C.md

§C1–§C3 are already committed (sql/004_workflows.sql, src/workflows/store.ts,
the leak fixtures for the two new tables, and the version pin on `enqueueOrder`).
These are the remaining tasks. Grep your section header in TASK_PHASE_C.md.

- [x] §C4 — Write `src/workflows/render.ts`: `renderPrompt`, `assertRenderable`,
      `TemplateError`. One substitution, `{{input}}`, and nothing else. Pattern
      file `src/tenancy/entitlements.ts`. Gate: typecheck + test + scrub-check.
- [x] §C5 — Write `test/render.test.ts`: assertions for §C4, including the
      dollar-sign and re-scan traps named there. No database in this file.
      Pattern file `test/entitlements.test.ts`. Gate: typecheck + test + scrub-check.
- [x] §C6 — Write `test/workflows.test.ts`: `createWorkflow`, `listWorkflows`,
      `getWorkflow` from `src/workflows/store.ts`. Pattern file
      `test/tenancy.test.ts`. Gate: typecheck + test + scrub-check.
- [x] §C7 — Extend `test/workflows.test.ts` with versioning, archiving and the
      order's version pin. Keep every existing case. Gate: typecheck + test +
      scrub-check.
- [x] §C8 — Write `src/workflows/examples.ts`: the three seeded workflows
      (extract, classify, summarize) plus `seedExampleWorkflows`. Pattern file
      `src/tenancy/provision.ts`. Gate: typecheck + test + scrub-check.
- [x] §C9 — Write `test/examples.test.ts`: assertions for §C8, including that
      every example passes `assertValidDefinition` and `assertRenderable`.
      Pattern file `test/workflows.test.ts`. Gate: typecheck + test + scrub-check.
- [x] §C10 — Update `README.md`: Phase C status (workflows are versioned tenant
      data; nothing runs them yet) and one Layout line for `src/workflows/`.
      Every command shown must already work. Gate: `bash verify.sh` green.
- [x] §C11 — Close the phase: append a Phase C section to `STATUS.md`, flip
      `ROADMAP.md` row #2 to SHIPPED, and add the two reservations §C11 names.
      Gate: `bash verify.sh` green.

## Phase D: model calls through the gateway — see TASK_PHASE_D.md

§D1–§D3 are already committed (`src/gateway/client.ts`, `src/gateway/schema.ts`,
and `test/helpers/stub-gateway.ts` — the in-process OpenAI-compatible stub).
These are the remaining tasks. Grep your section header in TASK_PHASE_D.md.

- [x] §D4 — Write `test/schema.test.ts`: assertions for `validateAgainstSchema`
      and `parseJsonObject` in `src/gateway/schema.ts`. No database, no network.
      Pattern file `test/render.test.ts`. Gate: typecheck + test + scrub-check.
- [x] §D5 — Write `test/gateway.test.ts`: assertions for `src/gateway/client.ts`
      against the stub — usage, timeout, 5xx, malformed body, model map.
      Pattern file `test/render.test.ts`. Gate: typecheck + test + scrub-check.
- [x] §D6 — Write `src/gateway/complete.ts`: `runCompletion`, the re-ask bounded
      at `MAX_REASKS = 2`. A bad answer is a returned result, never a throw.
      Pattern file `src/workflows/render.ts`. Gate: typecheck + test + scrub-check.
- [x] §D7 — Write `test/complete.test.ts`: assertions for §D6 — one-attempt
      success, re-ask then success, three failures bounded, summed usage.
      Pattern file `test/gateway.test.ts`. Gate: typecheck + test + scrub-check.
- [x] §D8 — Write `scripts/live-check.sh`: the real-gateway proof, curl only,
      three checks (models, completion, usage). Not run by CI or verify.sh.
      Pattern file `scripts/scrub-check.sh`. Gate: typecheck + test + scrub-check.
- [x] §D9 — Update `README.md`: Phase D status, one Layout line for
      `src/gateway/`, and `bash scripts/live-check.sh` under Gates. Every
      command shown must already work. Gate: `bash verify.sh` green.
- [x] §D10 — Close the phase: append a Phase D section to `STATUS.md`, flip
      `ROADMAP.md` row #4 to SHIPPED, and add the three reservations §D10 names.
      Gate: `bash verify.sh` green.

## Phase E: the job runner — see TASK_PHASE_E.md

§E1–§E3 are already committed (`sql/005_runner.sql`, `src/queue/lifecycle.ts`,
`src/runner/run.ts`, and the abort seam in `src/gateway/client.ts`). Every task
below writes tests or docs — none needs new `src/` code. Grep your section
header in TASK_PHASE_E.md.

- [x] §E4 — Write `test/lifecycle.test.ts`: `backoffMs`, `heartbeat` and
      `finishJob` from `src/queue/lifecycle.ts`. Pattern file
      `test/claim.test.ts`. Gate: typecheck + test + scrub-check.
- [x] §E5 — Extend `test/lifecycle.test.ts` with `failAttempt` and
      `requeueJob`: retry with backoff, dead-letter at three attempts, the
      failure trail. Keep every existing case. Gate: typecheck + test +
      scrub-check.
- [x] §E6 — Extend `test/lifecycle.test.ts` with `cancelOrder`,
      `markCancelled`, `reapExpiredLeases` and `orderProgress`. Keep every
      existing case. Gate: typecheck + test + scrub-check.
- [x] §E7 — Write `test/runner.test.ts`: `runOnce` and `runUntilIdle` against
      the stub gateway — an order end to end, results and usage persisted.
      Pattern file `test/lifecycle.test.ts`. Gate: typecheck + test +
      scrub-check.
- [x] §E8 — Extend `test/runner.test.ts` with the failure paths: 5xx retried
      then dead, schema-invalid recorded as failed, cancel aborting a running
      job. Keep every existing case. Gate: typecheck + test + scrub-check.
- [x] §E9 — Update `README.md`: Phase E status (orders run end to end; no
      budget enforcement, no HTTP surface) and one Layout line for
      `src/runner/`. Every command shown must already work. Gate:
      `bash verify.sh` green.
- [x] §E10 — Close the phase: append a Phase E section to `STATUS.md`, flip
      `ROADMAP.md` row #3 to SHIPPED, and add the four reservations §E10 names.
      Gate: `bash verify.sh` green.
