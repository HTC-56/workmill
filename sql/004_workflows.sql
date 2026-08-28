-- 004 — workflows as tenant data, not code (SPEC.md feature 2).
--
-- A workflow is a name, a prompt template, a JSON output schema, a logical
-- model name and two parameters. It is DATA: rows a tenant owns, under the same
-- RLS shape as every other tenant-scoped table. There is no handler column, no
-- expression column, no code path a tenant can influence beyond substituting
-- its item into `{{input}}` — SPEC.md's "no arbitrary code execution" non-goal
-- is a schema property here, not a convention.
--
-- Versioning is why there are two tables. An edit never rewrites a definition;
-- it appends a new `workflow_versions` row and moves the workflow's pointer.
-- A work order pins the version id it was submitted against, so a result read
-- months later can still be traced to the exact prompt, schema, model and
-- parameters that produced it.
--
-- Migrations are append-only. Never edit this file; add a new numbered one.

-- ── workflows ────────────────────────────────────────────────────────────────
-- The stable identity a tenant names and lists. Everything that can be edited
-- lives on its versions, so this row's shape never depends on a definition.
CREATE TABLE workflows (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  slug             text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  name             text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  state            text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'archived')),
  -- The version number the next run gets. Bumped in the same statement that
  -- reads it, so two concurrent edits cannot mint the same version number.
  current_version  integer NOT NULL DEFAULT 1 CHECK (current_version >= 1),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- Lets versions carry a composite foreign key, so a version can never point
  -- at a workflow belonging to a different tenant — not even as admin.
  UNIQUE (id, tenant_id)
);

-- Handles are unique per tenant, never globally: two tenants may both have a
-- workflow called `summarize`, and neither learns the other exists.
CREATE UNIQUE INDEX workflows_tenant_slug ON workflows (tenant_id, slug);

ALTER TABLE workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflows FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON workflows TO workmill_app;
CREATE POLICY workflows_tenant_isolation ON workflows
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
COMMENT ON TABLE workflows IS 'tenant-scoped:tenant_id';

-- ── workflow_versions ────────────────────────────────────────────────────────
-- One immutable definition. `src/workflows/store.ts` is the only writer and it
-- only ever inserts; the four verbs are granted because RLS proves itself on
-- all four in the leak suite, not because anything updates these rows.
CREATE TABLE workflow_versions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_id        uuid NOT NULL,
  version            integer NOT NULL CHECK (version >= 1),
  -- The whole template language: one `{{input}}` substitution. Requiring the
  -- placeholder at the data layer means a definition that could never see its
  -- item is refused before it can be submitted against.
  prompt_template    text NOT NULL
                       CHECK (length(prompt_template) BETWEEN 1 AND 20000)
                       CHECK (strpos(prompt_template, '{{input}}') > 0),
  -- The JSON Schema the model's output is validated against. Stored, not
  -- interpreted: schema-checking a completion is SPEC.md feature 4, and this
  -- CHECK only refuses a value that could not be a schema at all.
  output_schema      jsonb NOT NULL CHECK (jsonb_typeof(output_schema) = 'object'),
  -- A LOGICAL model name. The gateway maps it to whatever is loaded; workmill
  -- never names a model server. The tenant's allowed-model list is enforced at
  -- submit time in the metering phase, not here.
  model              text NOT NULL CHECK (length(model) BETWEEN 1 AND 100),
  temperature        numeric(3,2) NOT NULL DEFAULT 0 CHECK (temperature BETWEEN 0 AND 2),
  max_output_tokens  integer NOT NULL DEFAULT 512 CHECK (max_output_tokens BETWEEN 1 AND 32768),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, version),
  -- Lets work orders carry a composite foreign key to a version.
  UNIQUE (id, tenant_id),
  -- Composite, not `REFERENCES workflows(id)`: the pair must agree, so a
  -- version cannot attach itself to another tenant's workflow.
  FOREIGN KEY (workflow_id, tenant_id) REFERENCES workflows (id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX workflow_versions_by_workflow ON workflow_versions (workflow_id, version DESC);

ALTER TABLE workflow_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_versions FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON workflow_versions TO workmill_app;
CREATE POLICY workflow_versions_tenant_isolation ON workflow_versions
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
COMMENT ON TABLE workflow_versions IS 'tenant-scoped:tenant_id';

-- ── the pin ──────────────────────────────────────────────────────────────────
-- "Every run pins the version it ran under" (SPEC.md feature 2). An order is
-- the unit that carries the pin: every job in it runs the same definition, and
-- a requeued job re-runs the version its order was submitted against, never
-- whatever the workflow has since become.
--
-- Nullable for one phase only: the queue predates workflows, and the submit
-- path that always sets it is SPEC.md feature 3's. Recorded in ROADMAP.md's
-- reservations ledger; the runner phase makes it NOT NULL.
ALTER TABLE work_orders ADD COLUMN workflow_version_id uuid;

-- Composite again: an order can only pin a version its own tenant owns. RLS
-- already hides other tenants' versions, and this refuses the write outright.
ALTER TABLE work_orders
  ADD CONSTRAINT work_orders_version_same_tenant
  FOREIGN KEY (workflow_version_id, tenant_id)
  REFERENCES workflow_versions (id, tenant_id);

CREATE INDEX work_orders_by_version ON work_orders (workflow_version_id)
  WHERE workflow_version_id IS NOT NULL;
