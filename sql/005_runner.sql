-- 005 — the job runner: leases with heartbeat, retries, dead-letter, cancel,
-- and the durable result row (SPEC.md feature 3, plus feature 4's usage capture
-- finally landing somewhere that survives a restart).
--
-- Migration 002 built the claim. This one builds everything that happens after
-- a job is claimed: renewing a lease while work is genuinely in flight, putting
-- a job back with a backoff when the hop to the model failed, retiring it to the
-- dead-letter after too many of those, requeueing it by verb, cancelling it, and
-- writing down what the model actually said.
--
-- Two failure words, deliberately different. A job is `failed` when the model
-- answered but the answer never validated — the bounded re-ask in
-- `src/gateway/complete.ts` already tried, and asking a fourth time at
-- temperature 0 buys nothing but tokens. A job is `dead` when we could not get
-- an answer at all after `max_attempts` transport failures. The first is a
-- content result and is written to `job_results`; the second is an
-- infrastructure outcome and is what the dead-letter view lists.
--
-- Migrations are append-only. Never edit this file; add a new numbered one.

-- ── the pin becomes mandatory ────────────────────────────────────────────────
-- Reserved in ROADMAP.md's ledger when migration 004 added the column: the queue
-- predates workflows, so the pin was nullable for exactly one phase. The runner
-- is the submit path's other half — it loads the definition an order pinned in
-- order to run it — so an order with no pin is now a row the database refuses
-- rather than a job the runner cannot execute.
ALTER TABLE work_orders ALTER COLUMN workflow_version_id SET NOT NULL;

-- ── jobs: the columns the lifecycle writes ───────────────────────────────────

-- The retry budget lives in the row, not in a constant, so an operator reading a
-- dead job can see the rule it died under rather than inferring it from code.
ALTER TABLE jobs ADD COLUMN max_attempts integer NOT NULL DEFAULT 3
  CHECK (max_attempts >= 1);

-- When it was retired to the dead-letter. Paired with the state by the CHECK
-- below, so `state = 'dead'` and a stamp can never disagree.
ALTER TABLE jobs ADD COLUMN dead_at timestamptz;

-- Cancel is a request, not an edit, because a RUNNING job is being worked on by
-- a process that is not this transaction. The runner's heartbeat is what reads
-- this column, aborts the in-flight model call, and records that it did.
ALTER TABLE jobs ADD COLUMN cancel_requested_at timestamptz;

-- "Dead-letter preserving the full failure trail" (SPEC.md feature 3). Every
-- attempt that ended badly appends one object: `{attempt, at, kind, error}`.
-- Requeueing resets the attempt budget but never truncates this — the trail is
-- the record of what the job survived, and it is what makes a dead job
-- diagnosable months later.
ALTER TABLE jobs ADD COLUMN failure_trail jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(failure_trail) = 'array');

ALTER TABLE jobs ADD CONSTRAINT jobs_dead_stamp
  CHECK ((state = 'dead') = (dead_at IS NOT NULL));

-- Lets `job_results` carry a composite foreign key, the same way work orders
-- carry one to a workflow version: a result can never attach itself to another
-- tenant's job, not even written as admin.
ALTER TABLE jobs ADD CONSTRAINT jobs_id_tenant_unique UNIQUE (id, tenant_id);

-- The dead-letter view's index: one tenant's dead jobs, most recent first.
CREATE INDEX jobs_dead_letter ON jobs (tenant_id, dead_at DESC) WHERE state = 'dead';

-- ── job_results ──────────────────────────────────────────────────────────────
-- What the model said, kept. Until now a completion's parsed output and its
-- token counts existed only in memory and vanished with the process (recorded
-- in ROADMAP.md's ledger as exactly that); this table is where they land.
--
-- One row per job, not per attempt: the re-ask rounds inside one run are an
-- implementation detail of getting an answer, and `attempts` plus the summed
-- token counts say how expensive that was. Delivery is at-least-once, so a job
-- that runs twice upserts on `job_id` rather than accumulating duplicates.
--
-- A failed result is still a row. The raw text the model produced and the
-- validation errors it produced are the whole point of storing it — a tenant
-- looking at an item that did not validate needs to see what came back.
CREATE TABLE job_results (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job_id             uuid NOT NULL,
  ok                 boolean NOT NULL,
  -- The parsed, schema-valid object. Present exactly when `ok`.
  output             jsonb CHECK (output IS NULL OR jsonb_typeof(output) = 'object'),
  -- The assistant text verbatim, valid or not.
  raw_output         text NOT NULL,
  failure_reason     text CHECK (failure_reason IN ('unparseable', 'schema-invalid')),
  errors             jsonb NOT NULL DEFAULT '[]'::jsonb
                       CHECK (jsonb_typeof(errors) = 'array'),
  -- The model the gateway reported running, which may differ from the logical
  -- name the workflow asked for. The paper trail wants what actually answered.
  model              text NOT NULL,
  attempts           integer NOT NULL CHECK (attempts >= 1),
  prompt_tokens      integer NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
  completion_tokens  integer NOT NULL DEFAULT 0 CHECK (completion_tokens >= 0),
  total_tokens       integer NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
  latency_ms         integer NOT NULL DEFAULT 0 CHECK (latency_ms >= 0),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id),
  -- The two shapes, spelled out: a success carries an output and no reason, a
  -- failure carries a reason. Neither can be half-written.
  CONSTRAINT job_results_shape CHECK (
    (ok AND output IS NOT NULL AND failure_reason IS NULL)
    OR (NOT ok AND output IS NULL AND failure_reason IS NOT NULL)
  ),
  FOREIGN KEY (job_id, tenant_id) REFERENCES jobs (id, tenant_id) ON DELETE CASCADE
);

-- The results table for one order, in submitted item order, is a join away.
CREATE INDEX job_results_by_tenant ON job_results (tenant_id, created_at DESC);

ALTER TABLE job_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_results FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON job_results TO workmill_app;
CREATE POLICY job_results_tenant_isolation ON job_results
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
COMMENT ON TABLE job_results IS 'tenant-scoped:tenant_id';
