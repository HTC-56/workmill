# Phase J — demo mode and deploy-grade packaging

**ROADMAP row:** #9 *Demo mode + deploy-grade packaging (seed/reset, config,
units, dual-engine CI, quickstart)*, currently PARTIAL — only the dual-engine CI
half was ever built. This phase finishes it, and with it the last un-SHIPPED
feature row in SPEC.md. It also closes the `docs/PROCESS.md` row.

**Already committed (do not rebuild):** `src/config/yaml.ts` and
`src/config/config.ts` (§J1), `src/demo/seed.ts` and `src/demo/reset.ts` (§J2),
`src/runner/schedule.ts`, `src/main.ts`, `src/bin/support.ts`,
`src/bin/workmill.ts`, `src/bin/seed-demo.ts`, `src/bin/reset-demo.ts`,
`src/bin/mint-token.ts`, `deploy/workmill.example.yaml`, `tsconfig.build.json`,
the six new `package.json` scripts and the CI `verify.sh` step (§J3).
**Every task below writes tests or docs — no task in this phase needs you to
write new `src/` code.**

**Gate for every task below** (all three, always):
`pnpm typecheck` && `pnpm test` && `bash scripts/scrub-check.sh`.
Doc tasks say `bash verify.sh` instead, which is those three plus the README
command lint.

**Nine facts that will cost you a red gate if you guess them wrong:**

1. **Import paths end in `.js`** even though the files are `.ts` —
   `from '../src/config/yaml.js'`. Every test in this repo does it; copying a
   pattern file's import block is the safest way to get this right.
2. **`parseYaml` and `parseScalar`** come from `src/config/yaml.js`. Errors are
   `YamlError` and carry a numeric `.line` (1-based). Nothing there touches the
   filesystem.
3. **`buildConfig(raw, env)` is pure** — it takes an already-parsed object and a
   plain object standing in for the environment, and returns the config. Errors
   are `ConfigError` and carry a `.path` like `'server.port'`. Do NOT call
   `loadConfig` in a test: it reads real files.
4. **The environment always wins over the file.** That direction is the point of
   the merge, so it is the assertion that matters most.
5. **Database tests use `freshDb()`** from `test/helpers/db.js` and must
   `await db.close()` in `afterAll`. Demo slugs are fixed — `demo-acme` and
   `demo-globex` — and `seedDemo` takes `{ specs }` if you want a smaller set.
6. **`seedDemo` and `clearDemo` take the ENGINE**, not a session: provisioning
   and deleting a tenant are admin acts. Reading a tenant's limits afterwards
   needs `withTenant(db, tenantId, …)` like everywhere else.
7. **`startRunnerLoop`'s timer is `unref`'d and fires on an interval.** Never
   wait for it in a test — call `loop.sweep()` directly, then `await
   loop.stop()`.
8. **`pnpm build` compiles everything under `src/`.** `verify.sh` does not run
   it but CI does, so a file that only typechecks under `--noEmit` is still a
   red build.
9. **These commands now exist and no others do:** `pnpm typecheck`, `pnpm test`,
   `pnpm test:watch`, `pnpm build`, `pnpm start`, `pnpm seed:demo`,
   `pnpm reset:demo`, `pnpm mint:token`, `pnpm verify`. `verify.sh` gate 4 fails
   the build if README.md shows a `pnpm <name>` or `bash <path>` that is not
   real, so never invent one.

---

## §J4 — test/yaml.test.ts: the subset, and everything it refuses

**Create:** `test/yaml.test.ts`. **Pattern file:** `test/render.test.ts` — same
shape: a pure module, no database, no server, no `beforeAll`.

Under test: `parseYaml`, `parseScalar` and `YamlError` from
`src/config/yaml.js`. Facts 1 and 2 are what this file lives on.

Write a small multi-line document inside the test (a template literal is
fine) and assert:

1. **Nesting and types.** A document with two sections, each holding a few
   `key: value` lines, parses to the nested object you would draw. An integer
   comes back a number, `true`/`false` come back booleans, `null` and `~` both
   come back null, and a double-quoted string keeps the spaces inside it.
