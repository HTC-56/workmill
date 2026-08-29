# Loop tasks

Ordered; each is one short session. Work the first unchecked box. Each task is
fully specced in ONE greppable section of its phase doc (`TASK_PHASE_A.md` §A1,
§A2, …) — grep your section, read it, build it.

*(no tasks yet — the planning lane authors Phase A from SPEC.md)*


Completed phases through **Phase H** are in `TODO_ARCHIVE.md` — do not read it unless a task names it.
## Phase I: the operator console — see TASK_PHASE_I.md

§I1–§I3 are already committed (`sql/008_operator.sql`, `src/operator/*`,
`src/server/operator-api.ts`, `src/console/page.ts`, the `GET /operator` route
and the two tenant-side routes). Every task below writes tests or docs — none
needs new `src/` code. Read the nine facts at the top of TASK_PHASE_I.md once,
then grep your section header.

- [x] §I4 — Write `test/operator-grants.test.ts`: the grants library, the pure
      countdown helpers, and the audit trail beside them. No HTTP server.
      Pattern file `test/auth.test.ts`. Gate: typecheck + test + scrub-check.
- [x] §I5 — Write `test/operator-tenants.test.ts`: the operator's tenant table
      and the two edits from `src/operator/tenants.ts`. No HTTP server.
      Pattern file `test/entitlements.test.ts`. Gate: typecheck + test + scrub-check.
- [x] §I6 — Write `test/operator-fleet.test.ts`: `probeGateway` on an injected
      fetch (both branches) and `collectFleet` on a migrated database. No
      network. Pattern file `test/metrics.test.ts`. Gate: typecheck + test + scrub-check.
- [x] §I7 — Write `test/operator-api.test.ts`: the operator bearer wall, the 503
      when unconfigured, the tenant table, provision, and the 404s. Pattern file
      `test/api-auth.test.ts`. Gate: typecheck + test + scrub-check.
- [x] §I8 — Write `test/operator-writes.test.ts`: entitlement edits, state,
      grants over HTTP, and the tenant reading its own trail. Pattern file
      `test/operator-api.test.ts`. Gate: typecheck + test + scrub-check.
- [x] §I9 — Write `test/console-page.test.ts`: `GET /operator` needs no bearer,
      carries the CSP, and the document fetches nothing external. Pattern file
      `test/page.test.ts`. Gate: typecheck + test + scrub-check.
- [x] §I10 — Update `README.md`: Phase I status, one Layout line each for
      `src/operator/` and `src/console/`, and the routes §I10 names. Every
      command shown must already work. Gate: `bash verify.sh` green.
- [x] §I11 — Close the phase: append a Phase I section to `STATUS.md`, flip
      `ROADMAP.md` row #7 to SHIPPED, and record the four reservations §I11
      names. Gate: `bash verify.sh` green.

## Phase J: demo mode and deploy-grade packaging — see TASK_PHASE_J.md

§J1–§J3 are already committed (`src/config/*`, `src/demo/*`,
`src/runner/schedule.ts`, `src/main.ts`, `src/bin/*`,
`deploy/workmill.example.yaml`, `tsconfig.build.json`, six new package.json
scripts, the CI verify step). Every task below writes tests or docs — none
needs new `src/` code. Read the nine facts at the top of TASK_PHASE_J.md once,
then grep your section header.

- [x] §J4 — Write `test/yaml.test.ts`: the YAML subset `src/config/yaml.ts`
      accepts and the eight things it refuses, each on the right line. No
      database. Pattern file `test/render.test.ts`. Gate: typecheck + test +
      scrub-check.
- [x] §J5 — Write `test/config.test.ts`: `buildConfig` — defaults, the file,
      the environment winning, and the two secrets the file refuses. Pure, no
      filesystem. Pattern file `test/schema.test.ts`. Gate: typecheck + test +
      scrub-check.
- [x] §J6 — Write `test/demo.test.ts`: `seedDemo`, the tight budgets,
      `clearDemo`'s cascade and its non-demo refusal, and `resetDemo`'s new
      tokens. Pattern file `test/tenancy.test.ts`. Gate: typecheck + test +
      scrub-check.
- [x] §J7 — Write `test/schedule.test.ts`: `listTenantIds`, `sweepOnce` and
      `startRunnerLoop` against the stub gateway. Call `sweep()` yourself; never
      wait for the timer. Pattern file `test/metering.test.ts`. Gate: typecheck
      + test + scrub-check.
- [x] §J8 — Write the four systemd units and `deploy/README.md` named in §J8.
      Paths are `/opt/workmill`, `/etc/workmill`, `/var/log/workmill` only — no
      home paths, no LAN addresses. Gate: typecheck + test + scrub-check.
- [x] §J9 — Update `README.md`: the Phase J paragraph, the ten-minute
      quickstart §J9 spells out, four new Layout lines, and only the nine
      commands that exist. Gate: `bash verify.sh` green.
- [x] §J10 — Write `docs/PROCESS.md`: three PoCs into one product, then the
      loop that built it. One page, no invented statistics. Gate:
      `bash verify.sh` green.
- [x] §J11 — Close the phase: append a Phase J section to `STATUS.md`, flip
      `ROADMAP.md` row #9 and the `docs/PROCESS.md` row to SHIPPED, and record
      the four reservations §J11 names. Gate: `bash verify.sh` green.
