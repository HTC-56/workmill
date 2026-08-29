import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb, type TestTenant } from './helpers/db.js';
import { startTestServer, mintTestToken, type TestServer } from './helpers/server.js';
import { provisionTenant } from '../src/tenancy/provision.js';
import { withTenant } from '../src/seam/withTenant.js';
import { seedExampleWorkflows } from '../src/workflows/examples.js';

/**
 * Integration tests for `GET /api/dead`, `POST /api/jobs/:jobId/requeue`,
 * and `GET /api/usage` in `src/server/api.ts` — the dead-letter view,
 * one-shot requeue, and the usage meter.
 *
 * §H7 of TASK_PHASE_H.md.
 *
 * Pattern: `test/api-workflows.test.ts` — its `beforeAll`/`afterAll` shape,
 * its use of `startTestServer` and `mintTestToken`, and its two-tenant setup.
 *
 * Facts from the phase header that matter most:
 *  - No runner and no stub gateway in this file — stamp the dead job by hand.
 *  - A job is only dead with its stamp: the CHECK in sql/005_runner.sql
 *    refuses `state = 'dead'` unless `dead_at` is set, so the fixture UPDATE
 *    under `withAdmin` sets state, dead_at, attempts, and last_error together.
 *  - `GET /api/dead` is tenant-scoped through the asTenant bearer.
 *  - `POST /api/jobs/:jobId/requeue` is 200 once, 404 the second time.
 *  - `GET /api/usage` returns { budget, byDay } with budget carrying
 *    budget, used, remaining, exhausted and byDay an array.
 */

let db: Awaited<ReturnType<typeof freshDb>>;
let tenant1: TestTenant;
let tenant2: TestTenant;
let server: TestServer;
let token1: string;
let token2: string;
let deadJobId: string;

beforeAll(async () => {
  db = await freshDb();

  const p1 = await provisionTenant(db, {
    slug: 'dead-tenant-1',
    name: 'Dead Letter Tenant One',
    ownerEmail: 'owner1@dead.example.com',
  });
  tenant1 = { id: p1.tenantId, slug: 'dead-tenant-1' };

  const p2 = await provisionTenant(db, {
    slug: 'dead-tenant-2',
    name: 'Dead Letter Tenant Two',
    ownerEmail: 'owner2@dead.example.com',
  });
  tenant2 = { id: p2.tenantId, slug: 'dead-tenant-2' };

  token1 = await mintTestToken(db, tenant1.id);
  token2 = await mintTestToken(db, tenant2.id);

  await withTenant(db, tenant1.id, (sql) => seedExampleWorkflows(sql));
  await withTenant(db, tenant2.id, (sql) => seedExampleWorkflows(sql));

  server = await startTestServer(db);
});

afterAll(async () => {
  await server.close();
  await db?.close();
});

// ---------------------------------------------------------------------------
// §H7 — GET /api/dead is empty before anything dies
// ---------------------------------------------------------------------------

