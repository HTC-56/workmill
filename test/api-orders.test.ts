import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Engine } from '../src/db/engine.js';
import { runUntilIdle } from '../src/runner/run.js';
import { withAdmin, withTenant } from '../src/seam/withTenant.js';
import { seedExampleWorkflows } from '../src/workflows/examples.js';
import { freshDb, type TestTenant } from './helpers/db.js';
import { startStubGateway } from './helpers/stub-gateway.js';
import { startTestServer, mintTestToken } from './helpers/server.js';

/**
 * API orders integration: progress, per-item detail, results download and
 * cancel, with the stub gateway.  §H6 of TASK_PHASE_H.md.
 */

let db: Engine;
let tenantA: TestTenant;
let tenantB: TestTenant;
let stub: Awaited<ReturnType<typeof startStubGateway>>;
let serverA: Awaited<ReturnType<typeof startTestServer>>;
let serverB: Awaited<ReturnType<typeof startTestServer>>;
let tokenA: string;
let tokenB: string;
let orderId: string;

// A schema that the stub's default output matches.
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: { brief: { type: 'string' } },
  required: ['brief'],
};

beforeAll(async () => {
  db = await freshDb();

  // Provision two tenants. Tenant A gets a large budget so the runner isn't
  // stopped by the daily-token-budget-exhausted guard.
  tenantA = await withAdmin(db, async (sql) => {
    const [row] = await sql.query<{ id: string }>(
      `INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`,
      ['orders-a', 'Orders tenant A'],
    );
    if (!row) throw new Error('tenant A insert returned no row');
    await sql.query(
      `INSERT INTO entitlements
         (tenant_id, daily_token_budget, max_concurrent_jobs,
          max_items_per_order, max_item_chars, allowed_models)
       VALUES ($1, 100000, 10, 100, 4000, ARRAY['default'])`,
      [row.id],
    );
    return { id: row.id, slug: 'orders-a' };
  });

  tenantB = await withAdmin(db, async (sql) => {
    const [row] = await sql.query<{ id: string }>(
      `INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`,
      ['orders-b', 'Orders tenant B'],
    );
    if (!row) throw new Error('tenant B insert returned no row');
    await sql.query(
      `INSERT INTO entitlements
         (tenant_id, daily_token_budget, max_concurrent_jobs,
          max_items_per_order, max_item_chars, allowed_models)
       VALUES ($1, 100000, 10, 100, 4000, ARRAY['default'])`,
      [row.id],
    );
    return { id: row.id, slug: 'orders-b' };
  });

  // Seed example workflows for tenant A and create a dedicated fixture
  // version whose schema matches the stub gateway's default output.
  await withTenant(db, tenantA.id, (sql) => seedExampleWorkflows(sql));
  const [firstWf] = await withTenant(db, tenantA.id, (sql) =>
    sql.query<{ id: string }>(
      `SELECT w.id FROM workflows w
       JOIN workflow_versions v ON v.workflow_id = w.id AND v.version = w.current_version
       WHERE w.tenant_id = $1 AND w.state = 'active'
       ORDER BY w.slug LIMIT 1`,
      [tenantA.id],
    ),
  );
  const workflowId = firstWf!.id;
  const [version] = await withTenant(db, tenantA.id, (sql) =>
    sql.query<{ id: string }>(
      `INSERT INTO workflow_versions
         (tenant_id, workflow_id, version, prompt_template, output_schema, model)
       VALUES ($1, $2, 2, 'Process: {{input}}', $3::jsonb, 'default')
       RETURNING id`,
      [tenantA.id, workflowId, OUTPUT_SCHEMA],
    ),
  );
  void version; // schema fixture — submit route resolves current version at runtime.

  stub = await startStubGateway();
  serverA = await startTestServer(db);
  serverB = await startTestServer(db);
  tokenA = await mintTestToken(db, tenantA.id);
  tokenB = await mintTestToken(db, tenantB.id);
});

afterAll(async () => {
  await stub.close();
  await serverA.close();
  await serverB.close();
  await db?.close();
});

