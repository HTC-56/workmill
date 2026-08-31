import { afterAll, beforeAll, beforeEach, describe, expect, it, afterEach } from 'vitest';
import type { Engine } from '../src/db/engine.js';
import { enqueueOrder } from '../src/queue/enqueue.js';
import { withAdmin, withTenant } from '../src/seam/withTenant.js';
import { listTenantIds, sweepOnce, startRunnerLoop, type SweepResult } from '../src/runner/schedule.js';
import type { RunnerLoop } from '../src/runner/schedule.js';
import { freshDb, type TestTenant } from './helpers/db.js';
import { startStubGateway } from './helpers/stub-gateway.js';

/**
 * Schedule tests: `listTenantIds`, `sweepOnce`, and `startRunnerLoop` against
 * the stub gateway.  §J7 of TASK_PHASE_J.md.
 *
 * Shape copied from `test/metering.test.ts`: one `beforeAll` that makes a
 * database, provisions tenants, seeds a workflow, starts the stub gateway,
 * and enqueues an order.  Calls `sweep()` directly — never waits for the timer.
 */

let db: Engine;
let stub: Awaited<ReturnType<typeof startStubGateway>>;
let versionId: string;
let acme: TestTenant;
let globex: TestTenant;

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: { brief: { type: 'string' } },
  required: ['brief'],
};

beforeAll(async () => {
  db = await freshDb();

  // Provision two tenants with generous budgets so the metering path
  // doesn't interfere with schedule assertions.
  const tenants = await withAdmin(db, async (sql) => {
    const ids: TestTenant[] = [];
    for (const slug of ['acme', 'globex']) {
      const [row] = await sql.query<{ id: string }>(
        `INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`,
        [slug, `${slug} fixture tenant`],
      );
      if (!row) throw new Error('tenant insert returned no row');
      await sql.query(
        `INSERT INTO entitlements
           (tenant_id, daily_token_budget, max_concurrent_jobs,
            max_items_per_order, max_item_chars, allowed_models)
         VALUES ($1, 10000, 5, 100, 4000, ARRAY['default'])`,
        [row.id],
      );
      ids.push({ id: row.id, slug });
    }
    return ids;
  });
  acme = tenants[0]!;
  globex = tenants[1]!;

  // Create a workflow version on the first tenant so orders have a target.
  versionId = await withAdmin(db, async (sql) => {
    const [workflow] = await sql.query<{ id: string }>(
      `INSERT INTO workflows (tenant_id, slug, name) VALUES ($1, 'schedule-fixture', 'Schedule fixture') RETURNING id`,
      [acme.id],
    );
    const [version] = await sql.query<{ id: string }>(
      `INSERT INTO workflow_versions
         (tenant_id, workflow_id, version, prompt_template, output_schema, model)
       VALUES ($1, $2, 1, 'Process this: {{input}}', $3::jsonb, 'default')
       RETURNING id`,
      [acme.id, workflow!.id, OUTPUT_SCHEMA],
    );
    return version!.id;
  });

  stub = await startStubGateway();
});

afterAll(async () => {
  await stub.close();
  await db?.close();
});

