import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { enqueueOrder } from '../src/queue/enqueue.js';
import {
  clampPageSize,
  listDeadLetter,
  listOrders,
  listWorkflowCards,
  getOrderDetail,
  getOrderSummary,
} from '../src/dashboard/queries.js';
import { withAdmin, withTenant } from '../src/seam/withTenant.js';
import { freshDb, makeTenant } from './helpers/db.js';
import { seedExampleWorkflows } from '../src/workflows/examples.js';

/**
 * The dashboard read models: listOrders, getOrderSummary, getOrderDetail,
 * listDeadLetter, listWorkflowCards, and clampPageSize.  §H3 of
 * TASK_PHASE_H.md.
 *
 * No HTTP server — just a database, withTenant, and the read functions.
 */

let db: Awaited<ReturnType<typeof freshDb>>;
let tenantA: { id: string; slug: string };
let tenantB: { id: string; slug: string };
let aVersions: { workflowId: string; version: number; versionId: string }[];

beforeAll(async () => {
  db = await freshDb();
  tenantA = await makeTenant(db, 'dash-a');
  tenantB = await makeTenant(db, 'dash-b');

  // Seed workflows once — all tests share the same seeded data.
  const aSeed = await withTenant(db, tenantA.id, (sql) => seedExampleWorkflows(sql));
  const aRaw = await withTenant(db, tenantA.id, (sql) =>
    sql.query(
      `SELECT w.id AS workflow_id, v.id AS version_id, w.current_version AS version
         FROM workflows w
         JOIN workflow_versions v ON v.workflow_id = w.id AND v.version = w.current_version
        WHERE w.slug = ANY($1)`,
      [aSeed.map((s) => s.slug)],
    ) as Promise<{ workflow_id: string; version_id: string; version: number }[]>,
  );
  aVersions = aRaw.map((r) => ({
    workflowId: r.workflow_id,
    version: r.version,
    versionId: r.version_id,
  }));
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  // Clean orders between tests so each starts fresh.
  await withAdmin(db, (sql) =>
    sql.query('DELETE FROM work_orders WHERE tenant_id = $1', [tenantA.id]),
  );
  await withAdmin(db, (sql) =>
    sql.query('DELETE FROM work_orders WHERE tenant_id = $1', [tenantB.id]),
  );
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Submit an order with `count` items and return { orderId }. */
async function submit(
  tenantId: string,
  count: number,
  versionId: string,
): Promise<{ orderId: string }> {
  const result = await withTenant(db, tenantId, (sql) =>
    enqueueOrder(sql, tenantId, Array.from({ length: count }, (_, i) => `item ${i}`), {
      workflowVersionId: versionId,
    }),
  );
  return { orderId: result.orderId };
}

// ---------------------------------------------------------------------------
// 1. listOrders — newest first, with itemCount, workflowSlug, version, finished=0
// ---------------------------------------------------------------------------

describe('listOrders — newest first, enriched', () => {
  it('returns the tenant\'s orders with counts and finished=0 after submit', async () => {
    const { orderId } = await submit(tenantA.id, 3, aVersions[0]!.versionId);

    const orders = await withTenant(db, tenantA.id, (sql) => listOrders(sql));

    expect(orders).toHaveLength(1);
    const order = orders[0]!;
    expect(order.orderId).toBe(orderId);
    expect(order.itemCount).toBe(3);
    expect(order.workflowSlug).toBe('extract');
    expect(order.version).toBe(1);
    expect(order.finished).toBe(0);
    // Zero state must be present, not absent.
    expect(order.counts.pending).toBe(3);
    expect(order.counts.dead).toBe(0);
  });

  it('returns orders newest first across two orders', async () => {
    await submit(tenantA.id, 1, aVersions[0]!.versionId);
    const { orderId: second } = await submit(tenantA.id, 2, aVersions[0]!.versionId);

    const orders = await withTenant(db, tenantA.id, (sql) => listOrders(sql));

    expect(orders).toHaveLength(2);
    expect(orders[0]!.orderId).toBe(second);
  });
});

// ---------------------------------------------------------------------------
// 2. Zero state is present — counts.pending equals item count, counts.dead=0
// ---------------------------------------------------------------------------

describe('listOrders — zero state is present', () => {
  it('every count key exists on a fresh order', async () => {
    await submit(tenantA.id, 4, aVersions[0]!.versionId);

    const orders = await withTenant(db, tenantA.id, (sql) => listOrders(sql));
    const counts = orders[0]!.counts;

    expect(counts).toHaveProperty('pending');
    expect(counts).toHaveProperty('running');
    expect(counts).toHaveProperty('succeeded');
    expect(counts).toHaveProperty('failed');
    expect(counts).toHaveProperty('dead');
    expect(counts).toHaveProperty('cancelled');
    expect(counts.dead).toBe(0);
    expect(counts.pending).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// 3. getOrderSummary — null for another tenant's order
// ---------------------------------------------------------------------------

describe('getOrderSummary — tenant isolation', () => {
  it('returns null when looked up under the other tenant', async () => {
    const { orderId } = await submit(tenantA.id, 2, aVersions[0]!.versionId);

    // Under tenant A — found.
    const mine = await withTenant(db, tenantA.id, (sql) => getOrderSummary(sql, orderId));
    expect(mine).not.toBeNull();
    expect(mine!.orderId).toBe(orderId);

    // Under tenant B — null, same as a non-existent id.
    const other = await withTenant(db, tenantB.id, (sql) => getOrderSummary(sql, orderId));
    expect(other).toBeNull();

    const nonexistent = await withTenant(db, tenantB.id, (sql) =>
      getOrderSummary(sql, '00000000-0000-0000-0000-000000000000'),
    );
    expect(nonexistent).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. getOrderDetail — items in idx order, inputPreview, output=null
// ---------------------------------------------------------------------------

describe('getOrderDetail — items in idx order', () => {
  it('returns items ordered 0,1,2 with inputPreview and output null', async () => {
    const { orderId } = await submit(tenantA.id, 3, aVersions[0]!.versionId);

    const detail = await withTenant(db, tenantA.id, (sql) => getOrderDetail(sql, orderId));

    expect(detail).not.toBeNull();
    expect(detail!.items).toHaveLength(3);
    expect(detail!.items[0]!.idx).toBe(0);
    expect(detail!.items[1]!.idx).toBe(1);
    expect(detail!.items[2]!.idx).toBe(2);
    expect(detail!.items[0]!.inputPreview).toBe('item 0');
    expect(detail!.items[0]!.output).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. listDeadLetter — empty until dead, then returns with trail fields
// ---------------------------------------------------------------------------

describe('listDeadLetter', () => {
  it('is empty until a job is stamped dead', async () => {
    const empty = await withTenant(db, tenantA.id, (sql) => listDeadLetter(sql));
    expect(empty).toEqual([]);
  });

  it('returns a dead item with attempts, lastError, workflowSlug, failureTrail', async () => {
    // Submit one item so we have a job to stamp dead.
    const { orderId } = await submit(tenantA.id, 1, aVersions[0]!.versionId);

    // Stamp the job dead using withAdmin.
    const jobId = await withTenant(db, tenantA.id, (sql) =>
      sql.query(
        'SELECT id FROM jobs WHERE order_id = $1',
        [orderId],
      ) as Promise<{ id: string }[]>,
    );
    const jobUuid = jobId[0]!.id;

    await withAdmin(db, (sql) =>
      sql.query(
        `UPDATE jobs SET state = 'dead', dead_at = now(), attempts = 3,
         last_error = 'retried three times',
         failure_trail = '[\"boom\", \"crash\", \"dead\"]'::jsonb
         WHERE id = $1`,
        [jobUuid],
      ),
    );

    const dead = await withTenant(db, tenantA.id, (sql) => listDeadLetter(sql));

    expect(dead).toHaveLength(1);
    expect(dead[0]!.jobId).toBe(jobUuid);
    expect(dead[0]!.orderId).toBe(orderId);
    expect(dead[0]!.attempts).toBe(3);
    expect(dead[0]!.lastError).toBe('retried three times');
    expect(dead[0]!.workflowSlug).toBe('extract');
    expect(Array.isArray(dead[0]!.failureTrail)).toBe(true);
    expect(dead[0]!.failureTrail).toEqual(['boom', 'crash', 'dead']);
  });
});

// ---------------------------------------------------------------------------
// 6. listWorkflowCards — returns the seeded examples
// ---------------------------------------------------------------------------

describe('listWorkflowCards', () => {
  it('returns the three seeded workflows for the tenant', async () => {
    const cards = await withTenant(db, tenantA.id, (sql) => listWorkflowCards(sql));

    expect(cards).toHaveLength(3);
    const slugs = cards.map((c) => c.slug).sort();
    expect(slugs).toEqual(['classify', 'extract', 'summarize']);
  });
});

// ---------------------------------------------------------------------------
// 7. clampPageSize — pure function
// ---------------------------------------------------------------------------

describe('clampPageSize — pure', () => {
  it('rejects non-numeric strings and zero, returning the fallback 25', () => {
    expect(clampPageSize('abc')).toBe(25);
    expect(clampPageSize(0)).toBe(25);
    expect(clampPageSize(null as unknown as string)).toBe(25);
    expect(clampPageSize(undefined as unknown as string)).toBe(25);
  });

  it('caps at 100 for oversized values', () => {
    expect(clampPageSize(1000)).toBe(100);
    expect(clampPageSize(9999)).toBe(100);
  });

  it('parses numeric strings and honors valid values', () => {
    expect(clampPageSize('7')).toBe(7);
    expect(clampPageSize('50')).toBe(50);
    expect(clampPageSize(25)).toBe(25);
  });
});
