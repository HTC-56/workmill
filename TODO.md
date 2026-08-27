# Loop tasks

Ordered; each is one short session. Work the first unchecked box. Each task is
fully specced in ONE greppable section of its phase doc (`TASK_PHASE_A.md` §A1,
§A2, …) — grep your section, read it, build it.

*(no tasks yet — the planning lane authors Phase A from SPEC.md)*

## Phase A: prove the two load-bearing mechanisms — see TASK_PHASE_A.md

§A1–§A3 are already committed (db layer, seam + leak suite, queue claim). These
are the remaining tasks. Grep your section header in TASK_PHASE_A.md and read it.

- [ ] §A4 — Write `scripts/scrub-check.sh`: the public-repo gate. Greps tracked
      files for private hostnames, non-doc IPv4, home paths, key material.
      Exclude the script itself and `pnpm-lock.yaml` or it fails forever.
      Gate: `pnpm typecheck` + `pnpm test` + the script passing on this tree.
- [ ] §A5 — Write `test/migrate.test.ts`: assertions for `loadMigrations` and
      `migrate` in `src/db/migrate.ts`. Pattern file `test/claim.test.ts`.
      Gate: typecheck + test + scrub-check.
- [ ] §A6 — Write `test/seam.test.ts`: prove `withTenant` pins the role and the
      tenant, and that neither survives the transaction. Pattern file
      `test/leak.test.ts`. Gate: typecheck + test + scrub-check.
- [ ] §A7 — Extend `test/leak.test.ts` with the cross-tenant UPDATE and DELETE
      cases. They refuse by matching zero rows, not by throwing. Keep every
      existing case. Gate: typecheck + test + scrub-check.
- [ ] §A8 — Write `README.md`: what workmill is, Phase A status, quickstart,
      the two engines, the gates, the layout. Every command shown must already
      work. Gate: typecheck + test + scrub-check.
- [ ] §A9 — Write `verify.sh`: typecheck, test, scrub-check, plus a lint that
      every `pnpm <name>` / `bash <path>` shown in README.md really exists.
      Pattern file `scripts/scrub-check.sh`. Gate: `bash verify.sh` green.
- [ ] §A10 — Close the phase: append a Phase A section to `STATUS.md` and fill
      the `ROADMAP.md` reservations ledger with the four deferrals named in
      §A10. No feature row flips to SHIPPED. Gate: `bash verify.sh` green.
