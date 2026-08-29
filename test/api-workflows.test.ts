import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb, type TestTenant } from './helpers/db.js';
import { startTestServer, mintTestToken, type TestServer } from './helpers/server.js';
import { provisionTenant } from '../src/tenancy/provision.js';
import { withTenant } from '../src/seam/withTenant.js';
import { seedExampleWorkflows } from '../src/workflows/examples.js';

/**
 * Integration tests for `GET /api/workflows` and `POST /api/orders` in
 * `src/server/api.ts` — the workflow list and the submit path.
 *
 * §H5 of TASK_PHASE_H.md.
 *
 * Pattern: `test/api-auth.test.ts` — its `beforeAll`/`afterAll` shape, its
 * use of `startTestServer` and `mintTestToken`, and its setup style.
 *
 * Facts from the phase header that matter most:
 *  - Two tenants are provisioned; example workflows are seeded into both.
 *  - `GET /api/workflows` returns three cards ordered by `slug`.
 *  - `POST /api/orders` with `{ workflowId, items }` answers 201.
 *  - Three malformed-body cases (no workflowId, empty items, non-string item)
 *    each answer 400.
 *  - Cross-tenant submit is 404 no-such-workflow (RLS hides it), not 403.
 *  - A tenant provisioned with `maxItemsPerOrder: 2` gets 422
 *    `too-many-items` for a three-item order — refusal is the entitlement's,
 *    not the route's.
 */

let db: Awaited<ReturnType<typeof freshDb>>;
let tenant1: TestTenant;
let tenant2: TestTenant;
let server: TestServer;
let token1: string;
let token2: string;

beforeAll(async () => {
  db = await freshDb();

  // Tenant 1: default entitlements (maxItemsPerOrder: 100).
  const p1 = await provisionTenant(db, {
    slug: 'wf-tenant-1',
    name: 'Workflow Tenant One',
    ownerEmail: 'owner1@api-wf.example.com',
  });
  tenant1 = { id: p1.tenantId, slug: 'wf-tenant-1' };

  // Tenant 2: tight item cap so we can exercise the 422 path.
  const p2 = await provisionTenant(db, {
    slug: 'wf-tenant-2',
    name: 'Workflow Tenant Two',
    ownerEmail: 'owner2@api-wf.example.com',
    entitlements: { maxItemsPerOrder: 2 },
  });
  tenant2 = { id: p2.tenantId, slug: 'wf-tenant-2' };

  token1 = await mintTestToken(db, tenant1.id);
  token2 = await mintTestToken(db, tenant2.id);

  // Seed example workflows into both tenants.
  await withTenant(db, tenant1.id, (sql) => seedExampleWorkflows(sql));
  await withTenant(db, tenant2.id, (sql) => seedExampleWorkflows(sql));

  server = await startTestServer(db);
});

afterAll(async () => {
  await server.close();
  await db?.close();
});

// ---------------------------------------------------------------------------
// §H5 — GET /api/workflows returns three cards ordered by slug
// ---------------------------------------------------------------------------

describe('/api/workflows — list returns three cards', () => {
  it('GET /api/workflows answers 200 with three workflow cards', async () => {
    const res = await server.getJson('/api/workflows', token1);
    expect(res.status).toBe(200);
    const workflows = res.body.workflows as unknown[];
    expect(workflows).toHaveLength(3);
  });

  it('each card has version 1, a versionId, a model and an outputSchema object', async () => {
    const res = await server.getJson('/api/workflows', token1);
    const workflows = res.body.workflows as Record<string, unknown>[];
    for (const wf of workflows) {
      expect(wf.version).toBe(1);
      expect(wf.versionId).toBeDefined();
      expect(typeof wf.versionId).toBe('string');
      expect(wf.model).toBeDefined();
      expect(typeof wf.model).toBe('string');
      expect(wf.outputSchema).toBeInstanceOf(Object);
    }
  });

  it('cards are ordered by slug: extract, classify, summarize', async () => {
    const res = await server.getJson('/api/workflows', token1);
    const workflows = res.body.workflows as Record<string, unknown>[];
    const slugs = workflows.map((wf) => wf.slug);
    expect(slugs).toEqual(['classify', 'extract', 'summarize']);
  });
});

