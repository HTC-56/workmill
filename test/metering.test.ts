import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Engine } from '../src/db/engine.js';
import { runOnce, runUntilIdle } from '../src/runner/run.js';
import { enqueueOrder } from '../src/queue/enqueue.js';
import { withAdmin, withTenant } from '../src/seam/withTenant.js';
import { freshDb, type TestTenant } from './helpers/db.js';
import { startStubGateway } from './helpers/stub-gateway.js';
import { tokensUsedForOrder, tokensUsedToday } from '../src/metering/ledger.js';

/**
 * Metering integration: the runner bills the ledger and the order reports
 * when the budget stops it.  §F10 of TASK_PHASE_F.md.
 *
 * Uses both a database and the stub gateway, wired through the same
 * `beforeAll`/`afterAll` shape as `test/runner.test.ts`.
 */

let db: Engine;
let tenant: TestTenant;
let stub: Awaited<ReturnType<typeof startStubGateway>>;
let versionId: string;

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: { brief: { type: 'string' } },
  required: ['brief'],
};

beforeAll(async () => {
  db = await freshDb();
  // Provision a tenant with a tight budget so the metering path is exercised.
  tenant = await withAdmin(db, async (sql) => {
    const [row] = await sql.query<{ id: string }>(
      `INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`,
      ['metering', 'Metering fixture tenant'],
    );
    if (!row) throw new Error('tenant insert returned no row');
    // Tight budget: 30 tokens/day, 1 concurrent job max.
    await sql.query(
      `INSERT INTO entitlements
         (tenant_id, daily_token_budget, max_concurrent_jobs,
          max_items_per_order, max_item_chars, allowed_models)
       VALUES ($1, 30, 1, 100, 4000, ARRAY['default'])`,
      [row.id],
    );
    return { id: row.id, slug: 'metering' };
  });
  stub = await startStubGateway();

  // Create a workflow version with a real output schema.
  versionId = await withAdmin(db, async (sql) => {
    const [workflow] = await sql.query<{ id: string }>(
      "INSERT INTO workflows (tenant_id, slug, name) VALUES ($1, 'metering-fixture', 'Metering fixture') RETURNING id",
      [tenant.id],
    );
    const [version] = await sql.query<{ id: string }>(
      `INSERT INTO workflow_versions
         (tenant_id, workflow_id, version, prompt_template, output_schema, model)
       VALUES ($1, $2, 1, 'Process this: {{input}}', $3::jsonb, 'default')
       RETURNING id`,
      [tenant.id, workflow!.id, OUTPUT_SCHEMA],
    );
    return version!.id;
  });
});

afterAll(async () => {
  await stub.close();
  await db?.close();
});