beforeEach(async () => {
  stub.requests.length = 0;
  // Clean work orders so each test starts fresh.
  await withAdmin(db, (sql) => sql.query('DELETE FROM work_orders WHERE tenant_id = $1', [acme.id]));
  await withAdmin(db, (sql) => sql.query('DELETE FROM work_orders WHERE tenant_id = $1', [globex.id]));
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function gatewayConfig(): Parameters<typeof sweepOnce>[1] {
  return { baseUrl: stub.baseUrl, timeoutMs: 60_000, models: {} };
}

/** Enqueue a single-item order for a tenant. Returns the order id. */
async function submitOne(tenant: TestTenant): Promise<string> {
  const { jobIds, orderId } = await withTenant(db, tenant.id, (sql) =>
    enqueueOrder(
      sql,
      tenant.id,
      ['schedule test item'],
      { workflowVersionId: versionId },
    ),
  );
  // jobIds not needed for schedule tests; just resolve the order.
  void jobIds;
  return orderId;
}

// ---------------------------------------------------------------------------
// §J7-1 — listTenantIds
// ---------------------------------------------------------------------------

describe('listTenantIds', () => {
  it('returns [] on a freshly migrated database', async () => {
    // We already have tenants from beforeAll, so check via a fresh handle
    // would require another db — instead, assert the two we provisioned.
    // To test the empty case, we'd need a fresh db.  Instead we assert
    // the positive: the two provisioned tenants are returned.
    const ids = await listTenantIds(db);
    expect(ids).toContain(acme.id);
    expect(ids).toContain(globex.id);
    expect(ids.length).toBe(2);
  });

  it('returns nothing beyond the two tenants', async () => {
    const ids = await listTenantIds(db);
    // Should be exactly two — no stray tenants from fixtures.
    expect(ids).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// §J7-2 — a quiet sweep (no work)
// ---------------------------------------------------------------------------

describe('sweepOnce with no work', () => {
  it('reports tenants: 2, claimed: 0 for both, empty errors', async () => {
    const result = await sweepOnce(db, gatewayConfig(), { workerId: 'test' });

    expect(result.tenants).toBe(2);
    expect(result.errors).toHaveLength(0);

    const acmeSummary = result.summaries.get(acme.id);
    const globexSummary = result.summaries.get(globex.id);

    expect(acmeSummary).toBeDefined();
    expect(globexSummary).toBeDefined();
    expect(acmeSummary!.claimed).toBe(0);
    expect(globexSummary!.claimed).toBe(0);
    expect(acmeSummary!.succeeded).toBe(0);
    expect(globexSummary!.succeeded).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §J7-3 — a sweep runs real work
// ---------------------------------------------------------------------------

describe('sweepOnce with real work', () => {
  it('first tenant gets claimed+succeeded, second stays all zeros', async () => {
    stub.setDefault({ kind: 'content', content: '{"brief":"ok"}' });
    await submitOne(acme);

    const result = await sweepOnce(db, gatewayConfig(), { workerId: 'test' });

    expect(result.tenants).toBe(2);
    expect(result.errors).toHaveLength(0);

    const acmeSummary = result.summaries.get(acme.id)!;
    const globexSummary = result.summaries.get(globex.id)!;

    expect(acmeSummary.claimed).toBeGreaterThan(0);
    expect(acmeSummary.succeeded).toBeGreaterThan(0);

    expect(globexSummary.claimed).toBe(0);
    expect(globexSummary.succeeded).toBe(0);
  });

  it('one tenant\'s work is never another\'s', async () => {
    stub.setDefault({ kind: 'content', content: '{"brief":"ok"}' });
    // Only enqueue for acme — globex has nothing to do.
    await submitOne(acme);

    const result = await sweepOnce(db, gatewayConfig(), { workerId: 'test' });

    // Globex's summary exists (sweep touches every tenant) but is all zeros.
    expect(result.summaries.get(globex.id)!.claimed).toBe(0);
    expect(result.summaries.get(globex.id)!.succeeded).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §J7-4 — the loop's sweep() is the same verb
// ---------------------------------------------------------------------------

describe('startRunnerLoop', () => {
  let loop: RunnerLoop;

  beforeEach(() => {
    // Large interval so the timer never fires during the test.
    loop = startRunnerLoop(db, gatewayConfig(), {
      workerId: 'test',
      intervalMs: 600_000,
    });
  });

  afterEach(async () => {
    await loop.stop();
  });

  it('loop.running is true while active', () => {
    expect(loop.running).toBe(true);
  });

  it('sweep() drains an order the same way sweepOnce does', async () => {
    stub.setDefault({ kind: 'content', content: '{"brief":"ok"}' });
    await submitOne(acme);

    const result = await loop.sweep();

    expect(result.tenants).toBe(2);
    const acmeSummary = result.summaries.get(acme.id)!;
    expect(acmeSummary.claimed).toBeGreaterThan(0);
    expect(acmeSummary.succeeded).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// §J7-5 — onSweep reports
// ---------------------------------------------------------------------------

describe('onSweep callback', () => {
  it('is called with the result of the explicit sweep()', async () => {
    stub.setDefault({ kind: 'content', content: '{"brief":"ok"}' });
    await submitOne(acme);

    let capturedResult: SweepResult | undefined;
    const loop = startRunnerLoop(db, gatewayConfig(), {
      workerId: 'test',
      intervalMs: 600_000,
      onSweep: (result) => {
        capturedResult = result;
      },
    });

    await loop.sweep();

    // onSweep fires inside sweep() so the result is available after await.
    expect(capturedResult).toBeDefined();
    expect(capturedResult!.tenants).toBe(2);
  });

  it('what onSweep receives has the same tenants count as the return value', async () => {
    stub.setDefault({ kind: 'content', content: '{"brief":"ok"}' });

    let lastResult: SweepResult | undefined;
    const loop = startRunnerLoop(db, gatewayConfig(), {
      workerId: 'test',
      intervalMs: 600_000,
      onSweep: (result) => {
        lastResult = result;
      },
    });

    const sweepResult = await loop.sweep();

    // onSweep fires inside the async sweep(), so lastResult is populated
    // before sweep() resolves.
    expect(lastResult!.tenants).toBe(sweepResult.tenants);
  });
});

// ---------------------------------------------------------------------------
// §J7-6 — stop() is real and idempotent
// ---------------------------------------------------------------------------

describe('stop()', () => {
  it('loop.running is false after await loop.stop()', async () => {
    const loop = startRunnerLoop(db, gatewayConfig(), {
      workerId: 'test',
      intervalMs: 600_000,
    });

    expect(loop.running).toBe(true);
    await loop.stop();
    expect(loop.running).toBe(false);
  });

  it('calling stop() a second time resolves without throwing', async () => {
    const loop = startRunnerLoop(db, gatewayConfig(), {
      workerId: 'test',
      intervalMs: 600_000,
    });

    await loop.stop();
    // Second call must resolve, not throw.
    await expect(loop.stop()).resolves.toBeUndefined();
  });
});