beforeEach(async () => {
  stub.requests.length = 0;
  stub.setDefault({ kind: 'content', content: '{"brief":"ok"}' });
  // Reset orders between tests.
  await withAdmin(db, (sql) => sql.query('DELETE FROM job_results WHERE tenant_id = $1', [tenantA.id]));
  await withAdmin(db, (sql) => sql.query('DELETE FROM jobs WHERE tenant_id = $1', [tenantA.id]));
  await withAdmin(db, (sql) => sql.query('DELETE FROM work_orders WHERE tenant_id = $1', [tenantA.id]));
});

// ---------------------------------------------------------------------------
// §H6 — order list, detail, results, cancel
// ---------------------------------------------------------------------------

describe('GET /api/orders — order list before the run', () => {
  it('lists the order with counts.pending === itemCount, finished 0, totalTokens 0', async () => {
    // Submit a 3-item order over HTTP.
    const workflowCards = await serverA.getJson('/api/workflows', tokenA);
    const workflows = workflowCards.body.workflows as { workflowId: string }[];
    const workflowId = workflows[0]!.workflowId;

    const submitResp = await serverA.postJson(
      '/api/orders',
      { workflowId, items: ['one', 'two', 'three'] },
      tokenA,
    );
    expect(submitResp.status).toBe(201);
    orderId = submitResp.body.orderId as string;

    const listResp = await serverA.getJson('/api/orders', tokenA);
    expect(listResp.status).toBe(200);
    const orders = listResp.body.orders as {
      itemCount: number;
      counts: Record<string, number>;
      finished: number;
      totalTokens: number;
    }[];
    expect(orders.length).toBe(1);
    const order = orders[0]!;
    expect(order.itemCount).toBe(3);
    expect(order.counts.pending).toBe(3);
    expect(order.finished).toBe(0);
    expect(order.totalTokens).toBe(0);
  });
});

describe('GET /api/orders — tenant scope', () => {
  it('tenant B sees orders: []', async () => {
    const workflowCards = await serverA.getJson('/api/workflows', tokenA);
    const workflows = workflowCards.body.workflows as { workflowId: string }[];
    const workflowId = workflows[0]!.workflowId;
    await serverA.postJson(
      '/api/orders',
      { workflowId, items: ['one', 'two', 'three'] },
      tokenA,
    );

    const listResp = await serverB.getJson('/api/orders', tokenB);
    expect(listResp.status).toBe(200);
    const orders = listResp.body.orders as unknown[];
    expect(orders).toEqual([]);
  });

  it("GET /api/orders/<tenant A's order> is 404 for tenant B", async () => {
    const workflowCards = await serverA.getJson('/api/workflows', tokenA);
    const workflows = workflowCards.body.workflows as { workflowId: string }[];
    const workflowId = workflows[0]!.workflowId;
    const submitResp = await serverA.postJson(
      '/api/orders',
      { workflowId, items: ['one', 'two', 'three'] },
      tokenA,
    );
    orderId = submitResp.body.orderId as string;

    const resp = await serverB.get(`/api/orders/${orderId}`, tokenB);
    expect(resp.status).toBe(404);
  });

  it('GET /api/orders/not-a-uuid is 404 not 500', async () => {
    const resp = await serverA.get('/api/orders/not-a-uuid', tokenA);
    expect(resp.status).toBe(404);
  });
});

describe('GET /api/orders/:orderId — detail before the run', () => {
  it('returns { order, items } with items in idx order and output null', async () => {
    const workflowCards = await serverA.getJson('/api/workflows', tokenA);
    const workflows = workflowCards.body.workflows as { workflowId: string }[];
    const workflowId = workflows[0]!.workflowId;
    const submitResp = await serverA.postJson(
      '/api/orders',
      { workflowId, items: ['alpha', 'beta', 'gamma'] },
      tokenA,
    );
    orderId = submitResp.body.orderId as string;

    const resp = await serverA.getJson(`/api/orders/${orderId}`, tokenA);
    expect(resp.status).toBe(200);
    const detail = resp.body as {
      order: Record<string, unknown>;
      items: { idx: number; output: unknown }[];
    };
    expect(detail.order).toBeDefined();
    expect(detail.items.length).toBe(3);
    // Items are in idx order.
    expect(detail.items[0]!.idx).toBe(0);
    expect(detail.items[1]!.idx).toBe(1);
    expect(detail.items[2]!.idx).toBe(2);
    // Output is null before the run.
    for (const item of detail.items) {
      expect(item.output).toBeNull();
    }
  });
});

