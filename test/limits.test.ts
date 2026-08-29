import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Engine } from '../src/db/engine.js';
import { withAdmin, withTenant } from '../src/seam/withTenant.js';
import { randomUUID } from 'node:crypto';
import { freshDb, makeTenant, type TestTenant } from './helpers/db.js';
import { provisionTenant } from '../src/tenancy/provision.js';
import {
  readLimits,
  assertSubmitAllowed,
  EntitlementRefusedError,
} from '../src/metering/limits.js';
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
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  // Clear work_orders so each test starts fresh.
  await withAdmin(db, (sql) =>
    sql.query('DELETE FROM work_orders WHERE tenant_id = $1', [tenant.id]),
  );
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
