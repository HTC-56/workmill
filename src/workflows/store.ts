import type { Session } from '../db/engine.js';

/**
 * Workflow CRUD and versioning (SPEC.md feature 2).
 *
 * Every function here takes a `Session`, like `getEntitlements` in
 * `src/tenancy/entitlements.ts` and `enqueueOrder` in `src/queue/enqueue.ts`:
 * they run inside `withTenant()`, so RLS decides which rows exist. That is why
 * none of the reads carry a `WHERE tenant_id = …` clause — the policy already
 * did it, and a workflow belonging to another tenant is indistinguishable from
 * one that was never created.
 *
 * The versioning rule is the whole point of the file: an edit never rewrites a
 * definition. `updateWorkflow` bumps the workflow's pointer and appends a new
 * `workflow_versions` row, so a result read months later can be traced to the
 * exact prompt, schema, model and parameters that produced it.
 */

/** What a run needs to know. Editable; each edit becomes a new version. */
export interface WorkflowDefinition {
  /** Must contain `{{input}}` — the only substitution this product performs. */
  promptTemplate: string;
  /** JSON Schema for the model's output. Stored here, enforced by feature 4. */
  outputSchema: Record<string, unknown>;
  /** A logical model name; the gateway resolves it. */
  model: string;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface Workflow {
  id: string;
  slug: string;
  name: string;
  state: 'active' | 'archived';
  /** The version number a submission made right now would pin. */
  currentVersion: number;
  createdAt: Date;
}

export interface WorkflowVersion {
  id: string;
  workflowId: string;
  version: number;
  promptTemplate: string;
  outputSchema: Record<string, unknown>;
  model: string;
  temperature: number;
  maxOutputTokens: number;
  createdAt: Date;
}

export interface CreateWorkflowRequest extends WorkflowDefinition {
  /** URL-safe handle, unique per tenant; the CHECK in sql/004 is authoritative. */
  slug: string;
  name: string;
}

/** Defaults for the two run parameters, matching the columns in sql/004. */
export const DEFAULT_TEMPERATURE = 0;
export const DEFAULT_MAX_OUTPUT_TOKENS = 512;

/** The one placeholder a prompt template may contain. */
export const INPUT_PLACEHOLDER = '{{input}}';

export class WorkflowNotFoundError extends Error {
  constructor(id: string) {
    // Says nothing about whose it is: under RLS, another tenant's workflow and
    // a workflow that never existed are the same fact.
    super(`no such workflow: ${id}`);
    this.name = 'WorkflowNotFoundError';
  }
}

export class InvalidWorkflowError extends Error {
  constructor(problem: string) {
    super(`invalid workflow definition: ${problem}`);
    this.name = 'InvalidWorkflowError';
  }
}

/**
 * Refuse a definition the database would refuse anyway, with a message that
 * names the field. The CHECK constraints in sql/004 are the authority; this is
 * the friendlier half of the same rules, run before the round trip.
 */
export function assertValidDefinition(definition: WorkflowDefinition): void {
  const { promptTemplate, outputSchema, model } = definition;
  if (!promptTemplate || promptTemplate.length > 20_000) {
    throw new InvalidWorkflowError('promptTemplate must be 1..20000 characters');
  }
  if (!promptTemplate.includes(INPUT_PLACEHOLDER)) {
    throw new InvalidWorkflowError(`promptTemplate must contain ${INPUT_PLACEHOLDER}`);
  }
  if (typeof outputSchema !== 'object' || outputSchema === null || Array.isArray(outputSchema)) {
    throw new InvalidWorkflowError('outputSchema must be a JSON object');
  }
  if (outputSchema['type'] !== 'object') {
    throw new InvalidWorkflowError('outputSchema must be an object schema ("type": "object")');
  }
  if (!model || model.length > 100) {
    throw new InvalidWorkflowError('model must be 1..100 characters');
  }
  const temperature = definition.temperature ?? DEFAULT_TEMPERATURE;
  if (!(temperature >= 0 && temperature <= 2)) {
    throw new InvalidWorkflowError('temperature must be between 0 and 2');
  }
  const maxOutputTokens = definition.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 32_768) {
    throw new InvalidWorkflowError('maxOutputTokens must be an integer in 1..32768');
  }
}