describe('GET /api/orders/:orderId — after runUntilIdle', () => {
  it("order state is 'done', totalTokens > 0, every item succeeded or failed", async () => {
    const workflowCards = await serverA.getJson('/api/workflows', tokenA);
    const workflows = workflowCards.body.workflows as { workflowId: string }[];
    const workflowId = workflows[0]!.workflowId;
    const submitResp = await serverA.postJson(
      '/api/orders',
      { workflowId, items: ['x', 'y', 'z'] },
      tokenA,
    );
    orderId = submitResp.body.orderId as string;

    // Run to completion against the stub.
    await runUntilIdle(db, tenantA.id, { baseUrl: stub.baseUrl, timeoutMs: 60_000, models: {} }, {
      workerId: 'test-worker',
      batchSize: 4,
      leaseMs: 30_000,
      heartbeatMs: 10_000,
    });

    const resp = await serverA.getJson(`/api/orders/${orderId}`, tokenA);
    expect(resp.status).toBe(200);
    const detail = resp.body as {
      order: Record<string, unknown>;
      items: { state: string }[];
    };
    expect(detail.order.state).toBe('done');
    expect(detail.order.totalTokens).toBeGreaterThan(0);
    for (const item of detail.items) {
      expect(['succeeded', 'failed']).toContain(item.state);
    }
  });
});

describe('GET /api/orders/:orderId/results.json', () => {
  it('200 with content-disposition attachment, orderId, validatedCount, results', async () => {
    const workflowCards = await serverA.getJson('/api/workflows', tokenA);
    const workflows = workflowCards.body.workflows as { workflowId: string }[];
    const workflowId = workflows[0]!.workflowId;
    const submitResp = await serverA.postJson(
      '/api/orders',
      { workflowId, items: ['a', 'b', 'c'] },
      tokenA,
    );
    orderId = submitResp.body.orderId as string;

    await runUntilIdle(db, tenantA.id, { baseUrl: stub.baseUrl, timeoutMs: 60_000, models: {} }, {
      workerId: 'test-worker',
      batchSize: 4,
      leaseMs: 30_000,
      heartbeatMs: 10_000,
    });

    const resp = await serverA.get(`/api/orders/${orderId}/results.json`, tokenA);
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-disposition')?.toLowerCase()).toContain('attachment');
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.orderId).toBe(orderId);
    expect(body.validatedCount).toBeDefined();
    expect(Array.isArray(body.results)).toBe(true);
    // results.length === validatedCount
    expect((body.results as unknown[]).length).toBe(body.validatedCount);
    for (const r of body.results as { idx: number; output: Record<string, unknown> }[]) {
      expect(r.idx).toBeDefined();
      expect(r.output).toBeDefined();
    }
  });
});

describe('POST /api/orders/:orderId/cancel', () => {
  it('200 with numeric cancelled and requested fields', async () => {
    const workflowCards = await serverA.getJson('/api/workflows', tokenA);
    const workflows = workflowCards.body.workflows as { workflowId: string }[];
    const workflowId = workflows[0]!.workflowId;
    const submitResp = await serverA.postJson(
      '/api/orders',
      { workflowId, items: ['p', 'q', 'r'] },
      tokenA,
    );
    orderId = submitResp.body.orderId as string;

    const resp = await serverA.postJson(`/api/orders/${orderId}/cancel`, {}, tokenA);
    expect(resp.status).toBe(200);
    expect(typeof resp.body.cancelled).toBe('number');
    expect(typeof resp.body.requested).toBe('number');
  });
});