2. **Comments.** A whole-line `#` comment and a trailing ` # …` comment are both
   dropped, but a `#` inside a quoted string survives, and so does the one in
   `http://localhost:8080/v1#frag` — a hash only starts a comment at the start
   of a line or after whitespace.
3. **A block sequence** of `- item` lines indented under a key parses to an
   array of those scalars, in order.
4. **An empty value is null.** `key:` with nothing after it and nothing indented
   below it gives null, not an empty string and not an empty object.
5. **The refusals, each a `YamlError` on the RIGHT LINE.** Assert `.line` as
   well as the throw for at least two of them. Cover: a tab used for
   indentation; a flow mapping `{a: 1}`; a flow sequence `[1, 2]`; an anchor
   `&x`; a tag `!!str`; a duplicate key in one block; a line that is neither a
   `key:` nor a `- item`; and a `- key: value` line, which is a mapping inside a
   list and is not supported.
6. **The edges.** `parseYaml('')` is `{}`, and a document of only comments is
   too. `parseScalar('007', 1)` stays the STRING `'007'` (a leading zero is not
   an integer here), while `parseScalar('3.5', 1)` is the number `3.5`.

---

## §J5 — test/config.test.ts: defaults, the merge, and the two secrets

**Create:** `test/config.test.ts`. **Pattern file:** `test/schema.test.ts` —
another pure module with no database. Facts 3 and 4 are what this file lives on.

Under test: `buildConfig`, `ConfigError` and `defaultConfig` from
`src/config/config.js`. Every call passes a hand-written object as the parsed
file and a hand-written object as the environment.

Assert:

1. **Zero config is a working config.** `buildConfig({}, {})` gives host
   `'127.0.0.1'`, port `3000`, `database.url` null, gateway `baseUrl`
   `'http://localhost:8080/v1'` with `timeoutMs` `60000` and an empty `models`
   map, `runner.enabled` true with `workerId` `'workmill-1'`, and both
   `ops.logPath` and `ops.operatorToken` null. `defaultConfig()` equals it.
2. **A file sets things.** A parsed object with a `server` block and a `gateway`
   block comes back with those values, and `gateway.models` comes back as the
   pairs the file gave.
3. **The environment wins.** With the same file, `WORKMILL_PORT`,
   `DATABASE_URL` and `GATEWAY_BASE_URL` in the env each override what the file
   said. An empty-string env value counts as unset, not as an override.
4. **Secrets are file-forbidden and env-allowed.** `gateway.apiKey` in the file
   throws `ConfigError` whose message names `GATEWAY_API_KEY`; `ops.operatorToken`
   in the file throws one naming `WORKMILL_OPERATOR_TOKEN`. From the environment
   both are accepted — `GATEWAY_API_KEY` lands on `gateway.apiKey`. A
   `WORKMILL_OPERATOR_TOKEN` shorter than 16 characters throws.
5. **Typos are refused, not ignored.** An unknown top-level section and an
   unknown key inside a known section each throw `ConfigError` carrying the
   offending `.path`. This is the whole reason the loader knows its own key
   list.
6. **Values are checked.** A `server.port` of `0`, a `gateway.baseUrl` of
   `'ftp://x'` and a `runner.enabled` of `'maybe'` each throw `ConfigError`. A
   `baseUrl` written with a trailing slash comes back without it.

---

## §J6 — test/demo.test.ts: seed, the tight budgets, and reset

**Create:** `test/demo.test.ts`. **Pattern file:** `test/tenancy.test.ts` — its
`freshDb()` / `afterAll` shape and its use of `withTenant` are the ones to copy.
No HTTP server in this file. Facts 5 and 6 are what it lives on.

Under test: `seedDemo`, `DemoExistsError`, `DEMO_TENANTS` from
`src/demo/seed.js`, and `clearDemo`, `resetDemo`, `DemoResetRefusedError` from
`src/demo/reset.js`.

Assert:

1. **The seed.** `seedDemo(db)` returns two tenants in `DEMO_TENANTS` order,
   each with a uuid `tenantId`, three workflows whose slugs are `extract`,
   `classify` and `summarize`, and a `token` starting `wm_`.