type WorkflowRow = {
  id: string;
  slug: string;
  name: string;
  state: string;
  current_version: number | string;
  created_at: Date;
};

type VersionRow = {
  id: string;
  workflow_id: string;
  version: number | string;
  prompt_template: string;
  output_schema: unknown;
  model: string;
  temperature: number | string;
  max_output_tokens: number | string;
  created_at: Date;
};

const WORKFLOW_COLUMNS = 'id, slug, name, state, current_version, created_at';
const VERSION_COLUMNS =
  'id, workflow_id, version, prompt_template, output_schema, model, temperature, max_output_tokens, created_at';

function toWorkflow(row: WorkflowRow): Workflow {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    state: row.state as Workflow['state'],
    currentVersion: Number(row.current_version),
    createdAt: row.created_at,
  };
}

function toVersion(row: VersionRow): WorkflowVersion {
  // jsonb arrives parsed from both drivers today; a string would still be valid
  // JSON, so parse defensively rather than trusting the driver's type map.
  const schema = typeof row.output_schema === 'string'
    ? (JSON.parse(row.output_schema) as Record<string, unknown>)
    : (row.output_schema as Record<string, unknown>);
  return {
    id: row.id,
    workflowId: row.workflow_id,
    version: Number(row.version),
    promptTemplate: row.prompt_template,
    outputSchema: schema,
    model: row.model,
    // numeric(3,2) arrives as a string from one of the two drivers.
    temperature: Number(row.temperature),
    maxOutputTokens: Number(row.max_output_tokens),
    createdAt: row.created_at,
  };
}

/** Insert one version row for an existing workflow at an already-minted number. */
async function insertVersion(
  sql: Session,
  workflowId: string,
  version: number,
  definition: WorkflowDefinition,
): Promise<WorkflowVersion> {
  const [row] = await sql.query<VersionRow>(
    `INSERT INTO workflow_versions
       (tenant_id, workflow_id, version, prompt_template, output_schema, model,
        temperature, max_output_tokens)
     SELECT w.tenant_id, w.id, $2, $3, $4::jsonb, $5, $6, $7
       FROM workflows w
      WHERE w.id = $1
     RETURNING ${VERSION_COLUMNS}`,
    [
      workflowId,
      version,
      definition.promptTemplate,
      JSON.stringify(definition.outputSchema),
      definition.model,
      definition.temperature ?? DEFAULT_TEMPERATURE,
      definition.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    ],
  );
  // The SELECT reads `workflows` under the same policy that hid it from the
  // caller, so a workflow this tenant cannot see produces no row to insert.
  if (!row) throw new WorkflowNotFoundError(workflowId);
  return toVersion(row);
}

/** Create a workflow and its version 1. Both rows or neither. */
export async function createWorkflow(
  sql: Session,
  request: CreateWorkflowRequest,
): Promise<{ workflow: Workflow; version: WorkflowVersion }> {
  assertValidDefinition(request);
  const [row] = await sql.query<WorkflowRow>(
    `INSERT INTO workflows (tenant_id, slug, name)
     VALUES (app_tenant_id(), $1, $2)
     RETURNING ${WORKFLOW_COLUMNS}`,
    [request.slug, request.name],
  );
  if (!row) throw new Error('workflow insert returned no row');
  const version = await insertVersion(sql, row.id, 1, request);
  return { workflow: toWorkflow(row), version };
}

/**
 * Edit a workflow: mint the next version number and append its definition. The
 * previous version row is untouched and still readable by any order that pinned
 * it. The number is minted by the UPDATE itself, so two concurrent edits get
 * two different versions rather than colliding on `UNIQUE (workflow_id, version)`.
 */
