import type { Session } from '../db/engine.js';

/**
 * The read models behind the tenant dashboard (SPEC.md feature 6).
 *
 * Every function takes a `Session` and runs inside `withTenant()`, like the
 * workflow store and the ledger: no function here writes a `WHERE tenant_id`
 * clause, because the policy already did. A dashboard that filtered by tenant
 * in its own SQL would be a second, weaker copy of the isolation rule — and the
 * copy is the one that eventually drifts.
 *
 * These are shaped for a page, not for a report: one round trip per panel, with
 * the counts a progress bar needs already aggregated. The page polls them and
 * also listens to `/events`, so every payload here must be cheap enough to
 * fetch again a second later.
 */

/** Job counts for one order, by state. */
export interface OrderCounts {
  pending: number;
  running: number;
  succeeded: number;
  failed: number;
  dead: number;
  cancelled: number;
}

/** One row of the orders panel: the order, the version it pinned, its progress. */
export interface OrderSummary {
  orderId: string;
  state: 'open' | 'done' | 'cancelled';
  itemCount: number;
  /** Why the order stopped moving without being cancelled. Usually null. */
  blockedReason: string | null;
  createdAt: Date;
  workflowId: string;
  workflowSlug: string;
  workflowName: string;
  workflowVersionId: string;
  version: number;
  model: string;
  counts: OrderCounts;
  /** Items that will not move again: succeeded, failed, dead or cancelled. */
  finished: number;
  /** Tokens the ledger has billed this order so far. */
  totalTokens: number;
}

/** One submitted item, its job, and the result if it has one. */
export interface OrderItem {
  jobId: string;
  idx: number;
  state: string;
  attempts: number;
  lastError: string | null;
  /** The submitted text, truncated — the page shows it beside the output. */
  inputPreview: string;
  ok: boolean | null;
  /** The validated JSON object, present only for a succeeded item. */
  output: Record<string, unknown> | null;
  failureReason: string | null;
  errors: string[];
  model: string | null;
  totalTokens: number;
  latencyMs: number;
}

export interface OrderDetail {
  order: OrderSummary;
  items: OrderItem[];
}

/** One dead-lettered item, with enough trail to decide whether to requeue it. */
export interface DeadItem {
  jobId: string;
  orderId: string;
  idx: number;
  attempts: number;
  lastError: string | null;
  deadAt: Date | null;
  inputPreview: string;
  workflowSlug: string;
  /** Every attempt's failure, oldest first, as `failAttempt` recorded it. */
  failureTrail: unknown[];
}

/** A workflow plus the definition a submission made right now would pin. */
export interface WorkflowCard {
  workflowId: string;
  slug: string;
  name: string;
  version: number;
  versionId: string;
  model: string;
  promptTemplate: string;
  outputSchema: Record<string, unknown>;
}

/** How many rows a panel asks for when the request does not say. */
export const DEFAULT_PAGE_SIZE = 25;

/** The most any panel will return, whatever the query string asks for. */
export const MAX_PAGE_SIZE = 100;

/** How much of an item's text travels to the page beside its result. */
export const INPUT_PREVIEW_CHARS = 240;

/**
 * Turn a query-string value into a row count.
 *
 * A page size is the one number a caller can use to ask for the whole table,
 * so it is clamped rather than validated: garbage, zero and a million all land
 * somewhere sensible instead of becoming a 400 the page has to handle.
 */
export function clampPageSize(value: unknown, fallback = DEFAULT_PAGE_SIZE): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), MAX_PAGE_SIZE);
}

type SummaryRow = {
  id: string;
  state: string;
  item_count: number | string;
  blocked_reason: string | null;
  created_at: Date;
  workflow_version_id: string;
  version: number | string;
  model: string;
  workflow_id: string;
  workflow_slug: string;
  workflow_name: string;
  pending: number | string;
  running: number | string;
  succeeded: number | string;
  failed: number | string;
  dead: number | string;
  cancelled: number | string;
  total_tokens: number | string;
};

