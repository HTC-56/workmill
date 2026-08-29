import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Engine } from '../src/db/engine.js';
import { enqueueOrder } from '../src/queue/enqueue.js';
import {
  recordUsage,
  tokensUsedToday,
  tokensUsedForOrder,
  usageByDay,
} from '../src/metering/ledger.js';
import { withAdmin, withTenant } from '../src/seam/withTenant.js';
import { freshDb, makeTenant, type TestTenant } from './helpers/db.js';

/**
 * The token ledger: recordUsage, tokensUsedToday, tokensUsedForOrder, and
 * usageByDay.  §F5 of TASK_PHASE_F.md.
 *
 * No stub gateway is needed — we bill the jobs directly via recordUsage.
 */

let db: Engine;
let tenant: TestTenant;
let versionId: string;

beforeAll(async () => {
  db = await freshDb();
  tenant = await makeTenant(db, 'ledger');
  versionId = await withAdmin(db, async (sql) => {
    const [workflow] = await sql.query<{ id: string }>(
      "INSERT INTO workflows (tenant_id, slug, name) VALUES ($1, 'ledger-fixture', 'Ledger fixture') RETURNING id",
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
  await withAdmin(db, (sql) =>
    sql.query('DELETE FROM work_orders WHERE tenant_id = $1', [tenant.id]),
  );
});

/** Submit an order and return { jobIds, orderId } so callers don't need to query. */
async function submit(count: number): Promise<{
  jobIds: string[];
  orderId: string;
}> {
  const result = await withTenant(db, tenant.id, (sql) =>
    enqueueOrder(
      sql,
      tenant.id,
      Array.from({ length: count }, (_, i) => `item ${i}`),
      { workflowVersionId: versionId },
    ),
  );
  // All job rows share the same order_id — grab it from the first job.
  const [{ order_id: orderId }] = await withTenant(db, tenant.id, (sql) =>
    sql.query<{ order_id: string }>('SELECT order_id FROM jobs WHERE id = $1', [result.jobIds[0]!]),
  ) as [{ order_id: string }];
  return { jobIds: result.jobIds, orderId };
}

// ---------------------------------------------------------------------------
// 1. Fresh tenant has 0 usage and empty usageByDay
// ---------------------------------------------------------------------------

describe('fresh tenant — no usage', () => {
  it('tokensUsedToday is 0 and usageByDay is []', async () => {
    const today = await withTenant(db, tenant.id, (sql) => tokensUsedToday(sql));
    expect(today).toBe(0);

    const byDay = await withTenant(db, tenant.id, (sql) => usageByDay(sql));
    expect(byDay).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Billing two jobs of one order sums correctly
// ---------------------------------------------------------------------------

describe('recordUsage — summing two jobs', () => {
  it('tokensUsedToday and tokensUsedForOrder both report the combined total', async () => {
    const { jobIds, orderId } = await submit(2);

    await withTenant(db, tenant.id, (sql) =>
      recordUsage(sql, {
        jobId: jobIds[0]!,
        orderId,
        model: 'default',
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      }),
    );

    await withTenant(db, tenant.id, (sql) =>
      recordUsage(sql, {
        jobId: jobIds[1]!,
        orderId,
        model: 'default',
        usage: { promptTokens: 200, completionTokens: 100, totalTokens: 300 },
      }),
    );

    const today = await withTenant(db, tenant.id, (sql) => tokensUsedToday(sql));
    expect(today).toBe(450);

    const forOrder = await withTenant(db, tenant.id, (sql) =>
      tokensUsedForOrder(sql, orderId),
    );
    expect(forOrder).toBe(450);
  });
});

// ---------------------------------------------------------------------------
// 3. The ledger does not double-bill — upsert by jobId
// ---------------------------------------------------------------------------

describe('recordUsage — idempotent by jobId', () => {
  it('calling recordUsage twice for the same jobId leaves one row with the second total', async () => {
    const { jobIds, orderId } = await submit(1);

    // First billing: 50 total tokens.
    await withTenant(db, tenant.id, (sql) =>
      recordUsage(sql, {
        jobId: jobIds[0]!,
        orderId,
        model: 'default',
        usage: { promptTokens: 20, completionTokens: 30, totalTokens: 50 },
      }),
    );

    let today = await withTenant(db, tenant.id, (sql) => tokensUsedToday(sql));
    expect(today).toBe(50);

    // Second billing for the same job: 120 total tokens (should replace).
    await withTenant(db, tenant.id, (sql) =>
      recordUsage(sql, {
        jobId: jobIds[0]!,
        orderId,
        model: 'default',
        usage: { promptTokens: 40, completionTokens: 80, totalTokens: 120 },
      }),
    );

    today = await withTenant(db, tenant.id, (sql) => tokensUsedToday(sql));
    expect(today).toBe(120); // NOT 170

    const forOrder = await withTenant(db, tenant.id, (sql) =>
      tokensUsedForOrder(sql, orderId),
    );
    expect(forOrder).toBe(120); // NOT 170
  });
});

// ---------------------------------------------------------------------------
// 4. usageByDay returns one entry for today with correct fields
// ---------------------------------------------------------------------------

describe('usageByDay — daily aggregation', () => {
  it('returns one entry with matching totalTokens, jobs count, and YYYY-MM-DD day', async () => {
    const { jobIds, orderId } = await submit(3);

    // Bill all three jobs.
    for (let i = 0; i < 3; i++) {
      await withTenant(db, tenant.id, (sql) =>
        recordUsage(sql, {
          jobId: jobIds[i]!,
          orderId,
          model: 'default',
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        }),
      );
    }

    const byDay = await withTenant(db, tenant.id, (sql) => usageByDay(sql));
    expect(byDay).toHaveLength(1);

    const entry = byDay[0]!;
    expect(entry.totalTokens).toBe(45); // 15 * 3
    expect(entry.jobs).toBe(3);
    expect(entry.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(entry.promptTokens).toBe(30);
    expect(entry.completionTokens).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// 5. Second tenant is isolated — billing tenant A is invisible to tenant B
// ---------------------------------------------------------------------------

describe('ledger — tenant isolation', () => {
  it('a second tenant that bills nothing still reports 0', async () => {
    // Create a second tenant.
    const other = await makeTenant(db, 'ledger-other');

    // Bill the first tenant.
    const { jobIds, orderId } = await submit(1);

    await withTenant(db, tenant.id, (sql) =>
      recordUsage(sql, {
        jobId: jobIds[0]!,
        orderId,
        model: 'default',
        usage: { promptTokens: 999, completionTokens: 1, totalTokens: 1000 },
      }),
    );

    // First tenant sees its bill.
    const tenantToday = await withTenant(db, tenant.id, (sql) => tokensUsedToday(sql));
    expect(tenantToday).toBe(1000);

    // Second tenant sees nothing.
    const otherToday = await withTenant(db, other.id, (sql) => tokensUsedToday(sql));
    expect(otherToday).toBe(0);

    const otherByDay = await withTenant(db, other.id, (sql) => usageByDay(sql));
    expect(otherByDay).toEqual([]);
  });
});
