import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Engine } from '../src/db/engine.js';
import { withAdmin, withTenant } from '../src/seam/withTenant.js';
import { randomUUID } from 'node:crypto';
import { freshDb, makeTenant, type TestTenant } from './helpers/db.js';
import { provisionTenant } from '../src/tenancy/provision.js';
import {
  readLimits,
  assertSubmitAllowed,
  budgetStatus,
  blockOpenOrders,
  clearOrderBlocks,
  BUDGET_EXHAUSTED,
  EntitlementRefusedError,
} from '../src/metering/limits.js';
import { recordUsage } from '../src/metering/ledger.js';
import { enqueueOrder } from '../src/queue/enqueue.js';

/**
 * Proves `readLimits` and `assertSubmitAllowed` from
 * `src/metering/limits.ts`, reached directly and through `enqueueOrder`.
 *
 * §F6 of TASK_PHASE_F.md.
 *
 * Patterned after test/tenancy.test.ts: same `beforeAll` / `afterAll` shape
 * and per-test isolation via `beforeEach` cleanup.
 */

let db: Engine;

/** Tenant provisioned with tight entitlements so caps are easy to cross. */
let tenant: { id: string; slug: string; tenantId: string; entitlementsId: string };
/** Tenant created by `makeTenant` only — no entitlements row. */
let bareTenant: TestTenant;
/** A workflow version whose model is allowed (the provisioned tenant's default). */
let versionId: string;

/** Tenant provisioned with a tight dailyTokenBudget for budget tests. */
let budgetTenant: { id: string; tenantId: string };
/** Workflow version under the budget tenant. */
let budgetVersionId: string;

beforeAll(async () => {
  db = await freshDb();

  // Provision with very tight limits so the caps are easy to cross.
  const prov = await provisionTenant(db, {
    slug: 'limits-tight',
    name: 'Limits Tight',
    ownerEmail: 'admin@limitstight.example',
    entitlements: {
      maxItemsPerOrder: 3,
      maxItemChars: 10,
    },
  });
  tenant = { id: prov.tenantId, slug: 'limits-tight', tenantId: prov.tenantId, entitlementsId: prov.entitlementsId };

  // Bare tenant — only a row in `tenants`, no entitlements.
  bareTenant = await makeTenant(db, 'limits-bare');

  // Workflow version fixture for the model check.
  versionId = await withAdmin(db, async (sql) => {
    const [workflow] = await sql.query<{ id: string }>(
      "INSERT INTO workflows (tenant_id, slug, name) VALUES ($1, 'limits-fixture', 'Limits fixture') RETURNING id",
      [tenant.id],
    );
    const [version] = await sql.query<{ id: string }>(
      `INSERT INTO workflow_versions
         (tenant_id, workflow_id, version, prompt_template, output_schema, model)
       VALUES ($1, $2, 1, 'Do this: {{input}}', '{"type":"object"}'::jsonb, 'default')
       RETURNING id`,
      [tenant.id, workflow!.id],
    );
    return version!.id;
  });

  // Budget tenant — tight dailyTokenBudget so recordUsage can exhaust it.
  const budgetProv = await provisionTenant(db, {
    slug: 'limits-budget',
    name: 'Limits Budget',
    ownerEmail: 'admin@limitsbudget.example',
    entitlements: {
      dailyTokenBudget: 100,
    },
  });
  budgetTenant = { id: budgetProv.tenantId, tenantId: budgetProv.tenantId };

  budgetVersionId = await withAdmin(db, async (sql) => {
    const [workflow] = await sql.query<{ id: string }>(
      "INSERT INTO workflows (tenant_id, slug, name) VALUES ($1, 'budget-fixture', 'Budget fixture') RETURNING id",
      [budgetTenant.id],
    );
    const [version] = await sql.query<{ id: string }>(
      `INSERT INTO workflow_versions
         (tenant_id, workflow_id, version, prompt_template, output_schema, model)
       VALUES ($1, $2, 1, 'Do this: {{input}}', '{"type":"object"}'::jsonb, 'default')
       RETURNING id`,
      [budgetTenant.id, workflow!.id],
    );
    return version!.id;
  });
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  // Clear work_orders and jobs for both tenants so each test starts fresh.
  for (const tid of [tenant.id, budgetTenant.id, bareTenant.id]) {
    await withAdmin(db, (sql) =>
      sql.query('DELETE FROM work_orders WHERE tenant_id = $1', [tid]),
    );
    await withAdmin(db, (sql) =>
      sql.query('DELETE FROM jobs WHERE tenant_id = $1', [tid]),
    );
  }
});

