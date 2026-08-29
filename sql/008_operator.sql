-- 008 — the operator console's two tables (SPEC.md feature 7).
--
-- Feature 7 asks for "support-access grants with required reason + TTL
-- countdown" and an "append-only audit trail the tenant itself can read
-- (RLS-scoped)". Both of those are data, and both of them are TENANT data —
-- which is the point. An operator action recorded only in the operator's own
-- console is a claim; an operator action recorded in a row the tenant can read
-- with its own bearer is a receipt.
--
-- So both tables carry the tenant-scoped marker and go under the same policies
-- as every other table in this repo. The leak suite discovers them at runtime
-- and proves all four verbs refuse across the boundary, exactly as it does for
-- the twelve tables before them.
--
-- WHY A GRANT IS A ROW AND NOT A FLAG: the spec wants a reason and a countdown.
-- A boolean "support may look" cannot carry either. The reason is NOT NULL with
-- a length floor, so "because" is not an answer; `expires_at` is NOT NULL and
-- must be after `created_at`, so a grant that never ends cannot be written at
-- all. Revocation is a timestamp rather than a delete, because the audit trail
-- above it would otherwise reference a row that no longer exists.
--
-- THE APPEND-ONLY CALL, named rather than hidden: `audit_log` is append-only by
-- construction, not by grant. Nothing in `src/` updates or deletes an audit row
-- and the API exposes no verb that could. It is NOT enforced with a
-- REVOKE or a `USING (false)` policy, because the catalog leak suite asserts
-- that every tenant-scoped table accepts a same-tenant UPDATE and refuses a
-- cross-tenant one by matching zero rows; a table that answered "permission
-- denied" instead would have to change that assertion for all fourteen tables.
-- Weakening the isolation proof to strengthen a write-path rule is the wrong
-- trade. Recorded in ROADMAP.md's reservations ledger.
--
-- Migrations are append-only. Never edit this file; add a new numbered one.

CREATE TABLE support_grants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Required, and long enough to be a sentence. The console makes an operator
  -- type it before the button does anything; this is where that becomes a rule.
  reason      text NOT NULL CHECK (length(btrim(reason)) BETWEEN 8 AND 500),
  -- Who the operator says they are. There is no operator identity system in v1
  -- (SPEC.md non-goals fence out SSO), so this is a self-declared label that the
  -- tenant can read — which is still more accountable than an anonymous action.
  granted_by  text NOT NULL CHECK (length(btrim(granted_by)) BETWEEN 1 AND 80),
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- NOT NULL: every grant ends. The countdown in the console reads this.
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  CONSTRAINT support_grants_ends_after_it_starts CHECK (expires_at > created_at)
);

-- The console's per-tenant list, newest first, and the "is there a live grant"
-- probe both read this way.
CREATE INDEX support_grants_by_tenant ON support_grants (tenant_id, expires_at DESC);

ALTER TABLE support_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_grants FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON support_grants TO workmill_app;
CREATE POLICY support_grants_tenant_isolation ON support_grants
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
COMMENT ON TABLE support_grants IS 'tenant-scoped:tenant_id';

CREATE TABLE audit_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  at         timestamptz NOT NULL DEFAULT now(),
  -- 'operator' for a console action; a tenant-side actor label later.
  actor      text NOT NULL CHECK (length(btrim(actor)) BETWEEN 1 AND 80),
  -- A dotted verb: 'support.granted', 'entitlements.updated'. The vocabulary
  -- lives in src/operator/audit.ts; the constraint here is only a length, so a
  -- new action is a code change and not a migration.
  action     text NOT NULL CHECK (length(btrim(action)) BETWEEN 3 AND 60),
  -- What changed, as ids and numbers. Never item text and never a token: this
  -- table is readable by the tenant and quoted back in support conversations.
  detail     jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Set when the entry is about one grant, so the console can line them up.
  grant_id   uuid REFERENCES support_grants(id) ON DELETE SET NULL
);

CREATE INDEX audit_log_by_tenant ON audit_log (tenant_id, at DESC);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON audit_log TO workmill_app;
CREATE POLICY audit_log_tenant_isolation ON audit_log
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
COMMENT ON TABLE audit_log IS 'tenant-scoped:tenant_id';