// Counting with FILTER keeps a state that has no rows at zero rather than
// absent, which is the same reason `renderMetrics` prints a zero series: a
// progress bar built from a map with holes in it reports the wrong total.
const SUMMARY_SELECT = `
  SELECT o.id, o.state, o.item_count, o.blocked_reason, o.created_at,
         o.workflow_version_id, v.version, v.model,
         w.id   AS workflow_id,
         w.slug AS workflow_slug,
         w.name AS workflow_name,
         count(j.id) FILTER (WHERE j.state = 'pending')   AS pending,
         count(j.id) FILTER (WHERE j.state = 'running')   AS running,
         count(j.id) FILTER (WHERE j.state = 'succeeded') AS succeeded,
         count(j.id) FILTER (WHERE j.state = 'failed')    AS failed,
         count(j.id) FILTER (WHERE j.state = 'dead')      AS dead,
         count(j.id) FILTER (WHERE j.state = 'cancelled') AS cancelled,
         coalesce((SELECT sum(t.total_tokens) FROM token_ledger t
                    WHERE t.order_id = o.id), 0) AS total_tokens
    FROM work_orders o
    JOIN workflow_versions v ON v.id = o.workflow_version_id
    JOIN workflows w ON w.id = v.workflow_id
    LEFT JOIN jobs j ON j.order_id = o.id`;

const SUMMARY_GROUP = ' GROUP BY o.id, v.id, w.id';

function toSummary(row: SummaryRow): OrderSummary {
  const counts: OrderCounts = {
    pending: Number(row.pending),
    running: Number(row.running),
    succeeded: Number(row.succeeded),
    failed: Number(row.failed),
    dead: Number(row.dead),
    cancelled: Number(row.cancelled),
  };
  return {
    orderId: row.id,
    state: row.state as OrderSummary['state'],
    itemCount: Number(row.item_count),
    blockedReason: row.blocked_reason,
    createdAt: row.created_at,
    workflowId: row.workflow_id,
    workflowSlug: row.workflow_slug,
    workflowName: row.workflow_name,
    workflowVersionId: row.workflow_version_id,
    version: Number(row.version),
    model: row.model,
    counts,
    finished: counts.succeeded + counts.failed + counts.dead + counts.cancelled,
    totalTokens: Number(row.total_tokens),
  };
}

/** The tenant's most recent orders, newest first. */
export async function listOrders(
  sql: Session,
  limit: number = DEFAULT_PAGE_SIZE,
): Promise<OrderSummary[]> {
  const rows = await sql.query<SummaryRow>(
    `${SUMMARY_SELECT}${SUMMARY_GROUP}
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT $1`,
    [clampPageSize(limit)],
  );
  return rows.map(toSummary);
}

/** One order's summary, or null when this tenant cannot see that order. */
export async function getOrderSummary(
  sql: Session,
  orderId: string,
): Promise<OrderSummary | null> {
  const [row] = await sql.query<SummaryRow>(
    `${SUMMARY_SELECT} WHERE o.id = $1${SUMMARY_GROUP}`,
    [orderId],
  );
  return row ? toSummary(row) : null;
}

type ItemRow = {
  id: string;
  idx: number | string;
  state: string;
  attempts: number | string;
  last_error: string | null;
  input_preview: string;
  ok: boolean | null;
  output: unknown;
  failure_reason: string | null;
  errors: unknown;
  model: string | null;
  total_tokens: number | string | null;
  latency_ms: number | string | null;
};

/** jsonb arrives parsed from both drivers today; a string is still valid JSON. */
function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function toItem(row: ItemRow): OrderItem {
  return {
    jobId: row.id,
    idx: Number(row.idx),
    state: row.state,
    attempts: Number(row.attempts),
    lastError: row.last_error,
    inputPreview: row.input_preview,
    ok: row.ok,
    output: row.ok === true ? parseJson<Record<string, unknown>>(row.output, {}) : null,
    failureReason: row.failure_reason,
    errors: parseJson<string[]>(row.errors, []),
    model: row.model,
    totalTokens: Number(row.total_tokens ?? 0),
    latencyMs: Number(row.latency_ms ?? 0),
  };
}

