import type { Session } from '../db/engine.js';
import { assertSubmitAllowed } from '../metering/limits.js';

/**
 * Submitting a work order: one order row plus one job row per item, in a single
 * transaction, so an order never exists with a partial set of items. Items keep
 * their submitted position in `idx` — results are reported in the order the
 * tenant sent them, not the order they happened to finish in.
 *
 * Item and count caps are entitlement-enforced twice, and deliberately so. This
 * function asks first, so a caller gets a typed `EntitlementRefusedError` before
 * a single row is written; the BEFORE INSERT triggers in sql/006 refuse the same
 * rows at the database, so a limit is a property of the data and not of whoever
 * is in front of it. The model the pinned version names is checked here only —
 * refusing at submit is the only refusal a tenant can act on.
 *
 * An order pins the workflow version it was submitted against (SPEC.md feature
 * 2: every run pins its version). The order carries the pin, not each job:
 * every job in an order runs the same definition, and a requeued job re-runs
 * the version its order pinned rather than whatever the workflow has since
 * become. The pin was optional for exactly one phase; migration 005 makes the
 * column NOT NULL, so it is a required argument here and a database refusal if
 * it is somehow missed.
 */

export interface EnqueuedOrder {
  orderId: string;
  jobIds: string[];
}

export interface EnqueueOptions {
  /** The `workflow_versions.id` this order runs under. Required since 005. */
  workflowVersionId: string;
}

export async function enqueueOrder(
  sql: Session,
  tenantId: string,
  items: readonly string[],
  options: EnqueueOptions,
): Promise<EnqueuedOrder> {
  if (items.length === 0) throw new RangeError('a work order needs at least one item');
  if (!options.workflowVersionId) {
    throw new RangeError('a work order must pin the workflow version it runs under');
  }

  await assertSubmitAllowed(sql, items, options.workflowVersionId);

  const [order] = await sql.query<{ id: string }>(
    `INSERT INTO work_orders (tenant_id, item_count, workflow_version_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [tenantId, items.length, options.workflowVersionId],
  );
  if (!order) throw new Error('work order insert returned no row');

  // One statement for the whole batch: unnest turns the item array into rows,
  // and WITH ORDINALITY gives each its submitted position without a round trip
  // per item.
  const jobs = await sql.query<{ id: string }>(
    `INSERT INTO jobs (tenant_id, order_id, idx, input)
     SELECT $1, $2, item.ord - 1, item.value
       FROM unnest($3::text[]) WITH ORDINALITY AS item(value, ord)
     ORDER BY item.ord
     RETURNING id`,
    [tenantId, order.id, items as string[]],
  );

  return { orderId: order.id, jobIds: jobs.map((j) => j.id) };
}
