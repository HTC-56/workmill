import type { Engine, Session } from '../db/engine.js';
import { withAdmin } from '../seam/withTenant.js';
import type { TenantEntitlements } from '../tenancy/entitlements.js';

/**
 * The operator console's tenant table and its two edits (SPEC.md feature 7:
 * "tenant table with state + entitlements … entitlement edits").
 *
 * This module is split along the one line that matters. `listTenantRows` is
 * CROSS-TENANT by definition — a table with one row per tenant is the whole
 * point of an operator console — so it runs under `withAdmin` and is served
 * only behind the operator bearer. The two writes are not: an entitlement edit
 * and a state change belong to ONE tenant, so they take a `Session` and run
 * under `withTenant()` with that tenant pinned. The policy's WITH CHECK half is
 * then what decides the row can be touched, and the route cannot edit a second
 * tenant by accident even if it computed the wrong id.
 *
 * The counts on each row are the ones an operator triages with: how much work
 * is queued, how much is dead, what was spent today, is support looking. They
 * are deliberately aggregates — this table never carries item text, and no
 * amount of scrolling it reveals what any tenant's work says.
 */

export type TenantState = 'active' | 'suspended';

/** The states sql/001's CHECK allows. */
export const TENANT_STATES: readonly TenantState[] = ['active', 'suspended'];

/** One row of the operator's tenant table. */
export interface TenantRow {
  tenantId: string;
  slug: string;
  name: string;
  state: TenantState;
  createdAt: Date;
  /** Null for a tenant with no entitlements row — the fail-open seam, visible. */
  limits: TenantEntitlements | null;
  users: number;
  workflows: number;
  openOrders: number;
  pendingJobs: number;
  runningJobs: number;
  deadJobs: number;
  tokensToday: number;
  /** True while an unrevoked, unexpired support grant exists. */
  supportActive: boolean;
}

type TenantRowShape = {
  id: string;
  slug: string;
  name: string;
  state: string;
  created_at: Date;
  daily_token_budget: string | number | null;
  max_concurrent_jobs: number | null;
  max_items_per_order: number | null;
  max_item_chars: number | null;
  allowed_models: string[] | null;
  users: string | number;
  workflows: string | number;
  open_orders: string | number;
  pending_jobs: string | number;
  running_jobs: string | number;
  dead_jobs: string | number;
  tokens_today: string | number;
  support_active: boolean;
};

/**
 * Every tenant, newest first, with the numbers the console shows.
 *
 * Scalar subqueries rather than a pile of LEFT JOINs and a GROUP BY: joining
 * jobs and orders and users in one statement multiplies the rows and every
 * count then needs a DISTINCT to be right. A single-box console reading a
 * handful of tenants can afford the subqueries, and a query a reader can check
 * by eye is worth more here than a saved sequential scan.
 */
export async function listTenantRows(engine: Engine): Promise<TenantRow[]> {
  return withAdmin(engine, async (sql) => {
    const rows = await sql.query<TenantRowShape>(
      `SELECT t.id, t.slug, t.name, t.state, t.created_at,
              e.daily_token_budget, e.max_concurrent_jobs, e.max_items_per_order,
              e.max_item_chars, e.allowed_models,
              (SELECT count(*) FROM users u WHERE u.tenant_id = t.id) AS users,
              (SELECT count(*) FROM workflows w
                WHERE w.tenant_id = t.id AND w.state = 'active') AS workflows,
              (SELECT count(*) FROM work_orders o
                WHERE o.tenant_id = t.id AND o.state = 'open') AS open_orders,
              (SELECT count(*) FROM jobs j
                WHERE j.tenant_id = t.id AND j.state = 'pending') AS pending_jobs,
              (SELECT count(*) FROM jobs j
                WHERE j.tenant_id = t.id AND j.state = 'running') AS running_jobs,
              (SELECT count(*) FROM jobs j
                WHERE j.tenant_id = t.id AND j.state = 'dead') AS dead_jobs,
              COALESCE((SELECT sum(l.total_tokens) FROM token_ledger l
                         WHERE l.tenant_id = t.id
                           AND l.usage_day = ((now() AT TIME ZONE 'UTC')::date)), 0) AS tokens_today,
              EXISTS (SELECT 1 FROM support_grants g
                       WHERE g.tenant_id = t.id
                         AND g.revoked_at IS NULL
                         AND g.expires_at > now()) AS support_active
         FROM tenants t
         LEFT JOIN entitlements e ON e.tenant_id = t.id
        ORDER BY t.created_at DESC, t.id`,
    );
    return rows.map((row) => ({
      tenantId: row.id,
      slug: row.slug,
      name: row.name,
      state: row.state as TenantState,
      createdAt: new Date(row.created_at),
      limits:
        row.daily_token_budget === null
          ? null
          : {
              dailyTokenBudget: Number(row.daily_token_budget),
              maxConcurrentJobs: Number(row.max_concurrent_jobs),
              maxItemsPerOrder: Number(row.max_items_per_order),
              maxItemChars: Number(row.max_item_chars),
              allowedModels: row.allowed_models ?? [],
            },
      users: Number(row.users),
      workflows: Number(row.workflows),
      openOrders: Number(row.open_orders),
      pendingJobs: Number(row.pending_jobs),
      runningJobs: Number(row.running_jobs),
      deadJobs: Number(row.dead_jobs),
      tokensToday: Number(row.tokens_today),
      supportActive: row.support_active === true,
    }));
  });
}

