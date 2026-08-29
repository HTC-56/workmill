-- 006 — metering and entitlement enforcement (SPEC.md feature 5).
--
-- Migration 003 created the `entitlements` table and said out loud that nothing
-- enforced it. This migration is where the numbers start refusing things.
--
-- The spec's wording is the design: limits are "enforced by constraints,
-- policies, and the claim query, not UI checks". So the caps live in three
-- places that a caller cannot route around —
--   * `token_ledger`, the per-tenant record of what was actually spent, under
--     the same RLS as every other tenant table;
--   * two BEFORE INSERT triggers, so an oversized item or an oversized order is
--     refused by the database even when the insert is hand-written SQL;
--   * the claim query (src/queue/claim.ts), which reads this table and the
--     entitlements row in the same statement that takes the work.
--
-- ONE fail-open seam, named rather than hidden: a tenant with NO entitlements
-- row has no limits. `provisionTenant` writes that row in the same transaction
-- as the tenant, so a production tenant always has one; the rows without one are
-- bare test fixtures. Making it fail-closed is recorded in ROADMAP.md's ledger.
--
-- Migrations are append-only. Never edit this file; add a new numbered one.

-- ── work orders can say why they stopped ─────────────────────────────────────
-- "Budget exhaustion refuses further claims mid-order and the order says so."
-- The order does not change state: it is still open, still has pending items,
-- and will resume on its own when the day's spend resets. What it carries is the
-- reason its items stopped moving, which is what a dashboard shows and what a
-- tenant asks about.
ALTER TABLE work_orders ADD COLUMN blocked_reason text
  CHECK (blocked_reason IS NULL OR blocked_reason IN ('daily-token-budget-exhausted'));
ALTER TABLE work_orders ADD COLUMN blocked_at timestamptz;
ALTER TABLE work_orders ADD CONSTRAINT work_orders_blocked_stamp
  CHECK ((blocked_reason IS NULL) = (blocked_at IS NULL));

-- Lets `token_ledger` carry a composite foreign key to the order, the same way
-- `job_results` carries one to the job: a spend row can never attach itself to
-- another tenant's order, not even written as admin.
ALTER TABLE work_orders ADD CONSTRAINT work_orders_id_tenant_unique UNIQUE (id, tenant_id);

-- ── token_ledger ─────────────────────────────────────────────────────────────
-- The per-tenant token ledger (SPEC.md feature 5). `job_results` already stores
-- the tokens one job cost; this table is the same numbers arranged for the
-- question the budget asks — "how much has this tenant spent today?" — without
-- scanning results and without joining jobs.
--
-- One row per job, keyed by `job_id`, for the same reason `job_results` is:
-- delivery is at-least-once, so a job that runs twice must not be billed twice.
-- The second run replaces the first row rather than adding to it.
--
-- `usage_day` is the UTC date, computed once here and compared the same way
-- everywhere. A budget that reset at the server's local midnight would reset at
-- a different instant per deployment, and "your budget resets at midnight" would
-- be a different promise on each box.
CREATE TABLE token_ledger (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job_id             uuid NOT NULL,
  order_id           uuid NOT NULL,
  usage_day          date NOT NULL DEFAULT ((now() AT TIME ZONE 'UTC')::date),
  -- The model the gateway reported running, matching `job_results.model`.
  model              text NOT NULL,
  prompt_tokens      integer NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
  completion_tokens  integer NOT NULL DEFAULT 0 CHECK (completion_tokens >= 0),
  total_tokens       integer NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id),
  FOREIGN KEY (job_id, tenant_id) REFERENCES jobs (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (order_id, tenant_id) REFERENCES work_orders (id, tenant_id) ON DELETE CASCADE
);

-- The budget question, column-for-column: one tenant, one day, sum the totals.
CREATE INDEX token_ledger_day ON token_ledger (tenant_id, usage_day);
-- Spend for one order, for the per-order cost the dashboard shows.
CREATE INDEX token_ledger_by_order ON token_ledger (order_id);

ALTER TABLE token_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE token_ledger FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON token_ledger TO workmill_app;
CREATE POLICY token_ledger_tenant_isolation ON token_ledger
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
COMMENT ON TABLE token_ledger IS 'tenant-scoped:tenant_id';

-- ── the item caps, enforced by the database ──────────────────────────────────
-- These two could have been `if` statements in src/queue/enqueue.ts, and they
-- are there too — a caller deserves a typed refusal before it writes anything.
-- But a limit that only exists in the submit path is a limit that any other
-- INSERT skips, and this repo's whole claim is that isolation and limits are
-- properties of the data, not of the code that happens to be in front of it.
--
-- Both look the cap up by the NEW row's own tenant, so they hold on either seam:
-- under withTenant() the policy exposes exactly that one entitlements row, and
-- under withAdmin() the bootstrap role reads it directly. A seed script cannot
-- quietly write an item the tenant's own limits forbid. The only way past them is
-- a tenant with no entitlements row at all — the named fail-open seam above,
-- where the cap is NULL and the comparison is skipped.
CREATE FUNCTION enforce_item_chars() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  cap integer;
BEGIN
  SELECT e.max_item_chars INTO cap FROM entitlements AS e WHERE e.tenant_id = NEW.tenant_id;
  IF cap IS NOT NULL AND length(NEW.input) > cap THEN
    RAISE EXCEPTION 'item of % characters exceeds max_item_chars of %', length(NEW.input), cap
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER jobs_item_chars BEFORE INSERT ON jobs
  FOR EACH ROW EXECUTE FUNCTION enforce_item_chars();

CREATE FUNCTION enforce_items_per_order() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  cap integer;
BEGIN
  SELECT e.max_items_per_order INTO cap FROM entitlements AS e WHERE e.tenant_id = NEW.tenant_id;
  IF cap IS NOT NULL AND NEW.item_count > cap THEN
    RAISE EXCEPTION 'order of % items exceeds max_items_per_order of %', NEW.item_count, cap
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER work_orders_item_count BEFORE INSERT ON work_orders
  FOR EACH ROW EXECUTE FUNCTION enforce_items_per_order();