// ---------------------------------------------------------------------------
// 1. readLimits — provisioned vs bare
// ---------------------------------------------------------------------------

describe('readLimits — provisioned tenant returns limits', () => {
  it('returns the provisioned numbers for a provisioned tenant', async () => {
    const limits = await withTenant(db, tenant.id, (sql) => readLimits(sql));

    expect(limits).not.toBeNull();
    expect(limits!.maxItemsPerOrder).toBe(3);
    expect(limits!.maxItemChars).toBe(10);
  });
});

describe('readLimits — bare tenant returns null', () => {
  it('returns null for a tenant made with makeTenant (no entitlements row)', async () => {
    const limits = await withTenant(db, bareTenant.id, (sql) => readLimits(sql));

    expect(limits).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. enqueueOrder — too many items
// ---------------------------------------------------------------------------

describe('enqueueOrder — too many items', () => {
  it('rejects with EntitlementRefusedError and reason too-many-items', async () => {
    // 4 items > maxItemsPerOrder of 3.
    await expect(
      withTenant(db, tenant.id, (sql) =>
        enqueueOrder(sql, tenant.id, ['a', 'b', 'c', 'd'], {
          workflowVersionId: versionId,
        }),
      ),
    ).rejects.toThrow(EntitlementRefusedError);

    try {
      await withTenant(db, tenant.id, (sql) =>
        enqueueOrder(sql, tenant.id, ['a', 'b', 'c', 'd'], {
          workflowVersionId: versionId,
        }),
      );
      // Should never reach here.
      expect.fail('enqueueOrder should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EntitlementRefusedError);
      expect((err as EntitlementRefusedError).reason).toBe('too-many-items');
    }
  });
});

// ---------------------------------------------------------------------------
// 3. enqueueOrder — item too long
// ---------------------------------------------------------------------------

describe('enqueueOrder — item too long', () => {
  it('rejects with EntitlementRefusedError and reason item-too-long', async () => {
    // One item is 11 characters > maxItemChars of 10.
    await expect(
      withTenant(db, tenant.id, (sql) =>
        enqueueOrder(sql, tenant.id, ['short', 'this-is-too-long'], {
          workflowVersionId: versionId,
        }),
      ),
    ).rejects.toThrow(EntitlementRefusedError);

    try {
      await withTenant(db, tenant.id, (sql) =>
        enqueueOrder(sql, tenant.id, ['short', 'this-is-too-long'], {
          workflowVersionId: versionId,
        }),
      );
      expect.fail('enqueueOrder should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EntitlementRefusedError);
      expect((err as EntitlementRefusedError).reason).toBe('item-too-long');
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Refusal happens before anything is written
// ---------------------------------------------------------------------------

describe('enqueueOrder — refusal is early, no side effects', () => {
  it('no work_orders row exists after a too-many-items refusal', async () => {
    // Refuse first.
    try {
      await withTenant(db, tenant.id, (sql) =>
        enqueueOrder(sql, tenant.id, ['a', 'b', 'c', 'd'], {
          workflowVersionId: versionId,
        }),
      );
    } catch {
      // Expected.
    }

    // Count orders under the tenant's RLS scope — should still be zero.
    const [count] = await withTenant(db, tenant.id, (sql) =>
      sql.query<{ n: number }>(
        'SELECT count(*) AS n FROM work_orders',
        [],
      ),
    );

    expect(count!.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. assertSubmitAllowed — model not allowed
// ---------------------------------------------------------------------------

describe('assertSubmitAllowed — model not allowed', () => {
  it('rejects with reason model-not-allowed for a forbidden model', async () => {
    // Create a second version under admin with a model not in allowedModels.
    const forbiddenVersionId = await withAdmin(db, async (sql) => {
      const [workflow] = await sql.query<{ id: string }>(
        "INSERT INTO workflows (tenant_id, slug, name) VALUES ($1, 'limits-forbidden', 'Forbidden model fixture') RETURNING id",
        [tenant.id],
      );
      const [version] = await sql.query<{ id: string }>(
        `INSERT INTO workflow_versions
           (tenant_id, workflow_id, version, prompt_template, output_schema, model)
         VALUES ($1, $2, 2, 'Do this: {{input}}', '{"type":"object"}'::jsonb, 'forbidden')
         RETURNING id`,
        [tenant.id, workflow!.id],
      );
      return version!.id;
    });

    try {
      await withTenant(db, tenant.id, (sql) =>
        assertSubmitAllowed(sql, ['ok'], forbiddenVersionId),
      );
      expect.fail('assertSubmitAllowed should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EntitlementRefusedError);
      expect((err as EntitlementRefusedError).reason).toBe('model-not-allowed');
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Inside every limit — success
// ---------------------------------------------------------------------------

describe('enqueueOrder — inside every limit succeeds', () => {
  it('returns job ids equal to the number of items', async () => {
    const result = await withTenant(db, tenant.id, (sql) =>
      enqueueOrder(sql, tenant.id, ['a', 'b'], {
        workflowVersionId: versionId,
      }),
    );

    expect(result.jobIds).toHaveLength(2);
    expect(result.orderId).toBeDefined();
    expect(result.orderId.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 7. Trigger: oversized item rejected on direct INSERT (§F7)
// ---------------------------------------------------------------------------

describe('Triggers — oversized item rejected on direct INSERT (§F7)', () => {
  it('rejects a jobs INSERT whose input exceeds max_item_chars, naming max_item_chars', async () => {
    // Create a work_order first (the FK requires it).
    const orderId = randomUUID();
    await withAdmin(db, (sql) =>
      sql.query(
        'INSERT INTO work_orders (id, tenant_id, item_count, workflow_version_id) VALUES ($1, $2, 1, $3)',
        [orderId, tenant.id, versionId],
      ),
    );

    // input is 11 chars > maxItemChars of 10.
    const jobId = randomUUID();
    await expect(
      withAdmin(db, (sql) =>
        sql.query(
          'INSERT INTO jobs (id, tenant_id, order_id, idx, input) VALUES ($1, $2, $3, 0, $4)',
          [jobId, tenant.id, orderId, 'this-is-too-long'],
        ),
      ),
    ).rejects.toThrow('max_item_chars');
  });

  it('rejects the same oversized insert under withTenant too', async () => {
    const orderId = randomUUID();
    await withAdmin(db, (sql) =>
      sql.query(
        'INSERT INTO work_orders (id, tenant_id, item_count, workflow_version_id) VALUES ($1, $2, 1, $3)',
        [orderId, tenant.id, versionId],
      ),
    );

    const jobId = randomUUID();
    await expect(
      withTenant(db, tenant.id, (sql) =>
        sql.query(
          'INSERT INTO jobs (id, tenant_id, order_id, idx, input) VALUES ($1, $2, $3, 0, $4)',
          [jobId, tenant.id, orderId, 'this-is-too-long'],
        ),
      ),
    ).rejects.toThrow('max_item_chars');
  });
});

// ---------------------------------------------------------------------------
// 8. Trigger: oversized order rejected on direct INSERT (§F7)
// ---------------------------------------------------------------------------

describe('Triggers — oversized order rejected on direct INSERT (§F7)', () => {
  it('rejects a work_orders INSERT whose item_count exceeds max_items_per_order, naming max_items_per_order', async () => {
    // maxItemsPerOrder is 3, so 4 exceeds it.
    const orderId = randomUUID();
    await expect(
      withAdmin(db, (sql) =>
        sql.query(
          'INSERT INTO work_orders (id, tenant_id, item_count, workflow_version_id) VALUES ($1, $2, 4, $3)',
          [orderId, tenant.id, versionId],
        ),
      ),
    ).rejects.toThrow('max_items_per_order');
  });
});

// ---------------------------------------------------------------------------
// 9. Inside both caps — INSERT succeeds (§F7)
// ---------------------------------------------------------------------------

describe('Triggers — inside both caps succeeds (§F7)', () => {
  it('inserts a work_orders row and a jobs row when both are within limits', async () => {
    const orderId = randomUUID();
    const jobId = randomUUID();

    // item_count=1 <= maxItemsPerOrder(3) and input 3 chars <= maxItemChars(10).
    await withAdmin(db, (sql) =>
      sql.query(
        'INSERT INTO work_orders (id, tenant_id, item_count, workflow_version_id) VALUES ($1, $2, 1, $3)',
        [orderId, tenant.id, versionId],
      ),
    );

    await withAdmin(db, (sql) =>
      sql.query(
        'INSERT INTO jobs (id, tenant_id, order_id, idx, input) VALUES ($1, $2, $3, 0, $4)',
        [jobId, tenant.id, orderId, 'ok'],
      ),
    );

    // Verify both rows exist.
    const [orderCount] = await withAdmin(db, (sql) =>
      sql.query<{ n: number }>('SELECT count(*) AS n FROM work_orders WHERE id = $1', [orderId]),
    );
    const [jobCount] = await withAdmin(db, (sql) =>
      sql.query<{ n: number }>('SELECT count(*) AS n FROM jobs WHERE id = $1', [jobId]),
    );

    expect(orderCount!.n).toBe(1);
    expect(jobCount!.n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 10. Bare tenant (no entitlements) — oversized insert succeeds (§F7)
// ---------------------------------------------------------------------------

describe('Triggers — bare tenant fails open (§F7)', () => {
  it('allows an oversized jobs INSERT for a makeTenant tenant with no entitlements row', async () => {
    // Create a workflow version for the bare tenant so work_orders can be inserted.
    const bareVersionId = await withAdmin(db, async (sql) => {
      const [workflow] = await sql.query<{ id: string }>(
        `INSERT INTO workflows (tenant_id, slug, name) VALUES ($1, 'limits-bare', 'Bare fixture') RETURNING id`,
        [bareTenant.id],
      );
      const [version] = await sql.query<{ id: string }>(
        `INSERT INTO workflow_versions
           (tenant_id, workflow_id, version, prompt_template, output_schema, model)
         VALUES ($1, $2, 1, 'Do this: {{input}}', '{"type":"object"}'::jsonb, 'default')
         RETURNING id`,
        [bareTenant.id, workflow!.id],
      );
      return version!.id;
    });

    const orderId = randomUUID();
    const jobId = randomUUID();

    // No entitlements row, so the trigger cap is NULL and the insert passes.
    await withAdmin(db, (sql) =>
      sql.query(
        'INSERT INTO work_orders (id, tenant_id, item_count, workflow_version_id) VALUES ($1, $2, 100, $3)',
        [orderId, bareTenant.id, bareVersionId],
      ),
    );

    await withAdmin(db, (sql) =>
      sql.query(
        'INSERT INTO jobs (id, tenant_id, order_id, idx, input) VALUES ($1, $2, $3, 0, $4)',
        [jobId, bareTenant.id, orderId, 'this-is-really-long-and-exceeds-any-reasonable-limit'],
      ),
    );

    const [jobCount] = await withAdmin(db, (sql) =>
      sql.query<{ n: number }>('SELECT count(*) AS n FROM jobs WHERE id = $1', [jobId]),
    );

    expect(jobCount!.n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 11. budgetStatus — before any spend (§F8)
// ---------------------------------------------------------------------------

describe('budgetStatus — before any spend (§F8)', () => {
  it('reports used: 0, remaining equal to dailyTokenBudget, exhausted: false', async () => {
    const status = await withTenant(db, budgetTenant.id, (sql) => budgetStatus(sql));

    expect(status.used).toBe(0);
    expect(status.remaining).toBe(100);
    expect(status.exhausted).toBe(false);
    expect(status.budget).toBe(100);
  });
});

/** Helper: bill `totalTokens` for a fresh job under an existing order, returning the job id. */
async function billTokens(
  db: Engine,
  tenantId: string,
  orderId: string,
  totalTokens: number,
): Promise<string> {
  // enqueueOrder creates jobs at idx=0,1,...; we always insert at idx=1
  // since the F8 tests only enqueue one-item orders.
  const jobId = randomUUID();
  await withAdmin(db, async (sql) =>
    sql.query(
      'INSERT INTO jobs (id, tenant_id, order_id, idx, input) VALUES ($1, $2, $3, 1, \'ok\')',
      [jobId, tenantId, orderId],
    ),
  );
  await withTenant(db, tenantId, async (sql) =>
    recordUsage(sql, {
      jobId,
      orderId,
      model: 'default',
      usage: { promptTokens: totalTokens, completionTokens: 0, totalTokens },
    }),
  );
  return jobId;
}

// ---------------------------------------------------------------------------
// 12. budgetStatus — after exceeding the budget (§F8)
// ---------------------------------------------------------------------------

describe('budgetStatus — after exceeding budget (§F8)', () => {
  it('reports used as the billed amount, remaining: 0, exhausted: true', async () => {
    // Create an order + bill 200 tokens — well over the 100-token budget.
    const orderResult = await withTenant(db, budgetTenant.id, (sql) =>
      enqueueOrder(sql, budgetTenant.id, ['x'], {
        workflowVersionId: budgetVersionId,
      }),
    );
    await billTokens(db, budgetTenant.id, orderResult.orderId, 200);

    const status = await withTenant(db, budgetTenant.id, (sql) => budgetStatus(sql));

    expect(status.used).toBe(200);
    expect(status.remaining).toBe(0); // never negative
    expect(status.exhausted).toBe(true);
    expect(status.budget).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// 13. budgetStatus — bare tenant has no budget (§F8)
// ---------------------------------------------------------------------------

describe('budgetStatus — bare tenant (§F8)', () => {
  it('reports budget: null, remaining: null, exhausted: false for a tenant with no entitlements row', async () => {
    const status = await withTenant(db, bareTenant.id, (sql) => budgetStatus(sql));

    expect(status.budget).toBeNull();
    expect(status.remaining).toBeNull();
    expect(status.exhausted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 14. blockOpenOrders — stamps an open order with pending jobs (§F8)
// ---------------------------------------------------------------------------

describe('blockOpenOrders — stamps pending orders (§F8)', () => {
  it('stamps an open order with pending jobs and returns 1', async () => {
    // Exhaust the budget by billing 200 tokens, then finish those jobs
    // so only the new order has pending work.
    const exhaustOrder = await withTenant(db, budgetTenant.id, (sql) =>
      enqueueOrder(sql, budgetTenant.id, ['x'], {
        workflowVersionId: budgetVersionId,
      }),
    );
    await billTokens(db, budgetTenant.id, exhaustOrder.orderId, 200);
    // Mark the exhaust order's jobs as succeeded so blockOpenOrders skips it.
    await withAdmin(db, (sql) =>
      sql.query("UPDATE jobs SET state = 'succeeded' WHERE order_id = $1", [exhaustOrder.orderId]),
    );

    // Create a new open order with pending jobs.
    const orderResult = await withTenant(db, budgetTenant.id, (sql) =>
      enqueueOrder(sql, budgetTenant.id, ['a'], {
        workflowVersionId: budgetVersionId,
      }),
    );

    // Block open orders — should stamp only this one.
    const count = await withTenant(db, budgetTenant.id, (sql) => blockOpenOrders(sql));

    expect(count).toBe(1);

    // Verify the stamp.
    const [order] = await withAdmin(db, (sql) =>
      sql.query<{ blocked_reason: string | null; blocked_at: unknown }>(
        'SELECT blocked_reason, blocked_at FROM work_orders WHERE id = $1',
        [orderResult.orderId],
      ),
    );

    expect(order!.blocked_reason).toBe(BUDGET_EXHAUSTED);
    expect(order!.blocked_at).not.toBeNull();
  });

  it('returns 0 when the order is already stamped', async () => {
    // Exhaust the budget.
    const exhaustOrder = await withTenant(db, budgetTenant.id, (sql) =>
      enqueueOrder(sql, budgetTenant.id, ['x'], {
        workflowVersionId: budgetVersionId,
      }),
    );
    await billTokens(db, budgetTenant.id, exhaustOrder.orderId, 200);

    // Create an open order with pending jobs (id unused — blockOpenOrders finds by state).
    await withTenant(db, budgetTenant.id, (sql) =>
      enqueueOrder(sql, budgetTenant.id, ['a'], {
        workflowVersionId: budgetVersionId,
      }),
    );

    // First call — stamps it.
    await withTenant(db, budgetTenant.id, (sql) => blockOpenOrders(sql));

    // Second call — returns 0.
    const count = await withTenant(db, budgetTenant.id, (sql) => blockOpenOrders(sql));

    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 15. blockOpenOrders — does NOT stamp an order whose jobs are all done (§F8)
// ---------------------------------------------------------------------------

describe('blockOpenOrders — finished orders are not stamped (§F8)', () => {
  it('skips an order whose jobs have all finished', async () => {
    // Exhaust the budget.
    const exhaustOrder = await withTenant(db, budgetTenant.id, (sql) =>
      enqueueOrder(sql, budgetTenant.id, ['x'], {
        workflowVersionId: budgetVersionId,
      }),
    );
    await billTokens(db, budgetTenant.id, exhaustOrder.orderId, 200);
    // Mark the exhaust order's jobs as succeeded so it's not picked up.
    await withAdmin(db, (sql) =>
      sql.query("UPDATE jobs SET state = 'succeeded' WHERE order_id = $1", [exhaustOrder.orderId]),
    );

    // Create an order with jobs and finish them immediately.
    const orderResult = await withTenant(db, budgetTenant.id, (sql) =>
      enqueueOrder(sql, budgetTenant.id, ['a'], {
        workflowVersionId: budgetVersionId,
      }),
    );
    // Mark the jobs as succeeded so the order has no pending jobs.
    await withAdmin(db, (sql) =>
      sql.query(
        "UPDATE jobs SET state = 'succeeded' WHERE order_id = $1",
        [orderResult.orderId],
      ),
    );

    // Block — should return 0 because there are no pending jobs.
    const count = await withTenant(db, budgetTenant.id, (sql) => blockOpenOrders(sql));

    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 16. clearOrderBlocks — resets the stamp (§F8)
// ---------------------------------------------------------------------------

describe('clearOrderBlocks (§F8)', () => {
  it('puts blocked_reason and blocked_at back to null', async () => {
    // Exhaust the budget and stamp an order.
    const exhaustOrder = await withTenant(db, budgetTenant.id, (sql) =>
      enqueueOrder(sql, budgetTenant.id, ['x'], {
        workflowVersionId: budgetVersionId,
      }),
    );
    await billTokens(db, budgetTenant.id, exhaustOrder.orderId, 200);

    const orderResult = await withTenant(db, budgetTenant.id, (sql) =>
      enqueueOrder(sql, budgetTenant.id, ['a'], {
        workflowVersionId: budgetVersionId,
      }),
    );

    await withTenant(db, budgetTenant.id, (sql) => blockOpenOrders(sql));

    // Verify stamped.
    const [pre] = await withAdmin(db, (sql) =>
      sql.query<{ blocked_reason: string | null; blocked_at: unknown }>(
        'SELECT blocked_reason, blocked_at FROM work_orders WHERE id = $1',
        [orderResult.orderId],
      ),
    );
    expect(pre!.blocked_reason).toBe(BUDGET_EXHAUSTED);

    // Clear blocks.
    await withTenant(db, budgetTenant.id, (sql) => clearOrderBlocks(sql));

    // Verify cleared.
    const [post] = await withAdmin(db, (sql) =>
      sql.query<{ blocked_reason: string | null; blocked_at: unknown }>(
        'SELECT blocked_reason, blocked_at FROM work_orders WHERE id = $1',
        [orderResult.orderId],
      ),
    );
    expect(post!.blocked_reason).toBeNull();
    expect(post!.blocked_at).toBeNull();
  });
});
