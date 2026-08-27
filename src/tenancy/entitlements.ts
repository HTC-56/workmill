import type { Session } from '../db/engine.js';

/**
 * Reading a tenant's entitlements — limits stored at provisioning time.
 *
 * This is the read side only: it surfaces what the operator set for the tenant
 * but does not enforce anything. Enforcement (rejecting claims when the budget
 * is spent, capping order size) belongs to the metering phase.
 *
 * `getEntitlements` runs a single SELECT with no WHERE clause. That is
 * deliberate: the `entitlements` table has a RLS policy scoped to
 * `app_tenant_id()`, so the application role can only ever see the one row
 * belonging to the current tenant. One row, zero rows, or an error — that is
 * the full set of outcomes.
 */

export interface TenantEntitlements {
  dailyTokenBudget: number;
  maxConcurrentJobs: number;
  maxItemsPerOrder: number;
  maxItemChars: number;
  allowedModels: string[];
}

export class MissingEntitlementsError extends Error {
  constructor() {
    super('tenant has no entitlements row — was it provisioned?');
    this.name = 'MissingEntitlementsError';
  }
}

/**
 * Returns the current tenant's limits. RLS guarantees this can only see the
 * right row — no WHERE clause needed.
 */
export async function getEntitlements(
  sql: Session,
): Promise<TenantEntitlements> {
  const [row] = await sql.query<Record<string, string | string[]>>(
    `SELECT daily_token_budget,
            max_concurrent_jobs,
            max_items_per_order,
            max_item_chars,
            allowed_models
       FROM entitlements`,
  );

  if (!row) throw new MissingEntitlementsError();

  return {
    dailyTokenBudget: Number(row['daily_token_budget']),
    maxConcurrentJobs: Number(row['max_concurrent_jobs']),
    maxItemsPerOrder: Number(row['max_items_per_order']),
    maxItemChars: Number(row['max_item_chars']),
    allowedModels: row['allowed_models'] as string[],
  };
}

/**
 * Whether a model name is in the tenant's allow-list.
 *
 * Pure function — no database access. The list lives on the entitlements row
 * because the operator sets it at provisioning time; this helper just checks
 * membership.
 */
export function isModelAllowed(
  entitlements: TenantEntitlements,
  model: string,
): boolean {
  return entitlements.allowedModels.includes(model);
}