beforeEach(async () => {
  stub.requests.length = 0;
  await withAdmin(db, (sql) => sql.query('DELETE FROM work_orders WHERE tenant_id = $1', [tenant.id]));
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function submit(count: number): Promise<string[]> {
  const { jobIds } = await withTenant(db, tenant.id, (sql) =>
    enqueueOrder(
      sql,
      tenant.id,
      Array.from({ length: count }, (_, i) => `item ${i}`),
      { workflowVersionId: versionId },
    ),
  );
  return jobIds;
}

function gatewayConfig(): Parameters<typeof runOnce>[2] {
  return { baseUrl: stub.baseUrl, timeoutMs: 60_000, models: {} };
}

function runnerOpts(overrides?: Partial<Parameters<typeof runOnce>[3]>) {
  const opts: Parameters<typeof runOnce>[3] = {
    workerId: 'test-worker',
    batchSize: overrides?.batchSize ?? 4,
    leaseMs: 30_000,
    heartbeatMs: 10_000,
  };
  if (overrides?.random !== undefined) {
    opts.random = overrides.random;
  }
  return opts;
}

// ---------------------------------------------------------------------------
// §F10 — the runner bills the ledger and the order reports the budget stop
// ---------------------------------------------------------------------------

describe('runOnce claims exactly 1 under max_concurrent_jobs:1', () => {
  it('a four-item order with batchSize:4 still claims 1', async () => {
    stub.setDefault({ kind: 'content', content: '{"brief":"ok"}' });
    await submit(4);

    const summary = await runOnce(db, tenant.id, gatewayConfig(), runnerOpts({ batchSize: 4 }));
    expect(summary.claimed).toBe(1);
    expect(summary.succeeded).toBe(1);
  });
});

describe('ledger records the job spend', () => {
  it('tokensUsedForOrder > 0 and tokensUsedToday equals it after one job', async () => {
    stub.setDefault({ kind: 'content', content: '{"brief":"ok"}' });
    const jobIds = await submit(1);

    await runOnce(db, tenant.id, gatewayConfig(), runnerOpts());

    const [orderIdRow] = await withTenant(db, tenant.id, (sql) =>
      sql.query<{ order_id: string }>('SELECT order_id FROM jobs WHERE id = $1', [jobIds[0]]),
    );
    const orderId = orderIdRow!.order_id;

    const forOrder = await withTenant(db, tenant.id, (sql) => tokensUsedForOrder(sql, orderId));
    expect(forOrder).toBeGreaterThan(0);

    const today = await withTenant(db, tenant.id, (sql) => tokensUsedToday(sql));
    expect(today).toBe(forOrder);
  });
});

describe('runUntilIdle stops when the daily budget is exhausted', () => {
  it('blocked >= 1 and order blocked_reason is daily-token-budget-exhausted', async () => {
    stub.setDefault({ kind: 'content', content: '{"brief":"ok"}' });
    // 4 items, budget 30 tokens. First runOnce claims 1 and spends ~18 tokens.
    // The budget is now spent; runUntilIdle should stop with blocked >= 1.
    await submit(4);

    const summary = await runUntilIdle(db, tenant.id, gatewayConfig(), runnerOpts());
    expect(summary.blocked).toBeGreaterThanOrEqual(1);

    // The order should have blocked_reason set.
    const [order] = await withTenant(db, tenant.id, (sql) =>
      sql.query<{ state: string; blocked_reason: string | null }>(
        "SELECT state, blocked_reason FROM work_orders WHERE tenant_id = $1",
        [tenant.id],
      ),
    );
    expect(order!.blocked_reason).toBe('daily-token-budget-exhausted');
  });
});

describe('a blocked order is still open with pending jobs', () => {
  it('budget block is not a cancel: order stays open, jobs stay pending', async () => {
    stub.setDefault({ kind: 'content', content: '{"brief":"ok"}' });
    await submit(4);

    await runUntilIdle(db, tenant.id, gatewayConfig(), runnerOpts());

    const orders = await withTenant(db, tenant.id, (sql) =>
      sql.query<{ state: string }>("SELECT state FROM work_orders WHERE tenant_id = $1", [tenant.id]),
    );
    expect(orders[0]!.state).toBe('open');

    const pending = await withTenant(db, tenant.id, (sql) =>
      sql.query<{ state: string }>("SELECT state FROM jobs WHERE tenant_id = $1 AND state = 'pending'", [tenant.id]),
    );
    expect(pending.length).toBeGreaterThan(0);
  });
});

describe('raising the budget clears blocked_reason and resumes work', () => {
  it('UPDATE entitlements + another runOnce claims more jobs', async () => {
    stub.setDefault({ kind: 'content', content: '{"brief":"ok"}' });
    await submit(4);

    // Let the budget exhaust.
    await runUntilIdle(db, tenant.id, gatewayConfig(), runnerOpts());

    const [orderBefore] = await withTenant(db, tenant.id, (sql) =>
      sql.query<{ state: string; blocked_reason: string | null }>(
        "SELECT state, blocked_reason FROM work_orders WHERE tenant_id = $1",
        [tenant.id],
      ),
    );
    expect(orderBefore!.blocked_reason).toBe('daily-token-budget-exhausted');

    // Raise the budget under admin so the budget check no longer fires.
    await withAdmin(db, (sql) =>
      sql.query(
        'UPDATE entitlements SET daily_token_budget = 10000 WHERE tenant_id = $1',
        [tenant.id],
      ),
    );

    // Now run again — should clear the block and claim more work.
    const summary = await runOnce(db, tenant.id, gatewayConfig(), runnerOpts());
    expect(summary.claimed).toBeGreaterThanOrEqual(1);
    expect(summary.succeeded).toBeGreaterThanOrEqual(1);

    // The blocked_reason should be cleared.
    const [orderAfter] = await withTenant(db, tenant.id, (sql) =>
      sql.query<{ blocked_reason: string | null }>(
        "SELECT blocked_reason FROM work_orders WHERE tenant_id = $1",
        [tenant.id],
      ),
    );
    expect(orderAfter!.blocked_reason).toBeNull();
  });
});
