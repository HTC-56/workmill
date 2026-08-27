import type { Session } from '../db/engine.js';

/**
 * Submitting a work order: one order row plus one job row per item, in a single
 * transaction, so an order never exists with a partial set of items. Items keep
 * their submitted position in `idx` — results are reported in the order the
 * tenant sent them, not the order they happened to finish in.
 *
 * Item and count caps are entitlement-enforced at the data layer in a later
 * phase; this function is the row-writing half only.
 */

export interface EnqueuedOrder {
  orderId: string;
  jobIds: string[];
}

export async function enqueueOrder(
  sql: Session,
  tenantId: string,
  items: readonly string[],
): Promise<EnqueuedOrder> {
  if (items.length === 0) throw new RangeError('a work order needs at least one item');

  const [order] = await sql.query<{ id: string }>(
    `INSERT INTO work_orders (tenant_id, item_count) VALUES ($1, $2) RETURNING id`,
    [tenantId, items.length],
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
