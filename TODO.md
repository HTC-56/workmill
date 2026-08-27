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
- [ ] §B5 — Write `test/tenancy.test.ts`: assertions for `provisionTenant` in
      `src/tenancy/provision.ts` — the four rows, the defaults, the rollback.
      Pattern file `test/seam.test.ts`. Gate: typecheck + test + scrub-check.
- [ ] §B6 — Write `test/members.test.ts`: invite, accept, become a member; the
      raw token is never stored; a spent token refuses. Pattern file
      `test/seam.test.ts`. Gate: typecheck + test + scrub-check.
- [ ] §B7 — Extend `test/members.test.ts` with expiry, `revokeInvite`,
      `revokeMembership`, and the one-live-invite-per-address rule. Keep every
      existing case. Gate: typecheck + test + scrub-check.
- [ ] §B8 — Write `src/tenancy/entitlements.ts`: a typed read of the current
      tenant's limits, plus `isModelAllowed`. Read only — no enforcement.
      Pattern file `src/queue/enqueue.ts`. Gate: typecheck + test + scrub-check.
- [ ] §B9 — Write `test/entitlements.test.ts`: assertions for §B8, including a
      bare tenant with no entitlements row. Pattern file `test/tenancy.test.ts`.
      Gate: typecheck + test + scrub-check.
- [ ] §B10 — Update `README.md`: Phase B status (tenancy core complete, limits
      stored but not enforced) and one Layout line for `src/tenancy/`. Every
      command shown must already work. Gate: `bash verify.sh` green.
- [ ] §B11 — Close the phase: append a Phase B section to `STATUS.md`, flip
      `ROADMAP.md` row #1 to SHIPPED, and update the reservations ledger as
      §B11 describes. Gate: `bash verify.sh` green.