/**
 * One order and every item in it, in submitted order.
 *
 * `idx` orders the items, never `created_at`: every job of one order is written
 * by a single INSERT and shares a timestamp to the microsecond, so sorting by
 * time shuffles a fifty-item order into an arbitrary one. The results table is
 * the tenant's own list back in the order they sent it.
 */
export async function getOrderDetail(
  sql: Session,
  orderId: string,
): Promise<OrderDetail | null> {
  const order = await getOrderSummary(sql, orderId);
  if (!order) return null;
  const rows = await sql.query<ItemRow>(
    `SELECT j.id, j.idx, j.state, j.attempts, j.last_error,
            left(j.input, $2) AS input_preview,
            r.ok, r.output, r.failure_reason, r.errors,
            r.model, r.total_tokens, r.latency_ms
       FROM jobs j
       LEFT JOIN job_results r ON r.job_id = j.id
      WHERE j.order_id = $1
      ORDER BY j.idx`,
    [orderId, INPUT_PREVIEW_CHARS],
  );
  return { order, items: rows.map(toItem) };
}

type DeadRow = {
  id: string;
  order_id: string;
  idx: number | string;
  attempts: number | string;
  last_error: string | null;
  dead_at: Date | null;
  input_preview: string;
  workflow_slug: string;
  failure_trail: unknown;
};

/**
 * The dead-letter view: items that spent every attempt, newest first.
 *
 * The full failure trail travels with each row. Requeuing blind is the thing
 * the dead-letter exists to prevent — an item that failed three times for the
 * same reason will fail a fourth.
 */
export async function listDeadLetter(
  sql: Session,
  limit: number = DEFAULT_PAGE_SIZE,
): Promise<DeadItem[]> {
  const rows = await sql.query<DeadRow>(
    `SELECT j.id, j.order_id, j.idx, j.attempts, j.last_error, j.dead_at,
            left(j.input, $2) AS input_preview,
            j.failure_trail,
            w.slug AS workflow_slug
       FROM jobs j
       JOIN work_orders o ON o.id = j.order_id
       JOIN workflow_versions v ON v.id = o.workflow_version_id
       JOIN workflows w ON w.id = v.workflow_id
      WHERE j.state = 'dead'
      ORDER BY j.dead_at DESC NULLS LAST, j.id
      LIMIT $1`,
    [clampPageSize(limit), INPUT_PREVIEW_CHARS],
  );
  return rows.map((row) => ({
    jobId: row.id,
    orderId: row.order_id,
    idx: Number(row.idx),
    attempts: Number(row.attempts),
    lastError: row.last_error,
    deadAt: row.dead_at,
    inputPreview: row.input_preview,
    workflowSlug: row.workflow_slug,
    failureTrail: parseJson<unknown[]>(row.failure_trail, []),
  }));
}

type CardRow = {
  id: string;
  slug: string;
  name: string;
  current_version: number | string;
  version_id: string;
  model: string;
  prompt_template: string;
  output_schema: unknown;
};

/**
 * Active workflows with the version a submission would pin right now — one
 * query, because the submit form needs the model and the schema on first paint
 * and a card per workflow would otherwise be a round trip per row.
 */
export async function listWorkflowCards(sql: Session): Promise<WorkflowCard[]> {
  const rows = await sql.query<CardRow>(
    `SELECT w.id, w.slug, w.name, w.current_version,
            v.id AS version_id, v.model, v.prompt_template, v.output_schema
       FROM workflows w
       JOIN workflow_versions v
         ON v.workflow_id = w.id AND v.version = w.current_version
      WHERE w.state = 'active'
      ORDER BY w.slug`,
  );
  return rows.map((row) => ({
    workflowId: row.id,
    slug: row.slug,
    name: row.name,
    version: Number(row.current_version),
    versionId: row.version_id,
    model: row.model,
    promptTemplate: row.prompt_template,
    outputSchema: parseJson<Record<string, unknown>>(row.output_schema, {}),
  }));
}