// ---------------------------------------------------------------------------
// §H5 — a token sees only its own workflows (disjoint ids)
// ---------------------------------------------------------------------------

describe('/api/workflows — per-tenant isolation', () => {
  it('tenant 1 and tenant 2 see disjoint card ids', async () => {
    const res1 = await server.getJson('/api/workflows', token1);
    const res2 = await server.getJson('/api/workflows', token2);

    const ids1 = new Set((res1.body.workflows as Record<string, unknown>[]).map((wf) => wf.workflowId));
    const ids2 = (res2.body.workflows as Record<string, unknown>[]).map((wf) => wf.workflowId);

    for (const id of ids2) {
      expect(ids1.has(id)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// §H5 — POST /api/orders with a valid body answers 201
// ---------------------------------------------------------------------------

describe('/api/orders — submit', () => {
  it('POST /api/orders with { workflowId, items: ["a","b","c"] } answers 201 with itemCount 3 and version 1', async () => {
    const workflows = (await server.getJson('/api/workflows', token1)).body.workflows as Record<string, unknown>[];
    const workflowId = workflows[0]!.workflowId;
    const res = await server.postJson('/api/orders', {
      workflowId,
      items: ['a', 'b', 'c'],
    }, token1);
    expect(res.status).toBe(201);
    expect(res.body.itemCount).toBe(3);
    expect(res.body.version).toBe(1);
    expect(res.body.orderId).toBeDefined();
    expect(res.body.workflowVersionId).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// §H5 — malformed body is 400 (three separate cases)
// ---------------------------------------------------------------------------

describe('/api/orders — malformed body answers 400', () => {
  it('missing workflowId answers 400', async () => {
    const res = await server.postJson('/api/orders', { items: ['a'] }, token1);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad-request');
  });

  it('empty items array answers 400', async () => {
    const workflows = (await server.getJson('/api/workflows', token1)).body.workflows as Record<string, unknown>[];
    const res = await server.postJson('/api/orders', { workflowId: workflows[0]!.workflowId, items: [] }, token1);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad-request');
  });

  it('items array holding a number answers 400', async () => {
    const workflows = (await server.getJson('/api/workflows', token1)).body.workflows as Record<string, unknown>[];
    const res = await server.postJson('/api/orders', { workflowId: workflows[0]!.workflowId, items: [42] }, token1);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad-request');
  });
});

// ---------------------------------------------------------------------------
// §H5 — cross-tenant submit is 404 no-such-workflow
// ---------------------------------------------------------------------------

describe('/api/orders — cross-tenant submit', () => {
  it('tenant 2 submitting tenant 1\'s workflowId gets 404 no-such-workflow', async () => {
    const workflows = (await server.getJson('/api/workflows', token1)).body.workflows as Record<string, unknown>[];
    const res = await server.postJson('/api/orders', {
      workflowId: workflows[0]!.workflowId,
      items: ['a', 'b'],
    }, token2);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('no-such-workflow');
  });
});

// ---------------------------------------------------------------------------
// §H5 — maxItemsPerOrder: 2 → three items is 422 too-many-items
// ---------------------------------------------------------------------------

describe('/api/orders — entitlement cap', () => {
  it('tenant 2 with maxItemsPerOrder: 2 submitting three items gets 422 too-many-items', async () => {
    const workflows = (await server.getJson('/api/workflows', token2)).body.workflows as Record<string, unknown>[];
    const res = await server.postJson('/api/orders', {
      workflowId: workflows[0]!.workflowId,
      items: ['a', 'b', 'c'],
    }, token2);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('entitlement-refused');
    expect(res.body.reason).toBe('too-many-items');
  });
});
