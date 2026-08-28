import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Engine } from '../src/db/engine.js';
import { runOnce, runUntilIdle, cancelOrderNow } from '../src/runner/run.js';
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

// ---------------------------------------------------------------------------
// §E8 — the failure paths
// ---------------------------------------------------------------------------

describe('5xx transport failure — retried then dead', () => {
  it('one runOnce with 503 stub reports retried:1, job back to pending', async () => {
    stub.queue({ kind: 'status', status: 503 });
    await submit(1);

    const summary = await runOnce(db, tenant.id, gatewayConfig(), runnerOpts({ random: () => 0 }));
    expect(summary.retried).toBe(1);
    expect(summary.succeeded).toBe(0);
    expect(summary.dead).toBe(0);

    // Job should be back in pending.
    const [job] = await withTenant(db, tenant.id, (sql) =>
      sql.query<{ state: string }>('SELECT state FROM jobs WHERE tenant_id = $1', [tenant.id]),
    );
    expect(job!.state).toBe('pending');
  });

  it('three 503 rounds put the job dead, summary dead:1, no job_results row', async () => {
    // Queue three 503s — one per runOnce tick.
    stub.queue({ kind: 'status', status: 503 }, { kind: 'status', status: 503 }, { kind: 'status', status: 503 });
    await submit(1);

    // Each runOnce claims the one job, gets 503 → pending, then stops (no more jobs).
    // After 3 runs the job should be dead.
    let summary: Awaited<ReturnType<typeof runOnce>>;
    for (let i = 0; i < 3; i++) {
      summary = await runOnce(db, tenant.id, gatewayConfig(), runnerOpts({ random: () => 0 }));
    }
    expect(summary!.dead).toBe(1);

    // No job_results row — the model never answered.
    const results = await withTenant(db, tenant.id, (sql) =>
      sql.query<{ id: string }>('SELECT id FROM job_results WHERE tenant_id = $1', [tenant.id]),
    );
    expect(results).toHaveLength(0);
  });
});

describe('schema-invalid — bounded re-ask, job_results recorded', () => {
  it('runOnce reports failed:1, job is failed, job_results has ok:false and attempts:3', async () => {
    // The stub always answers with content that misses the output schema.
    stub.setDefault({ kind: 'content', content: '{"wrong":1}' });
    await submit(1);

    const summary = await runOnce(db, tenant.id, gatewayConfig(), runnerOpts());
    expect(summary.failed).toBe(1);

    const jobRow = await withTenant(db, tenant.id, (sql) =>
      sql.query<{ state: string }>('SELECT state FROM jobs WHERE tenant_id = $1', [tenant.id]),
    );
    expect(jobRow[0]!.state).toBe('failed');

    const results = await withTenant(db, tenant.id, (sql) =>
      sql.query<{ ok: boolean; failure_reason: string; raw_output: string; attempts: number }>(
        'SELECT ok, failure_reason, raw_output, attempts FROM job_results WHERE job_id = (SELECT id FROM jobs WHERE tenant_id = $1)',
        [tenant.id],
      ),
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.failure_reason).toBe('schema-invalid');
    expect(results[0]!.raw_output).toBe('{"wrong":1}');
    // Bounded re-ask in runCompletion tries 3 times (MAX_REASKS=2 + initial = 3).
    expect(results[0]!.attempts).toBe(3);
  });
});

describe('cancel aborts a running job', () => {
  it('runner reports cancelled:1, job is cancelled with cancelled trail entry, no result row', async () => {
    // Stub delays 3 seconds so the runner is mid-call when we cancel.
    stub.setDefault({ kind: 'delay', ms: 3000 });
    await submit(1);

    const [firstJob] = await withTenant(db, tenant.id, (sql) =>
      sql.query<{ id: string }>('SELECT id FROM jobs WHERE tenant_id = $1', [tenant.id]),
    );
    const orderIdRow = await withTenant(db, tenant.id, (sql) =>
      sql.query<{ order_id: string }>('SELECT order_id FROM jobs WHERE id = $1', [firstJob!.id]),
    );
    const orderId = orderIdRow[0]!.order_id;

    // Start runOnce without awaiting — it will claim the job and hit the delayed stub.
    const runnerPromise = runOnce(db, tenant.id, gatewayConfig(), {
      ...runnerOpts(),
      heartbeatMs: 60,
    });

    // Wait ~300ms for the runner to claim and start the model call.
    await new Promise((r) => setTimeout(r, 300));

    // Cancel the order while the job is running.
    await cancelOrderNow(db, tenant.id, orderId);

    // Await the runner — it should resolve quickly (aborted, not waited full 3s).
    const summary = await runnerPromise;
    expect(summary.cancelled).toBe(1);

    // Job should be cancelled with a trail entry.
    const jobRow = await withTenant(db, tenant.id, (sql) =>
      sql.query<{ state: string }>('SELECT state FROM jobs WHERE tenant_id = $1', [tenant.id]),
    );
    expect(jobRow[0]!.state).toBe('cancelled');

    const trail = await withTenant(db, tenant.id, (sql) =>
      sql.query<{ failure_trail: unknown }>('SELECT failure_trail FROM jobs WHERE tenant_id = $1', [tenant.id]),
    );
    const entries = trail[0]!.failure_trail as Array<{ kind: string }>;
    expect(entries.some((e) => e.kind === 'cancelled')).toBe(true);

    // No job_results — the call was aborted before completion.
    const results = await withTenant(db, tenant.id, (sql) =>
      sql.query<{ id: string }>('SELECT id FROM job_results WHERE tenant_id = $1', [tenant.id]),
    );
    expect(results).toHaveLength(0);
  }, 15_000);

  it('the cancelled runOnce resolves well under the stub 3000ms delay', async () => {
    stub.setDefault({ kind: 'delay', ms: 3000 });
    await submit(1);

    const [firstJob] = await withTenant(db, tenant.id, (sql) =>
      sql.query<{ id: string }>('SELECT id FROM jobs WHERE tenant_id = $1', [tenant.id]),
    );
    const orderIdRow = await withTenant(db, tenant.id, (sql) =>
      sql.query<{ order_id: string }>('SELECT order_id FROM jobs WHERE id = $1', [firstJob!.id]),
    );
    const orderId = orderIdRow[0]!.order_id;

    const startedAt = Date.now();
    const runnerPromise = runOnce(db, tenant.id, gatewayConfig(), {
      ...runnerOpts(),
      heartbeatMs: 60,
    });

    await new Promise((r) => setTimeout(r, 300));
    await cancelOrderNow(db, tenant.id, orderId);

    await runnerPromise;
    const elapsed = Date.now() - startedAt;
    // Well under 3000ms — the cancel aborted rather than waiting.
    expect(elapsed).toBeLessThan(1500);
  }, 15_000);
});
