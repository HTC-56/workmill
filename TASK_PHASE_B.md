# Phase B — finish the tenancy core

**ROADMAP row:** #1 *Tenancy core under RLS + leak-test suite*, currently PARTIAL.
SPEC.md feature 1 names five nouns; Phase A built `tenants`. This phase builds the
other four — users, memberships, invites, entitlements — and proves them, which
flips row #1 to SHIPPED.

**Already committed (do not rebuild):** `sql/003_identity.sql` (the four tables,
their RLS policies and their `tenant-scoped:` markers), `src/tenancy/provision.ts`
(`provisionTenant`, `DEFAULT_ENTITLEMENTS`), `src/tenancy/members.ts`
(`inviteMember`, `acceptInvite`, `revokeInvite`, `revokeMembership`,
`hashInviteToken`, `ROLES`), plus the `test/leak.test.ts` fixtures for the four new
tables. Sections §B1–§B3 are those commits; the tasks below start at §B4.

**Gate for every task below** (all three, always):
`pnpm typecheck` && `pnpm test` && `bash scripts/scrub-check.sh`.

**Four facts that will cost you a red gate if you guess them wrong:**

1. A tenant `slug` must match `^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$` — **at least three
   characters**. `'ab'` is rejected by the database.
2. Every email must look like `name@host.tld` — an `@` and a dot in the domain.
   Use `@example.test` addresses. Addresses are unique per tenant,
   case-insensitively, so give each fixture row a distinct one.
3. A tenant is provisioned with `provisionTenant(db, { slug, name, ownerEmail })`.
   It returns `{ tenantId, ownerUserId, membershipId, entitlementsId }`. The
   `makeTenant` helper in `test/helpers/db.ts` is different — it makes a bare
   tenant with **no** owner and **no** entitlements row.
4. Cross-tenant UPDATE and DELETE refuse by matching **zero rows**, not by
   throwing. Only INSERT — and moving a row to another tenant — throws.

---

## §B4 — leak suite: a tenant cannot re-home a row into another tenant

**Edit only:** `test/leak.test.ts`. Add ONE new case inside the existing
`describe.each(EXPECTED_TABLES)` block. Keep every existing case.

The suite proves a tenant cannot read, insert, update or delete another tenant's
rows. It does not yet prove the remaining move: taking a row it *does* own and
rewriting its tenant column to point at someone else. That is an UPDATE the
`USING` clause permits — alice really does own the row — and only the `WITH CHECK`
half of the policy stops it. Nothing tests that half on the UPDATE path today.

Add one `it(...)` per discovered table asserting:

1. As alice, `UPDATE <table> SET <tenant column> = <bob's tenant id>` with no WHERE
   clause **rejects**, and the message matches `/row-level security/i`.
2. Afterwards, `withAdmin` counts the same number of rows carrying bob's tenant id
   as it did before the attempt — take the count first, attempt, count again.

The tenant column is already available in the block as `column()`; bob's tenant id
is `bob.id`. This has been checked against all seven tables and the message is the
same on each, including `tenants`, whose tenant column is its own `id`.

Note for assertion 2: `entitlements.tenant_id` is UNIQUE, so you might expect a
unique-violation message there instead. You will not get one — Postgres evaluates
the policy before it touches the index.

---

## §B5 — test/tenancy.test.ts: provisioning a tenant

**Create:** `test/tenancy.test.ts`. **Pattern file:** `test/seam.test.ts` — copy its
import style, its `beforeAll` (`freshDb`) and its `afterAll` (`db.close()`).

Under test: `provisionTenant` and `DEFAULT_ENTITLEMENTS` from
`src/tenancy/provision.ts`. Read that file before you write assertions.

Assert:

1. `provisionTenant` returns four non-empty ids, and reading inside
   `withTenant(db, tenantId, …)` finds exactly one user, one membership and one
   entitlements row.
2. The owner's membership `role` is `'owner'`, and the user's `email` is stored
   exactly as passed — including its capitalisation.
3. Omitting `ownerName` gives the user a `display_name` equal to the local part of
   the address (everything before the `@`).
4. The entitlements row carries the `DEFAULT_ENTITLEMENTS` numbers. Compare
   `daily_token_budget` with `Number(...)` around it — a bigint arrives as a string
   from one of the two drivers.
5. Passing `entitlements: { maxItemsPerOrder: 7 }` overrides only that field; the
   others still equal the defaults.
6. Atomicity: provision a tenant, then provision a second one **with the same slug
   and a different owner email**. It must reject, and afterwards `withAdmin` must
   find zero users with that second email — the whole provision rolled back.

---

## §B6 — test/members.test.ts: invite, accept, become a member

**Create:** `test/members.test.ts`. **Pattern file:** `test/seam.test.ts` for the
`beforeAll`/`afterAll` shape.

Under test: `inviteMember`, `acceptInvite`, `hashInviteToken` from
`src/tenancy/members.ts`. Read that file first — it says which of them take a
`Session` (call those inside `withTenant`) and which take the `Engine` itself.

Set up with `provisionTenant`, not `makeTenant`.

Assert:

1. `inviteMember` returns an `inviteId`, a `token`, and an `expiresAt` in the
   future.
2. The raw token is never stored: read the invite row as admin and check its
   `token_hash` equals `hashInviteToken(token)` and does **not** equal the token.
3. `acceptInvite(db, token, 'Some Name')` returns the inviting tenant's id and the
   invited role.
4. After acceptance the tenant has two memberships — the owner's and the new one —
   and the new user's `display_name` is the name that was passed.
5. The invite is spent: calling `acceptInvite` a second time with the same token
   rejects with `InviteNotFoundError`.
6. An unknown token rejects with `InviteNotFoundError` too. The error deliberately
   does not distinguish the two cases; do not assert on its message.