2. **The tight budgets landed.** Read the limits inside
   `withTenant(db, tenantId, …)` with `readLimits` from
   `src/metering/limits.js`: `demo-globex` has a `dailyTokenBudget` of `600` and
   `maxConcurrentJobs` of `1`; `demo-acme` has `20000` and `2`. These numbers
   are what makes the quickstart's budget refusal real, so assert them exactly.
3. **Seeding twice refuses.** A second `seedDemo(db)` throws `DemoExistsError`
   carrying the slug, and afterwards there are still exactly two tenants —
   count them with `countAsAdmin` from `test/helpers/db.js`.
4. **Clearing cascades.** `clearDemo(db)` reports `tenantsRemoved: 2`, and
   afterwards both the tenant rows AND their `workflows` rows are gone —
   nothing in the library deletes workflows, so this is the foreign keys doing
   it.
5. **A non-demo slug is refused before anything happens.** Provision an
   ordinary tenant, then call `clearDemo` with a hand-built one-element `specs`
   array naming that tenant's slug: it throws `DemoResetRefusedError` and the
   tenant is still there.
6. **Reset is clear-then-seed with new tokens.** On a seeded database,
   `resetDemo(db)` gives `cleared.tenantsRemoved` of `2` and a manifest whose
   tokens are all DIFFERENT from the first seed's. That is the property a public
   demo on a timer depends on.

---

## §J7 — test/schedule.test.ts: the tick nobody had

**Create:** `test/schedule.test.ts`. **Pattern file:** `test/metering.test.ts` —
copy the SHAPE of its `beforeAll`: it makes a database, provisions a tenant,
seeds a workflow, starts the stub gateway and enqueues an order. That set-up is
most of this file. Fact 7 is the one that will bite you.

Under test: `listTenantIds`, `sweepOnce` and `startRunnerLoop` from
`src/runner/schedule.js`.

Assert:

1. **`listTenantIds`** on a freshly migrated database is `[]`; after two tenants
   are provisioned it holds both ids and nothing else.
2. **A quiet sweep.** With two tenants and no work, `sweepOnce(db, gateway,
   { workerId: 'test' })` reports `tenants: 2`, a summary for each tenant id,
   an empty `errors` array, and `claimed: 0` in every summary.
3. **A sweep runs real work.** With an order enqueued for the FIRST tenant,
   one sweep gives that tenant a summary with `claimed` and `succeeded` above
   zero — and the second tenant's summary is still all zeros. A sweep is
   per-tenant, and one tenant's work is never another's.
