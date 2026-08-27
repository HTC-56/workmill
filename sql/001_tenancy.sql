-- 001 — tenancy core: the application role, the tenant table, and the
-- current-tenant seam function every RLS policy in this repo is written against.
--
-- Migrations are append-only. Never edit this file; add a new numbered one.

-- The role the application runs as. It owns nothing and is not a superuser, so
-- row-level security is never bypassed for it. A real deployment connects with a
-- LOGIN role that is a member of this one; dev/test connect as the bootstrap
-- role and SET LOCAL ROLE into it per transaction.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'workmill_app') THEN
    CREATE ROLE workmill_app NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO workmill_app;

-- The current tenant, read from a transaction-local GUC set by withTenant().
-- Unset reads as NULL, never as an open door: `tenant_id = NULL` is NULL, which
-- is not true, so every policy below refuses. Fail-closed by construction.
CREATE OR REPLACE FUNCTION app_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

GRANT EXECUTE ON FUNCTION app_tenant_id() TO workmill_app;

CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  state       text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'suspended')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- `tenants` is tenant-scoped on its own primary key: a tenant sees exactly the
-- one row that is itself. Provisioning is an operator action, done as admin.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenants TO workmill_app;
CREATE POLICY tenants_tenant_isolation ON tenants
  USING (id = app_tenant_id())
  WITH CHECK (id = app_tenant_id());

-- The catalog-driven leak suite discovers tenant-scoped tables at runtime by
-- this marker, so a new table that forgets its policies fails the build rather
-- than leaking. Every tenant-scoped table gets one of these.
COMMENT ON TABLE tenants IS 'tenant-scoped:id';
