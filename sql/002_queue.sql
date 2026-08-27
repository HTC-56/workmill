-- 002 — work orders and the durable job queue.
--
-- worklane's mechanics re-proven on Postgres INSIDE the tenant boundary: jobs
-- and orders are ordinary tenant-scoped rows, so the same RLS that protects
-- tenant data protects the queue, and the leak suite covers it for free.
--
-- Migrations are append-only. Never edit this file; add a new numbered one.

CREATE TABLE work_orders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  state       text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'done', 'cancelled')),
  item_count  integer NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE work_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_orders FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON work_orders TO workmill_app;
CREATE POLICY work_orders_tenant_isolation ON work_orders
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
COMMENT ON TABLE work_orders IS 'tenant-scoped:tenant_id';

CREATE TABLE jobs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id          uuid NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  idx               integer NOT NULL CHECK (idx >= 0),
  input             text NOT NULL,
  state             text NOT NULL DEFAULT 'pending'
                      CHECK (state IN ('pending', 'running', 'succeeded', 'failed', 'dead', 'cancelled')),
  attempts          integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  run_at            timestamptz NOT NULL DEFAULT now(),
  lease_expires_at  timestamptz,
  claimed_by        text,
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, idx),
  -- A running job holds a lease; nothing else does. The claim query and the
  -- lease reaper are the only writers of this pair, and the constraint means a
  -- lost lease cannot masquerade as a running job.
  CONSTRAINT jobs_lease_matches_state CHECK (
    (state = 'running') = (lease_expires_at IS NOT NULL)
  )
);

-- The claim query's index, column-for-column: only pending rows are scanned,
-- oldest-due first, and within an order in submitted position.
CREATE INDEX jobs_claimable ON jobs (run_at, created_at, order_id, idx) WHERE state = 'pending';
CREATE INDEX jobs_lease_expiry ON jobs (lease_expires_at) WHERE state = 'running';
CREATE INDEX jobs_by_order ON jobs (order_id, idx);

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON jobs TO workmill_app;
CREATE POLICY jobs_tenant_isolation ON jobs
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
COMMENT ON TABLE jobs IS 'tenant-scoped:tenant_id';