---

## §B7 — test/members.test.ts: expiry, revocation, one live invite at a time

**Edit only:** `test/members.test.ts` from §B6. Add cases; keep every existing one.

Under test: the rest of `src/tenancy/members.ts` — `revokeInvite`,
`revokeMembership`, and the expiry path. You need two tenants here, both from
`provisionTenant`.

Assert:

1. An invite created with `ttlMs: 1` and then awaited briefly (a ~30ms
   `setTimeout`) rejects with `InviteExpiredError`, not `InviteNotFoundError`.
2. `revokeInvite` on a pending invite returns `true`, and `acceptInvite` with that
   invite's token then rejects.
3. Cross-tenant: the *second* tenant calling `revokeInvite` on the first tenant's
   invite returns `false` — RLS makes another tenant's invite indistinguishable
   from one that does not exist.
4. `revokeMembership(sql, ownerUserId)` returns `true`, and afterwards the tenant
   has one fewer membership but the `users` row is still there. Losing a seat must
   not erase the person.
5. Two pending invites for the same address in the same tenant: the second
   `inviteMember` call rejects. Then revoke the first and invite that address
   again — this time it succeeds, because only *pending* invites are unique.

---

## §B8 — src/tenancy/entitlements.ts: reading a tenant's limits

**Create:** `src/tenancy/entitlements.ts`. Nothing else. No new dependency.
**Pattern file:** `src/queue/enqueue.ts` — same shape: takes a `Session` as its
first argument, runs one query, returns a typed object, and carries a header
comment explaining what it is for.

This is the read side only. Enforcing the limits — refusing a claim when the
budget is spent, capping order size — is SPEC.md feature 5 and belongs to the
metering phase. Do not enforce anything here.

Export:

1. `TenantEntitlements` — an interface with camelCase number fields
   `dailyTokenBudget`, `maxConcurrentJobs`, `maxItemsPerOrder`, `maxItemChars`, and
   `allowedModels: string[]`.
2. `MissingEntitlementsError` — an `Error` subclass, `name` set to match, following
   the style of `InvalidTenantIdError` in `src/seam/withTenant.ts`.
3. `getEntitlements(sql: Session): Promise<TenantEntitlements>` — selects the
   columns from `entitlements` **with no WHERE clause**. That is deliberate and
   deserves a comment: RLS already scopes the table to the current tenant, so the
   one visible row is the right one. Throw `MissingEntitlementsError` when there is
   no row. Wrap `daily_token_budget` in `Number(...)` — a bigint arrives as a
   string from one of the two drivers.
4. `isModelAllowed(entitlements: TenantEntitlements, model: string): boolean` — a
   plain function, no database.

---

## §B9 — test/entitlements.test.ts

**Create:** `test/entitlements.test.ts`. **Pattern file:** the
`test/tenancy.test.ts` you wrote in §B5.

Under test: `src/tenancy/entitlements.ts` from §B8, set up with `provisionTenant`.

Assert:

1. After `provisionTenant`, `getEntitlements` inside `withTenant` returns the
   `DEFAULT_ENTITLEMENTS` values, and `typeof result.dailyTokenBudget` is
   `'number'` — not `'string'`.
2. `allowedModels` is an array containing `'default'`.
3. Provisioning with an `entitlements` override returns the overridden number.
4. Two tenants provisioned with different budgets each read back their own — call
   `getEntitlements` under each tenant in turn and compare.
5. A tenant made with `makeTenant` (bare, no entitlements row) makes
   `getEntitlements` reject with `MissingEntitlementsError`.
6. `isModelAllowed` is true for `'default'` and false for `'not-a-model'`.

---

## §B10 — README.md: Phase B status

**Edit only:** `README.md`. Prose only; change no code.

Two changes, nothing more:

- **Status.** It currently says "Phase A" and lists two proven mechanisms. Retitle
  it to cover Phase B as well, and add a bullet: the tenancy core is complete —
  tenants, users, memberships, invites and entitlements, all under RLS, all
  covered by the catalog-driven leak suite. Say plainly that entitlement limits
  are stored but **not yet enforced**, and that the rest of `SPEC.md` is not built.
- **Layout.** Add one line for `src/tenancy/` — provisioning, invites,
  memberships, entitlement reads.

Every command shown in this file must already work: `verify.sh` gate 4 fails the
build otherwise. Do not add commands. No hostnames but `localhost`, no IPs but
`192.0.2.x`, no absolute home paths.

---

## §B11 — close Phase B: verify.sh, STATUS.md, ROADMAP.md

**Edit:** `STATUS.md` (append a section) and `ROADMAP.md` (one row plus the
reservations ledger). Change no code.

Run `bash verify.sh` first. It must be green before you write either file.

**STATUS.md** — append a `## Phase B — the tenancy core is complete` section, at
most 15 lines: the five nouns of SPEC.md feature 1 now exist, all under RLS; the
leak suite proves all four verbs plus the re-home refusal on seven tables; entitlement
numbers are stored but not enforced. Do not restate what Phase A already says.

**ROADMAP.md** — two edits:

- Row #1: status `SHIPPED`, phase `A, B`, and a one-line note saying the five
  nouns are built and the leak suite covers every one of them.
- Reservations ledger: append `— **discharged in Phase B**` to the existing
  "users, memberships, invites and entitlements" line, and add two new entries:
  entitlement *enforcement* (budget refusal, concurrency cap, allowed-model check)
  belongs to the metering phase; and the `DEFAULT_ENTITLEMENTS` numbers in
  `src/tenancy/provision.ts` are provisional starting values, to be tuned when
  there is a token ledger to measure against.

Flip no other row. Phase B completes row #1 and no other.
