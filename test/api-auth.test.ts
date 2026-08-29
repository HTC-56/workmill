import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb, type TestTenant } from './helpers/db.js';
import { startTestServer, mintTestToken, type TestServer } from './helpers/server.js';
import { provisionTenant } from '../src/tenancy/provision.js';
import { withTenant } from '../src/seam/withTenant.js';
import { seedExampleWorkflows } from '../src/workflows/examples.js';

/**
 * Integration tests for the bearer wall on every `/api/*` route, plus
 * `GET /api/me` carrying the tenant's limits and budget.
 *
 * §H4 of TASK_PHASE_H.md.
 *
 * Pattern: `test/server.test.ts` — its `beforeAll`/`afterAll` shape and its
 * use of `startTestServer` are the ones copied here.
 *
 * Facts from the phase header that matter most:
 *  - `provisionTenant` is the right helper (the API reads entitlements and
 *    the budget; a bare tenant has neither).
 *  - `startTestServer` spins up a real listening server.
 *  - `mintTestToken` is the only place the raw bearer token is produced.
 *  - The ops log is written asynchronously — await a tick before reading it.
 */

let db: Awaited<ReturnType<typeof freshDb>>;
let tenant: TestTenant;
let server: TestServer;
let tenantToken: string;

const DAILY_BUDGET = 1_000;

beforeAll(async () => {
  db = await freshDb();
  const provisioned = await provisionTenant(db, {
    slug: 'api-auth',
    name: 'API Auth Tenant',
    ownerEmail: 'owner@api-auth.example.com',
    entitlements: { dailyTokenBudget: DAILY_BUDGET },
  });
  tenant = { id: provisioned.tenantId, slug: 'api-auth' };
  tenantToken = await mintTestToken(db, tenant.id);

  // Seed example workflows so the server has data to return.
  await withTenant(db, tenant.id, (sql) => seedExampleWorkflows(sql));

  // No operator token — the API routes are guarded by the tenant bearer only.
  server = await startTestServer(db);
});

afterAll(async () => {
  await server.close();
  await db?.close();
});

// ---------------------------------------------------------------------------
// §H4 — no bearer → 401 on every API route
// ---------------------------------------------------------------------------

describe('/api/* — no bearer answers 401', () => {
  const routes = [
    { method: 'GET', path: '/api/me' },
    { method: 'GET', path: '/api/workflows' },
    { method: 'GET', path: '/api/orders' },
    { method: 'GET', path: '/api/dead' },
    { method: 'GET', path: '/api/usage' },
    { method: 'POST', path: '/api/orders' },
  ];

  for (const { method, path } of routes) {
    it(`${method} ${path} without a bearer answers 401`, async () => {
      const res =
        method === 'POST'
          ? await server.post(path, { workflowId: '00000000-0000-0000-0000-000000000000', items: ['x'] })
          : await server.get(path);
      expect(res.status).toBe(401);
    });
  }
});

// ---------------------------------------------------------------------------
// §H4 — the 401 carries WWW-Authenticate
// ---------------------------------------------------------------------------

describe('/api/* — 401 includes WWW-Authenticate', () => {
  it('GET /api/me without a bearer carries WWW-Authenticate: Bearer', async () => {
    const res = await server.get('/api/me');
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer');
  });
});

// ---------------------------------------------------------------------------
// §H4 — a made-up bearer is the same 401
// ---------------------------------------------------------------------------

describe('/api/* — wrong bearer answers 401', () => {
  it('a made-up bearer is indistinguishable from no bearer', async () => {
    const res = await server.get('/api/me', 'totally-real-token');
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// §H4 — /api/me with a real token carries tenantId, slug, limits, budget
// ---------------------------------------------------------------------------

describe('/api/me — authenticated response', () => {
  it('GET /api/me with a real bearer answers 200 with tenantId, slug, limits, and budget', async () => {
    const res = await server.getJson('/api/me', tenantToken);
    expect(res.status).toBe(200);
    const apiMeBody = res.body as Record<string, unknown>;
    expect(apiMeBody.tenantId).toBe(tenant.id);
    expect(apiMeBody.slug).toBe(tenant.slug);
    const limits = apiMeBody.limits as Record<string, unknown>;
    expect(limits).toEqual({
      dailyTokenBudget: DAILY_BUDGET,
      maxConcurrentJobs: 4,
      maxItemsPerOrder: 100,
      maxItemChars: 4_000,
      allowedModels: ['default'],
    });
    const budget = apiMeBody.budget as Record<string, unknown>;
    expect(budget.used).toBe(0);
    expect(budget.exhausted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §H4 — the ops ledger records the request
// ---------------------------------------------------------------------------

describe('/api/me — ops log records the route', () => {
  it('a request to /api/me produces an ops-log record with kind request, path /api/me, status and numeric ms', async () => {
    await server.getJson('/api/me', tenantToken);

    // The ops log is written asynchronously.
    await new Promise((r) => setTimeout(r, 50));

    const recs = (server.opsLog as { records: () => Record<string, unknown>[] }).records();
    const last = recs[recs.length - 1];
    expect(last?.kind).toBe('request');
    expect(last?.path).toBe('/api/me');
    expect(last?.status).toBe(200);
    expect(typeof last?.ms).toBe('number');
  });
});
