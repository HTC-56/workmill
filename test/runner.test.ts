import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Engine } from '../src/db/engine.js';
import { runOnce, runUntilIdle } from '../src/runner/run.js';
import { orderProgress } from '../src/queue/lifecycle.js';
import { enqueueOrder } from '../src/queue/enqueue.js';
import { withAdmin, withTenant } from '../src/seam/withTenant.js';
import { freshDb, makeTenant, type TestTenant } from './helpers/db.js';
import { startStubGateway } from './helpers/stub-gateway.js';

/**
 * End-to-end runner tests: `runOnce` and `runUntilIdle` against the stub
 * gateway.  §E7 of TASK_PHASE_E.md.
 *
 * This is the first file in the repo that uses both a database and the stub
 * gateway, so both are started in `beforeAll` and closed in `afterAll`.
 *
 * No model calls reach the network — everything flows through the in-process
 * stub.
 */

let db: Engine;
let tenant: TestTenant;
let stub: Awaited<ReturnType<typeof startStubGateway>>;
let versionId: string;

const OUTPUT_SCHEMA = JSON.stringify({
  type: 'object',
  properties: { brief: { type: 'string' } },
  required: ['brief'],
});

beforeAll(async () => {
  db = await freshDb();
  tenant = await makeTenant(db, 'runner');
  stub = await startStubGateway();

  // Create a workflow version with a real output schema so the runner's
  // completion path validates output correctly.
  versionId = await withAdmin(db, async (sql) => {
    const [workflow] = await sql.query<{ id: string }>(
      "INSERT INTO workflows (tenant_id, slug, name) VALUES ($1, 'runner-fixture', 'Runner fixture') RETURNING id",
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
// §E7 — an order end to end
// ---------------------------------------------------------------------------

describe('runUntilIdle — full order', () => {
  it('reports succeeded:3 and leaves every job succeeded', async () => {
    stub.setDefault({ kind: 'content', content: '{"brief":"ok"}' });
    await submit(3);

    const summary = await runUntilIdle(db, tenant.id, gatewayConfig(), runnerOpts());
    expect(summary.succeeded).toBe(3);
    expect(summary.failed).toBe(0);
    expect(summary.retried).toBe(0);
    expect(summary.dead).toBe(0);
    expect(summary.cancelled).toBe(0);
  });

  it('three job_results rows, each ok, output matching stub, total_tokens 18', async () => {
    stub.setDefault({ kind: 'content', content: '{"brief":"ok"}' });
    await submit(3);

    await runUntilIdle(db, tenant.id, gatewayConfig(), runnerOpts());

    const results = await withTenant(db, tenant.id, (sql) =>
      sql.query<{ ok: boolean; output: unknown; total_tokens: number }>(
        'SELECT ok, output, total_tokens FROM job_results WHERE tenant_id = $1 ORDER BY job_id',
        [tenant.id],
      ),
    );
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results[0]!.output).toEqual({ brief: 'ok' });
    // One attempt → one call's usage: promptTokens=11 + completionTokens=7 = 18.
    expect(results.every((r) => r.total_tokens === 18)).toBe(true);
  });

  it('orderProgress reports orderState done once the last item finishes', async () => {
    stub.setDefault({ kind: 'content', content: '{"brief":"ok"}' });
    const jobIds = await submit(3);
    const [{ order_id: orderId }] = (await withTenant(db, tenant.id, (sql) =>
      sql.query<{ order_id: string }>('SELECT order_id FROM jobs WHERE id = $1', [jobIds[0]]),
    )) as [{ order_id: string }];

    await runUntilIdle(db, tenant.id, gatewayConfig(), runnerOpts());

    const progress = await withTenant(db, tenant.id, (sql) => orderProgress(sql, orderId));
    expect(progress.orderState).toBe('done');
  });
});

describe('runOnce with batchSize', () => {
  it('batchSize:2 claims exactly 2, second runOnce claims the last 1', async () => {
    stub.setDefault({ kind: 'content', content: '{"brief":"ok"}' });
    await submit(3);

    const first = await runOnce(db, tenant.id, gatewayConfig(), runnerOpts({ batchSize: 2 }));
    expect(first.claimed).toBe(2);
    expect(first.succeeded).toBe(2);

    const second = await runOnce(db, tenant.id, gatewayConfig(), runnerOpts({ batchSize: 2 }));
    expect(second.claimed).toBe(1);
    expect(second.succeeded).toBe(1);
  });
});

describe('runOnce on empty queue', () => {
  it('returns a summary of all zeros and makes no request to the stub', async () => {
    stub.setDefault({ kind: 'content', content: '{"brief":"ok"}' });
    // Don't submit anything.
    const summary = await runOnce(db, tenant.id, gatewayConfig(), runnerOpts());
    expect(summary.claimed).toBe(0);
    expect(summary.succeeded).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.retried).toBe(0);
    expect(summary.dead).toBe(0);
    expect(summary.cancelled).toBe(0);
    expect(summary.reaped).toBe(0);
    expect(stub.requests.length).toBe(0);
  });
});

describe('runOnce — prompt reaches the model', () => {
  it("the last request's user message contains the item's text", async () => {
    stub.setDefault({ kind: 'content', content: '{"brief":"ok"}' });
    // submit(2) posts items with text "item 0" and "item 1"
    await submit(2);

    await runOnce(db, tenant.id, gatewayConfig(), runnerOpts());

    // The runner renders the template with the item text as input.
    expect(stub.requests.length).toBe(2);
    const userMessages = stub.requests.map(
      (r) => r.messages.find((m) => m.role === 'user')?.content ?? '',
    );
    expect(userMessages.some((msg) => msg.includes('item 0'))).toBe(true);
    expect(userMessages.some((msg) => msg.includes('item 1'))).toBe(true);
  });
});