export async function updateWorkflow(
  sql: Session,
  workflowId: string,
  definition: WorkflowDefinition,
): Promise<WorkflowVersion> {
  assertValidDefinition(definition);
  const [row] = await sql.query<{ current_version: number | string }>(
    `UPDATE workflows
        SET current_version = current_version + 1, updated_at = now()
      WHERE id = $1
     RETURNING current_version`,
    [workflowId],
  );
  if (!row) throw new WorkflowNotFoundError(workflowId);
  return insertVersion(sql, workflowId, Number(row.current_version), definition);
}

/** Rename a workflow. The definition is untouched; this mints no version. */
export async function renameWorkflow(
  sql: Session,
  workflowId: string,
  name: string,
): Promise<Workflow> {
  const [row] = await sql.query<WorkflowRow>(
    `UPDATE workflows SET name = $2, updated_at = now()
      WHERE id = $1 RETURNING ${WORKFLOW_COLUMNS}`,
    [workflowId, name],
  );
  if (!row) throw new WorkflowNotFoundError(workflowId);
  return toWorkflow(row);
}

/**
 * Retire a workflow without deleting it: orders that pinned its versions keep
 * their paper trail. Returns false when there is nothing to archive.
 */
export async function archiveWorkflow(sql: Session, workflowId: string): Promise<boolean> {
  const rows = await sql.query<{ id: string }>(
    `UPDATE workflows SET state = 'archived', updated_at = now()
      WHERE id = $1 AND state = 'active' RETURNING id`,
    [workflowId],
  );
  return rows.length === 1;
}

/** The current tenant's workflows, by slug. Archived ones are hidden by default. */
export async function listWorkflows(
  sql: Session,
  options: { includeArchived?: boolean } = {},
): Promise<Workflow[]> {
  const rows = await sql.query<WorkflowRow>(
    `SELECT ${WORKFLOW_COLUMNS} FROM workflows
      WHERE $1::boolean OR state = 'active'
      ORDER BY slug`,
    [options.includeArchived === true],
  );
  return rows.map(toWorkflow);
}

/** A workflow plus the definition a submission would pin right now. */
export async function getWorkflow(
  sql: Session,
  workflowId: string,
): Promise<{ workflow: Workflow; version: WorkflowVersion }> {
  const [row] = await sql.query<WorkflowRow>(
    `SELECT ${WORKFLOW_COLUMNS} FROM workflows WHERE id = $1`,
    [workflowId],
  );
  if (!row) throw new WorkflowNotFoundError(workflowId);
  const [versionRow] = await sql.query<VersionRow>(
    `SELECT ${VERSION_COLUMNS} FROM workflow_versions
      WHERE workflow_id = $1 ORDER BY version DESC LIMIT 1`,
    [workflowId],
  );
  if (!versionRow) throw new WorkflowNotFoundError(workflowId);
  return { workflow: toWorkflow(row), version: toVersion(versionRow) };
}

/** One pinned definition, by version id — how a result is traced to its prompt. */
export async function getWorkflowVersion(
  sql: Session,
  versionId: string,
): Promise<WorkflowVersion> {
  const [row] = await sql.query<VersionRow>(
    `SELECT ${VERSION_COLUMNS} FROM workflow_versions WHERE id = $1`,
    [versionId],
  );
  if (!row) throw new WorkflowNotFoundError(versionId);
  return toVersion(row);
}

/** Every version of one workflow, oldest first — the edit history. */
export async function listWorkflowVersions(
  sql: Session,
  workflowId: string,
): Promise<WorkflowVersion[]> {
  const rows = await sql.query<VersionRow>(
    `SELECT ${VERSION_COLUMNS} FROM workflow_versions
      WHERE workflow_id = $1 ORDER BY version`,
    [workflowId],
  );
  return rows.map(toVersion);
}