describe('/api/dead — empty before death', () => {
  it('GET /api/dead answers 200 with an empty jobs array', async () => {
    const res = await server.getJson('/api/dead', token1);
    expect(res.status).toBe(200);
    expect((res.body as { jobs: unknown[] }).jobs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// §H7 — stamp a dead job by hand and verify the view
// ---------------------------------------------------------------------------

describe('/api/dead — dead letter view after fixture', () => {
  it('stamping a job dead returns it with attempts, lastError, workflowSlug, inputPreview, and failureTrail array', async () => {
    // Submit an order so there is a job to stamp.
    const workflows = (await server.getJson('/api/workflows', token1)).body.workflows as Record<string, unknown>[];
    const submitRes = await server.postJson('/api/orders', {
      workflowId: workflows[0]!.workflowId,
      items: ['stamp me'],
    }, token1);
    expect(submitRes.status).toBe(201);

    const orderId = (submitRes.body as { orderId: string }).orderId;

    // Find the job idx from the order detail.
    const orderDetail = await server.getJson(`/api/orders/${orderId}`, token1);
    expect(orderDetail.status).toBe(200);
    const items = (orderDetail.body as { items: { idx: number }[] }).items;
    const idx = items[0]!.idx;

    // Stamp the job dead via a raw SQL UPDATE (withAdmin).
    await withTenant(db, tenant1.id, (sql) =>
      sql.query(
        `UPDATE jobs
           SET state        = 'dead',
               dead_at      = now(),
               attempts     = 3,
               last_error   = 'model-502',
               failure_trail = jsonb_build_array(
                 jsonb_build_object('attempt', 0, 'at', now(), 'kind', 'error', 'error', '502'),
                 jsonb_build_object('attempt', 1, 'at', now(), 'kind', 'error', 'error', 'timeout'),
                 jsonb_build_object('attempt', 2, 'at', now(), 'kind', 'error', 'error', '502')
               )
         WHERE order_id = $1 AND idx = $2`,
        [orderId, idx],
      ),
    );

    // Verify the job id is returned (we know it since we stamped it).
    const deadRes = await server.getJson('/api/dead', token1);
    expect(deadRes.status).toBe(200);
    const jobs = (deadRes.body as { jobs: Record<string, unknown>[] }).jobs;
    expect(jobs).toHaveLength(1);
    const job = jobs[0]!;

    expect(job.attempts).toBe(3);
    expect(job.lastError).toBe('model-502');
    expect(job.workflowSlug).toBeDefined();
    expect(typeof (job.inputPreview as string)).toBe('string');
    expect(Array.isArray(job.failureTrail)).toBe(true);
    deadJobId = job.jobId as string;
  });
});

// ---------------------------------------------------------------------------
// §H7 — the dead letter is tenant-scoped
// ---------------------------------------------------------------------------

describe('/api/dead — tenant scoping', () => {
  it('tenant 2 sees an empty dead list for tenant 1\'s dead job', async () => {
    const res = await server.getJson('/api/dead', token2);
    expect(res.status).toBe(200);
    expect((res.body as { jobs: unknown[] }).jobs).toHaveLength(0);
  });

  it('tenant 2 requeue on tenant 1\'s dead job is 404', async () => {
    const res = await server.postJson(`/api/jobs/${deadJobId}/requeue`, {}, token2);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// §H7 — requeue is one-shot: 200 then 404
// ---------------------------------------------------------------------------

describe('/api/jobs/:jobId/requeue — one-shot', () => {
  it('first requeue returns 200 with requeued: true', async () => {
    const res = await server.postJson(`/api/jobs/${deadJobId}/requeue`, {}, token1);
    expect(res.status).toBe(200);
    expect((res.body as { requeued: boolean; jobId: string }).requeued).toBe(true);
    expect(res.body.jobId).toBe(deadJobId);
  });

  it('second requeue returns 404 not-requeued', async () => {
    const res = await server.postJson(`/api/jobs/${deadJobId}/requeue`, {}, token1);
    expect(res.status).toBe(404);
    expect((res.body as { error: string }).error).toBe('not-requeued');
  });
});

// ---------------------------------------------------------------------------
// §H7 — after requeue, GET /api/dead is empty again
// ---------------------------------------------------------------------------

describe('/api/dead — empty after requeue', () => {
  it('GET /api/dead returns an empty jobs array after the job was requeued', async () => {
    const res = await server.getJson('/api/dead', token1);
    expect(res.status).toBe(200);
    expect((res.body as { jobs: unknown[] }).jobs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// §H7 — GET /api/usage
// ---------------------------------------------------------------------------

describe('/api/usage — the usage meter', () => {
  it('GET /api/usage is 200 with budget carrying budget, used, remaining, exhausted and a byDay array', async () => {
    const res = await server.getJson('/api/usage', token1);
    expect(res.status).toBe(200);

    const body = res.body as {
      budget: { budget: unknown; used: unknown; remaining: unknown; exhausted: unknown };
      byDay: unknown[];
    };

    expect(body.budget).toBeDefined();
    expect(body.budget.budget).toBeDefined();
    expect(body.budget.used).toBeDefined();
    expect(body.budget.remaining).toBeDefined();
    expect(typeof body.budget.exhausted).toBe('boolean');
    expect(Array.isArray(body.byDay)).toBe(true);

    // A tenant that has run nothing has used === 0.
    expect(body.budget.used).toBe(0);
  });
});
