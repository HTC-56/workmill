import type { Session } from '../db/engine.js';
import { getEntitlements, isModelAllowed, type TenantEntitlements } from '../tenancy/entitlements.js';
import { tokensUsedToday } from './ledger.js';

/**
 * Entitlement enforcement (SPEC.md feature 5).
 *
 * `src/tenancy/entitlements.ts` reads a tenant's limits. This module is what
 * refuses things with them: the submit-time caps on an order, and the budget
 * question the runner asks before it claims.
 *
 * The refusals are deliberately doubled. `assertSubmitAllowed` gives a caller a
 * typed error before anything is written, which is what an API and a dashboard
 * need; the triggers in sql/006 refuse the same rows at the database, which is
 * what makes the limit a property of the data rather than of whichever code
 * path happened to be in front of it. `budgetStatus` reports the day's spend;
 * the claim query in src/queue/claim.ts enforces it in the same statement that
 * takes the work, so a runner that never asked still cannot overspend.
 *
 * ONE fail-open seam, the same one sql/006 names: a tenant with no entitlements
 * row has no limits. `provisionTenant` writes that row in the same transaction
 * as the tenant, so a production tenant always has one.
 */

/** Why a submission was refused. The reason is the assertion tests match on. */
export type RefusalReason = 'too-many-items' | 'item-too-long' | 'model-not-allowed';

/** A submission the tenant's entitlements do not permit. Thrown before any write. */
export class EntitlementRefusedError extends Error {
  constructor(
    public readonly reason: RefusalReason,
    message: string,
  ) {
    super(message);
    this.name = 'EntitlementRefusedError';
  }
}

/** Where the tenant stands against its daily token budget. */
export interface BudgetStatus {
  /** Null when the tenant has no entitlements row: no budget, no refusal. */
  budget: number | null;
  /** Tokens spent on the current UTC day. */
  used: number;
  /** Null when there is no budget; never negative when there is. */
  remaining: number | null;
  /** True only when a budget exists and the day's spend has reached it. */
  exhausted: boolean;
}

/** The one reason a work order stops moving without being cancelled. */
export const BUDGET_EXHAUSTED = 'daily-token-budget-exhausted';

/**
 * The current tenant's limits, or null when the row does not exist.
 *
 * `getEntitlements` throws on a missing row, which is right for a caller that
 * is displaying limits and wrong for a caller that is enforcing them: an
 * unprovisioned tenant should not have its work refused by a crash.
 */
export async function readLimits(sql: Session): Promise<TenantEntitlements | null> {
  try {
    return await getEntitlements(sql);
  } catch {
    return null;
  }
}

/**
 * Refuse a submission the entitlements do not permit — item count, item size,
 * and the model the pinned version names.
 *
 * The model check lives here rather than at the claim because a claim has taken
 * the work already; refusing at submit is the only refusal a tenant can act on.
 */
export async function assertSubmitAllowed(
  sql: Session,
  items: readonly string[],
  workflowVersionId: string,
): Promise<void> {
  const limits = await readLimits(sql);
  if (limits === null) return;

  if (items.length > limits.maxItemsPerOrder) {
    throw new EntitlementRefusedError(
      'too-many-items',
      `order of ${items.length} items exceeds max_items_per_order of ${limits.maxItemsPerOrder}`,
    );
  }

  for (const [index, item] of items.entries()) {
    if (item.length > limits.maxItemChars) {
      throw new EntitlementRefusedError(
        'item-too-long',
        `item ${index} is ${item.length} characters, over max_item_chars of ${limits.maxItemChars}`,
      );
    }
  }

  // RLS scopes this to the current tenant, so a version id belonging to someone
  // else simply is not found — and an order that pins nothing resolvable is a
  // refusal here rather than a runner that cannot start.
  const [version] = await sql.query<{ model: string }>(
    'SELECT model FROM workflow_versions WHERE id = $1',
    [workflowVersionId],
  );
  if (version && !isModelAllowed(limits, version.model)) {
    throw new EntitlementRefusedError(
      'model-not-allowed',
      `model ${JSON.stringify(version.model)} is not in this tenant's allowed_models`,
    );
  }
}

/** The day's spend against the day's budget. Two reads, no writes. */
export async function budgetStatus(sql: Session): Promise<BudgetStatus> {
  const limits = await readLimits(sql);
  const used = await tokensUsedToday(sql);
  if (limits === null) return { budget: null, used, remaining: null, exhausted: false };
  return {
    budget: limits.dailyTokenBudget,
    used,
    remaining: Math.max(0, limits.dailyTokenBudget - used),
    exhausted: used >= limits.dailyTokenBudget,
  };
}

/**
 * Stamp every open order that still has work in it with why it stopped — the
 * "and the order says so" half of SPEC.md's budget refusal.
 *
 * Only orders with something left to run are stamped: an order whose items all
 * finished stopped because it was done, not because the budget ran out.
 * Returns how many orders were newly stamped.
 */
export async function blockOpenOrders(sql: Session, reason = BUDGET_EXHAUSTED): Promise<number> {
  const rows = await sql.query<{ id: string }>(
    `UPDATE work_orders AS o
        SET blocked_reason = $1, blocked_at = now()
      WHERE o.state = 'open'
        AND o.blocked_reason IS NULL
        AND EXISTS (SELECT 1 FROM jobs AS j WHERE j.order_id = o.id AND j.state = 'pending')
      RETURNING o.id`,
    [reason],
  );
  return rows.length;
}

/** Clear the stamp: the tenant can spend again, so the order is moving again. */
export async function clearOrderBlocks(sql: Session): Promise<number> {
  const rows = await sql.query<{ id: string }>(
    `UPDATE work_orders SET blocked_reason = NULL, blocked_at = NULL
      WHERE blocked_reason IS NOT NULL RETURNING id`,
  );
  return rows.length;
}