4. **The loop's `sweep()` is the same verb.** `startRunnerLoop(db, gateway,
   { workerId: 'test', intervalMs: 60000 })` returns a loop whose `sweep()`
   drains a second order the same way. Use a large `intervalMs` so the timer
   never fires during the test — you are calling `sweep()` yourself.
5. **`onSweep` reports.** The callback passed in options is called with the
   result of that explicit `sweep()`, and what it receives has the same
   `tenants` count as the returned value.
6. **`stop()` is real and idempotent.** `loop.running` is true before and false
   after `await loop.stop()`, and calling `stop()` a second time resolves
   rather than throwing. Always stop the loop and close the database in
   `afterAll`, or vitest will hang.

---

## §J8 — deploy/: the systemd units and how to install them

**Create:** `deploy/workmill.service`, `deploy/workmill-gateway.service`,
`deploy/workmill-reset.service`, `deploy/workmill-reset.timer` and
`deploy/README.md`. Nothing else. **Pattern file:** none in this repo — write
ordinary systemd units. **Gate:** typecheck + test + scrub-check.

`deploy/workmill.example.yaml` is already there; read it first, because these
files must agree with it about paths and variable names.

The one rule that will fail the gate if you break it: **no absolute home paths
and no LAN addresses anywhere.** Use `/opt/workmill`, `/etc/workmill`,
`/var/log/workmill`, `localhost` and `127.0.0.1` only.

1. **`workmill.service`** — a `simple` service running
   `/usr/bin/node /opt/workmill/dist/bin/workmill.js` as `User=workmill`, with
   `WorkingDirectory=/opt/workmill`, `Environment=WORKMILL_CONFIG=/etc/workmill/workmill.yaml`,
   `EnvironmentFile=/etc/workmill/workmill.env` for the two secrets,
   `Restart=on-failure`, and the ordinary hardening lines
   (`NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`,
   `ReadWritePaths=/var/log/workmill`). It should want and follow the gateway
   unit. Comment the two secrets by name: `WORKMILL_OPERATOR_TOKEN` and
   `GATEWAY_API_KEY`.
2. **`workmill-gateway.service`** — an EXAMPLE unit for the upstream
   OpenAI-compatible gateway (`local-ai-gateway`), which is a separate program
   this repo consumes and never contains. Say so in a comment at the top: this
   file is a placeholder to be replaced by whatever the operator actually runs,
   and workmill only needs it listening at the `gateway.baseUrl` in the config.
3. **`workmill-reset.service`** — `Type=oneshot`, running
   `/usr/bin/node /opt/workmill/dist/bin/reset-demo.js` as the same user with
   the same environment. It restores the demo to seed state and prints new
   bearer tokens to the journal.
4. **`workmill-reset.timer`** — `OnCalendar=hourly`, `Persistent=true`,
   installed into `timers.target`, driving the service above.
5. **`deploy/README.md`** — half a page: where each file goes
   (`/etc/systemd/system/`), the install order (build, copy `dist/` and
   `package.json` and `node_modules` to `/opt/workmill`, write
   `/etc/workmill/workmill.yaml` from the example, write the env file with mode
   0600, `systemctl enable --now`), and one loud paragraph saying the demo
   DEPLOYMENT is a human decision (DECISIONS.md human-gated list: host, tunnel,
   public URL, reset cadence). The repo ships the scripts; a human runs them.

---

## §J9 — README.md: the ten-minute quickstart

**Edit:** `README.md`. Nothing else. **Gate:** `bash verify.sh` green — gate 4
lints that every `pnpm <name>` and `bash <path>` the README shows really exists.
Fact 9 lists the nine commands that do.

1. Add a **Phase J** paragraph after the Phase I one: workmill is now a process
   you can run — `pnpm build` then `pnpm start` serves the pages and ticks the
   queue on a timer; a YAML config file with an environment override for every
   field; demo seed and reset scripts; example systemd units in `deploy/`. Say
   what the demo is: two tenants on the same entitlement system every tenant
   uses, one roomy and one whose small budget a five-item order really does
   exhaust. Say what is left: nothing in SPEC.md — the demo DEPLOYMENT itself is
   human-gated.
2. **Rewrite the Quickstart section** into the path SPEC.md asks for, in
   numbered steps a stranger can follow in ten minutes. Keep the existing
   zero-setup opening (`pnpm install` then `pnpm test`, no database, no model
   server) as step 1, then: start Postgres and export `DATABASE_URL` (the docker
   line already in the Engines section is the one to reuse); `pnpm build`;
   `pnpm seed:demo`, which prints two tenants and a bearer for each; export a
   `WORKMILL_OPERATOR_TOKEN` of 16+ characters; `pnpm start`; open
   `http://localhost:3000/` and paste the `demo-acme` bearer; submit a five-item
   order against the `summarize` workflow; then paste the `demo-globex` bearer
   and submit the same order to watch the daily budget refuse it mid-order and
   the order say why; open `http://localhost:3000/operator` with the operator
   bearer, grant support access with a reason, and read the same entry back at
   `GET /api/audit` with the tenant bearer; finish with `pnpm reset:demo`.
3. Note plainly that the demo scripts refuse to run without `DATABASE_URL`,
   because the default engine lives in the process and dies with it — and that
   `pnpm mint:token <slug>` is how any other tenant gets a bearer.
4. Add Layout lines, in the existing wording, for `src/config/` (the YAML subset
   and the config merge), `src/demo/` (seed and reset), `src/bin/` (the
   entrypoint and the three operator commands), and `deploy/` (example config
   and systemd units). Add `src/main.ts` too.
5. Add the new commands to the Gates section or a new Commands section —
   whichever reads better — using only the nine that exist.

Use `localhost` in any URL you write, never a LAN address.

---

