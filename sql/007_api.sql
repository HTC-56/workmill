-- 007 — the API token table (SPEC.md feature 8, "static bearer auth").
--
-- Every phase so far has been a library: functions taking a `Session` that some
-- test called. This migration is the first row of the HTTP surface, because the
-- surface needs one thing the library never did — a way to answer "which tenant
-- is this request?" from a string a stranger sent us.
--
-- The spec's non-goals fence what that string may be: "no SSO, no OAuth, no
-- password reset — opaque bearer session tokens minted by a CLI helper and test
-- fixtures. Auth is a seam, not the product." So this table is deliberately
-- boring: a random token, stored as its sha256 digest, optionally attached to a
-- user, optionally expiring, revocable.
--
-- Storing the digest and never the token follows `invites.token_hash` from
-- sql/003 exactly, for the same reason: a database dump of this table is not a
-- set of live credentials. The digest is also the lookup key, so resolving a
-- bearer is one unique-index probe.
--
-- THE ONE ASYMMETRY, named rather than hidden: resolving a token happens BEFORE
-- a tenant is known, so it cannot run under withTenant() — the policy would
-- filter the row we are trying to find. `resolveApiToken` in src/server/auth.ts
-- is therefore a withAdmin() path, and it is the only one on a tenant-reachable
-- request. It reads exactly one column set by digest and returns only the ids;
-- everything downstream of it runs under withTenant() with the tenant it found.
--
-- The table is still tenant-scoped and still under RLS, because listing and
-- revoking your own tokens is ordinary tenant work and must not see anyone
-- else's — the leak suite covers it like every other table.
--
-- Migrations are append-only. Never edit this file; add a new numbered one.

CREATE TABLE api_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Optional: a token may act for a person (dashboard session) or for the
  -- tenant itself (a script). Composite, so a token can never name a user who
  -- belongs to some other tenant.
  user_id      uuid,
  -- What a human calls it in the console: "laptop", "ci", "demo seed".
  name         text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  -- sha256 hex of the raw token. The raw token exists only in the response that
  -- minted it; there is no way back to it from this row.
  token_hash   text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- NULL means "does not expire". A demo tenant's tokens should set this.
  expires_at   timestamptz,
  -- Stamped on every successful resolve, so an operator can spot a dead token.
  -- It is the only write on the request path, and it is best-effort.
  last_used_at timestamptz,
  revoked_at   timestamptz,
  FOREIGN KEY (user_id, tenant_id) REFERENCES users (id, tenant_id) ON DELETE CASCADE
);

-- Listing a tenant's own tokens, newest first — the console's table.
CREATE INDEX api_tokens_by_tenant ON api_tokens (tenant_id, created_at DESC);

ALTER TABLE api_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_tokens FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON api_tokens TO workmill_app;
CREATE POLICY api_tokens_tenant_isolation ON api_tokens
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
COMMENT ON TABLE api_tokens IS 'tenant-scoped:tenant_id';
