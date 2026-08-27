-- 003 — the rest of the tenancy core: users, memberships, invites, entitlements.
--
-- SPEC.md feature 1 names five nouns. 001 built `tenants`; this migration builds
-- the other four, all under the same one-column RLS shape the leak suite knows
-- how to prove.
--
-- Two shape rules every tenant-scoped table in this repo follows, because the
-- catalog-driven leak suite depends on both:
--   * a surrogate `id uuid` primary key — the suite targets victim rows by `id`;
--   * exactly one column carrying the tenant, named in the table's
--     `COMMENT ON TABLE … 'tenant-scoped:<column>'` marker.
-- A tenant-reachable table without both is a table the leak suite cannot prove.
--
-- Migrations are append-only. Never edit this file; add a new numbered one.

-- ── users ────────────────────────────────────────────────────────────────────
-- A user is a person's identity INSIDE one tenant. Making users tenant-scoped
-- rather than global is deliberate: a global user table is tenant-reachable but
-- has no tenant column, so it can neither be marked nor proven, and it lets one
-- tenant enumerate another's people. Here, cross-tenant enumeration is refused
-- by the same policy that protects every other row.
--
-- Identity is separate from authorisation on purpose: revoking a membership
-- must not orphan the rows that reference the person who did the work.
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email         text NOT NULL
                  CHECK (length(email) BETWEEN 3 AND 320)
                  CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  display_name  text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  state         text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'disabled')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Lets memberships and invites carry a composite foreign key, so a row can
  -- never point at a user belonging to a different tenant — not even as admin.
  UNIQUE (id, tenant_id)
);

-- Addresses are compared case-insensitively; the stored form keeps whatever the
-- operator typed. Uniqueness is per tenant, never global.
CREATE UNIQUE INDEX users_tenant_email ON users (tenant_id, lower(email));

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON users TO workmill_app;
CREATE POLICY users_tenant_isolation ON users
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
COMMENT ON TABLE users IS 'tenant-scoped:tenant_id';

-- ── memberships ──────────────────────────────────────────────────────────────
-- The revocable grant: what a user may do in this tenant. One row per user per
-- tenant. Deleting it removes access without deleting the person.
CREATE TABLE memberships (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL,
  role        text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id),
  -- Composite, not `REFERENCES users(id)`: the pair must agree, so a membership
  -- cannot hand one tenant's user a seat at another tenant's table.
  FOREIGN KEY (user_id, tenant_id) REFERENCES users (id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX memberships_by_user ON memberships (user_id);

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON memberships TO workmill_app;
CREATE POLICY memberships_tenant_isolation ON memberships
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
COMMENT ON TABLE memberships IS 'tenant-scoped:tenant_id';

-- ── invites ──────────────────────────────────────────────────────────────────
-- A membership-shaped intent that exists before its user does. The raw token is
-- shown to the inviter once and never stored; only its sha256 hex digest lands
-- here, so a database read cannot mint access.
CREATE TABLE invites (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email             text NOT NULL
                      CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  role              text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  token_hash        text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  state             text NOT NULL DEFAULT 'pending'
                      CHECK (state IN ('pending', 'accepted', 'revoked')),
  expires_at        timestamptz NOT NULL,
  accepted_at       timestamptz,
  accepted_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- An accepted invite carries its timestamp and nothing else does. The two
  -- cannot drift apart, so "accepted" always has a paper trail.
  CONSTRAINT invites_accepted_shape CHECK ((state = 'accepted') = (accepted_at IS NOT NULL))
);

-- One live invite per address per tenant; spent and revoked ones stay for the
-- trail. Partial, so re-inviting after a revoke is allowed.
CREATE UNIQUE INDEX invites_one_pending ON invites (tenant_id, lower(email))
  WHERE state = 'pending';

ALTER TABLE invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE invites FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON invites TO workmill_app;
CREATE POLICY invites_tenant_isolation ON invites
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
COMMENT ON TABLE invites IS 'tenant-scoped:tenant_id';

-- ── entitlements ─────────────────────────────────────────────────────────────
-- The tenant's limits, one row per tenant. This migration creates the table and
-- its constraints only. Enforcement — the token ledger, the budget refusal, the
-- concurrency cap in the claim query — is SPEC.md feature 5 and lands with the
-- metering phase. The numbers a tenant is provisioned with live in
-- src/tenancy/provision.ts and are provisional until then.
CREATE TABLE entitlements (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  daily_token_budget   bigint  NOT NULL CHECK (daily_token_budget >= 0),
  max_concurrent_jobs  integer NOT NULL CHECK (max_concurrent_jobs BETWEEN 1 AND 1000),
  max_items_per_order  integer NOT NULL CHECK (max_items_per_order BETWEEN 1 AND 100000),
  max_item_chars       integer NOT NULL CHECK (max_item_chars BETWEEN 1 AND 1000000),
  -- Logical model names, resolved by the gateway. Empty means "no model is
  -- allowed", which would silently stall every order — require at least one.
  allowed_models       text[] NOT NULL CHECK (cardinality(allowed_models) >= 1),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE entitlements FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON entitlements TO workmill_app;
CREATE POLICY entitlements_tenant_isolation ON entitlements
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
COMMENT ON TABLE entitlements IS 'tenant-scoped:tenant_id';