## §J10 — docs/PROCESS.md: three PoCs became one product

**Create:** `docs/PROCESS.md`. Nothing else. **Gate:** `bash verify.sh` green.

One page. SPEC.md's opening line promises it and ROADMAP.md keeps a row for it.
Two halves, and no invented facts in either — everything you write must be
checkable against files in this repo.

1. **The composition half.** The three public repos SPEC.md names —
   `worklane` (queue mechanics: `FOR UPDATE SKIP LOCKED`, leases, heartbeat,
   backoff, dead-letter), `local-ai-gateway` (consumed as an upstream service
   over its OpenAI-compatible contract, never merged in), and `tenant-kernel`
   (RLS enforcement, the catalog-driven leak suite, audited operator access) —
   and what each contributed. Make the point DECISIONS.md makes: patterns were
   rebuilt here, not copied file-for-file, and the thing that makes them a
   product rather than three demos is that they share one tenant boundary. The
   queue is inside RLS, so the leak suite covers the queue itself.
2. **The loop half.** How this repo was built: `TODO.md` is the work queue,
   each task pointing at one greppable section of a `TASK_PHASE_<letter>.md`
   spec; a local model takes the first unchecked task, implements it, and may
   only commit when three gates are green; a planning lane writes the next
   phase when the list runs dry; `BLOCKED.md` is the escape hatch when a task
   cannot be finished. Name the gates (`pnpm typecheck`, `pnpm test`,
   `bash scripts/scrub-check.sh`, composed by `verify.sh`) and say why they are
   the referee: an autonomous loop needs a definition of done it cannot argue
   with. Mention `loop-ledger.tsv` as the per-session record that ships with the
   repo. **Do not invent statistics** — if you want a number, count something
   you can see (the ten phases A–J, the eight `sql/` migrations, the number of
   test files).

Keep it to roughly a page. No private hostnames, no home paths, no other
project names than the three above.

---

## §J11 — close the phase

**Edit:** `STATUS.md` and `ROADMAP.md`. **Gate:** `bash verify.sh` green.

1. Append a `## Phase J — demo mode and deploy-grade packaging` section to
   `STATUS.md`, after the Phase H section, in the voice of the sections above
   it. Say: workmill is a process now — `src/main.ts` opens the engine,
   migrates, serves both pages and the API, and ticks the runner on a
   non-overlapping timer, stopping runner-then-listener-then-engine; config is
   one YAML file with an environment override for every field and two secrets
   the file refuses to hold; the demo is two ordinary tenants with small
   entitlements, seeded and reset by scripts that refuse to run against the
   in-process engine because its database dies with the process; `deploy/`
   carries example units and CI now runs `verify.sh` and `pnpm build`. Say what
   is deliberately left: the demo DEPLOYMENT is human-gated (host, tunnel,
   public URL, reset cadence — DECISIONS.md), and `DEFAULT_ENTITLEMENTS` is
   still provisional.
2. In `ROADMAP.md`, flip row **#9** to `SHIPPED`, phase `J`, with a one-line
   note, and flip the `docs/PROCESS.md` row to `SHIPPED`, phase `J`. Do not
   touch any other row's status.
3. Append these four reservations to the ROADMAP.md reservations ledger, each
   one line, in the existing style:
   - **the demo scripts refuse the default engine** — `openPglite()` takes no
     data directory, so its database dies with the process; seeding into memory
     would print tokens for tenants nobody can reach, and the refusal is the
     honest answer rather than a warning that reads as success;
   - **the config reader is a YAML SUBSET** — mappings, scalar lists, comments
     and five scalar types, with everything else refused by line number;
     widening it waits until a real deployment needs a feature it lacks;
   - **a sweep is series, not parallel** — tenants tick one after another
     because PGlite serves one connection, so fleet throughput on a real
     Postgres is left on the table until someone measures that it matters;
   - **`pnpm build` is not a `verify.sh` gate** — CI runs it, and a clean
     `--noEmit` typecheck is not quite a proof that the emit succeeds; folding
     it into `verify.sh` waits until that difference bites once.
4. Mark this phase's tasks `- [x]` in `TODO.md` as you go, like every phase
   before it.