/** Does this tenant exist? Asked before pinning one, so an unknown id is a 404. */
export async function tenantExists(engine: Engine, tenantId: string): Promise<boolean> {
  const rows = await withAdmin(engine, (sql) =>
    sql.query<{ id: string }>('SELECT id FROM tenants WHERE id = $1', [tenantId]),
  );
  return rows.length > 0;
}

/** A value the entitlement CHECKs in sql/003 would refuse. Thrown before the write. */
export class EntitlementValueError extends RangeError {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'EntitlementValueError';
  }
}

/** The subset of limits an operator may change. Absent fields are left alone. */
export interface EntitlementPatch {
  dailyTokenBudget?: number;
  maxConcurrentJobs?: number;
  maxItemsPerOrder?: number;
  maxItemChars?: number;
  allowedModels?: readonly string[];
}

/** Bounds mirrored from sql/003's CHECK constraints, refused here with a field name. */
const BOUNDS: Record<string, { column: string; min: number; max: number }> = {
  dailyTokenBudget: { column: 'daily_token_budget', min: 0, max: 1_000_000_000 },
  maxConcurrentJobs: { column: 'max_concurrent_jobs', min: 1, max: 1000 },
  maxItemsPerOrder: { column: 'max_items_per_order', min: 1, max: 100_000 },
  maxItemChars: { column: 'max_item_chars', min: 1, max: 1_000_000 },
};

/**
 * Change some of the current tenant's limits.
 *
 * Returns null when the tenant has no entitlements row — the fail-open seam
 * sql/006 names. An operator editing limits on a tenant that has none should be
 * told so rather than have a row invented underneath them, because the numbers
 * a provision would have chosen are not the numbers they were typing.
 *
 * The bounds are checked here AND by the CHECK constraints underneath. That is
 * the same doubling `assertSubmitAllowed` uses: the typed error names the field
 * for a form, and the constraint is what makes the limit a property of the data.
 */
export async function updateEntitlements(
  sql: Session,
  patch: EntitlementPatch,
): Promise<TenantEntitlements | null> {
  const sets: string[] = [];
  const params: unknown[] = [];

  for (const [field, bound] of Object.entries(BOUNDS)) {
    const value = patch[field as keyof EntitlementPatch];
    if (value === undefined) continue;
    const n = Number(value);
    if (!Number.isInteger(n) || n < bound.min || n > bound.max) {
      throw new EntitlementValueError(
        field,
        `${field} must be a whole number in ${bound.min}..${bound.max}, got ${String(value)}`,
      );
    }
    params.push(n);
    sets.push(`${bound.column} = $${params.length}`);
  }

  if (patch.allowedModels !== undefined) {
    const models = [...patch.allowedModels];
    if (models.length < 1 || !models.every((m) => typeof m === 'string' && m.trim().length > 0)) {
      throw new EntitlementValueError(
        'allowedModels',
        'allowedModels must be a non-empty array of non-empty model names',
      );
    }
    params.push(models);
    sets.push(`allowed_models = $${params.length}`);
  }

  if (sets.length === 0) throw new EntitlementValueError('patch', 'no entitlement fields to update');

  // No WHERE clause: RLS scopes this to the pinned tenant's single row, the way
  // `getEntitlements` reads it. A tenant_id in the SQL here would be a second,
  // weaker copy of the isolation rule.
  const [row] = await sql.query<{
    daily_token_budget: string | number;
    max_concurrent_jobs: number;
    max_items_per_order: number;
    max_item_chars: number;
    allowed_models: string[];
  }>(
    `UPDATE entitlements SET ${sets.join(', ')}, updated_at = now()
      RETURNING daily_token_budget, max_concurrent_jobs, max_items_per_order,
                max_item_chars, allowed_models`,
    params,
  );
  if (!row) return null;
  return {
    dailyTokenBudget: Number(row.daily_token_budget),
    maxConcurrentJobs: Number(row.max_concurrent_jobs),
    maxItemsPerOrder: Number(row.max_items_per_order),
    maxItemChars: Number(row.max_item_chars),
    allowedModels: row.allowed_models,
  };
}

/**
 * Suspend or resume the current tenant. False when nothing changed.
 *
 * Suspension is a label in v1, not a kill switch: it does not stop a claim and
 * does not revoke a token. Wiring it into the claim query is a real decision
 * about in-flight work that this phase has no mandate to make, so it is a
 * reservation rather than a half-built enforcement.
 */
export async function setTenantState(sql: Session, state: TenantState): Promise<boolean> {
  if (!TENANT_STATES.includes(state)) {
    throw new RangeError(`tenant state must be one of ${TENANT_STATES.join(', ')}, got ${state}`);
  }
  const rows = await sql.query<{ id: string }>(
    'UPDATE tenants SET state = $1 WHERE state <> $1 RETURNING id',
    [state],
  );
  return rows.length > 0;
}
