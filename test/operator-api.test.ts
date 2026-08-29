import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb, type TestTenant } from './helpers/db.js';
import { startTestServer, mintTestToken, type TestServer } from './helpers/server.js';
import { provisionTenant } from '../src/tenancy/provision.js';

/**
 * Integration tests for the operator bearer wall, the tenant table, and the
 * provision form — `GET /api/operator/tenants`, `POST /api/operator/tenants`,
 * and `GET /api/operator/fleet` in `src/server/operator-api.ts`.
 *
 * §I7 of TASK_PHASE_I.md.
 *
 * Pattern: `test/api-auth.test.ts` — its `beforeAll`/`afterAll` shape and its
 * use of `startTestServer` are the ones copied here.
 *
 * Facts from the phase header that matter most:
 *  - A server without `operatorToken` answers 503, not 401.
 *  - The tenant's own bearer is also 401 on operator routes.
 *  - Every write is a POST.
 *  - The refusal codes are the assertion: 400 = bad body, 404 = unknown tenant,
 *    409 = slug taken, 422 = grant rules refused.
 */

let db: Awaited<ReturnType<typeof freshDb>>;
let tenant: TestTenant;
let server: TestServer;
let tenantToken: string;
let operatorToken: string;

beforeAll(async () => {
  db = await freshDb();
  const provisioned = await provisionTenant(db, {
    slug: 'operator-api',
    name: 'Operator API Tenant',
    ownerEmail: 'owner@operator-api.example.com',
  });
  tenant = { id: provisioned.tenantId, slug: 'operator-api' };
  tenantToken = await mintTestToken(db, tenant.id);
  // 32-character hex token is long enough for the operator check.
  operatorToken = '0'.repeat(32);
  server = await startTestServer(db, { operatorToken });
});

afterAll(async () => {
  await server.close();
  await db?.close();
});

// ---------------------------------------------------------------------------
// §I7 — no bearer → 401 on every operator route
// ---------------------------------------------------------------------------

describe('/api/operator/* — no bearer answers 401', () => {
  const routes = [
    { method: 'GET', path: '/api/operator/tenants' },
    { method: 'GET', path: '/api/operator/fleet' },
  ];

  for (const { method, path } of routes) {
    it(`${method} ${path} without a bearer answers 401`, async () => {
      const res =
        method === 'POST'
          ? await server.post(path, {})
          : await server.get(path);
      expect(res.status).toBe(401);
    });
  }
});

// ---------------------------------------------------------------------------
// §I7 — the 401 carries WWW-Authenticate
// ---------------------------------------------------------------------------

describe('/api/operator/* — 401 includes WWW-Authenticate', () => {
  it('GET /api/operator/tenants without a bearer carries WWW-Authenticate: Bearer', async () => {
    const res = await server.get('/api/operator/tenants');
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer');
  });

  it('GET /api/operator/fleet without a bearer carries WWW-Authenticate: Bearer', async () => {
    const res = await server.get('/api/operator/fleet');
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer');
  });
});

// ---------------------------------------------------------------------------
// §I7 — a made-up bearer is the same 401
// ---------------------------------------------------------------------------

describe('/api/operator/* — wrong bearer answers 401', () => {
  it('a made-up bearer on GET /api/operator/tenants is the same 401', async () => {
    const res = await server.get('/api/operator/tenants', 'totally-real-token');
    expect(res.status).toBe(401);
  });

  it('a made-up bearer on GET /api/operator/fleet is the same 401', async () => {
    const res = await server.get('/api/operator/fleet', 'totally-real-token');
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// §I7 — the tenant's own bearer is also 401
// ---------------------------------------------------------------------------

describe('/api/operator/* — tenant bearer is 401', () => {
  it('GET /api/operator/tenants with the tenant bearer answers 401', async () => {
    const res = await server.get('/api/operator/tenants', tenantToken);
    expect(res.status).toBe(401);
  });

  it('GET /api/operator/fleet with the tenant bearer answers 401', async () => {
    const res = await server.get('/api/operator/fleet', tenantToken);
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// §I7 — no operator token configured → 503
// ---------------------------------------------------------------------------

describe('/api/operator/* — unconfigured server answers 503', () => {
  it('a server without operatorToken answers 503 on GET /api/operator/tenants', async () => {
    const deadServer = await startTestServer(db);
    try {
      // Even a correct-looking bearer doesn't help — 503, not 401.
      const res = await deadServer.getJson(
        '/api/operator/tenants',
        operatorToken,
      );
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('operator-api-disabled');
    } finally {
      await deadServer.close();
    }
  });
});

// ---------------------------------------------------------------------------
// §I7 — operator bearer sees the tenant table
// ---------------------------------------------------------------------------

describe('/api/operator/tenants — operator bearer answers 200', () => {
  it('GET /api/operator/tenants with the operator bearer is 200 with a tenants array', async () => {
    const res = await server.getJson('/api/operator/tenants', operatorToken);
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    const tenants = body.tenants as unknown[];
    expect(Array.isArray(tenants)).toBe(true);
    expect(tenants.length).toBeGreaterThanOrEqual(1);
    const first = tenants[0] as Record<string, unknown>;
    expect(typeof first.slug).toBe('string');
    expect(typeof first.state).toBe('string');
    const limits = first.limits as Record<string, unknown> | undefined;
    // Limits may be undefined for a bare tenant (no entitlements row).
    if (limits) {
      expect(typeof limits).toBe('object');
    }
  });
});

// ---------------------------------------------------------------------------
// §I7 — POST /api/operator/tenants provisions a new tenant
// ---------------------------------------------------------------------------

describe('/api/operator/tenants — provision', () => {
  it('POST with slug/name/ownerEmail is 201 with a tenantId', async () => {
    const res = await server.postJson(
      '/api/operator/tenants',
      {
        slug: 'operator-api-new',
        name: 'New Operator Tenant',
        ownerEmail: 'new@operator-api.example.com',
      },
      operatorToken,
    );
    expect(res.status).toBe(201);
    expect(typeof res.body.tenantId).toBe('string');
    expect(res.body.slug).toBe('operator-api-new');
  });
});

// ---------------------------------------------------------------------------
// §I7 — duplicate slug → 409
// ---------------------------------------------------------------------------

describe('/api/operator/tenants — duplicate slug', () => {
  it('POST with the same slug again is 409 slug-taken', async () => {
    const res = await server.postJson(
      '/api/operator/tenants',
      {
        slug: 'operator-api',
        name: 'Duplicate',
        ownerEmail: 'dup@operator-api.example.com',
      },
      operatorToken,
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('slug-taken');
    expect(res.body.slug).toBe('operator-api');
  });
});

// ---------------------------------------------------------------------------
// §I7 — invalid slug → 400
// ---------------------------------------------------------------------------

describe('/api/operator/tenants — invalid slug', () => {
  it('POST with a slug that is too short is 400', async () => {
    const res = await server.postJson(
      '/api/operator/tenants',
      {
        slug: 'NO',
        name: 'Bad Slug',
        ownerEmail: 'bad@operator-api.example.com',
      },
      operatorToken,
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad-request');
  });
});

// ---------------------------------------------------------------------------
// §I7 — provision starts the audit trail
// ---------------------------------------------------------------------------

describe('/api/operator/tenants/:id/audit — trail starts with provision', () => {
  it('GET /api/operator/tenants/<new-id>/audit is 200 with tenant.provisioned as the first action', async () => {
    // Provision a fresh tenant to read its audit trail.
    const newRes = await server.postJson(
      '/api/operator/tenants',
      {
        slug: 'operator-api-audit',
        name: 'Audit Trail Tenant',
        ownerEmail: 'audit@operator-api.example.com',
      },
      operatorToken,
    );
    expect(newRes.status).toBe(201);
    const newTenantId = newRes.body.tenantId as string;

    const auditRes = await server.getJson(
      `/api/operator/tenants/${newTenantId}/audit`,
      operatorToken,
    );
    expect(auditRes.status).toBe(200);
    const auditBody = auditRes.body as Record<string, unknown>;
    const entries = auditBody.entries as unknown[];
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const first = entries[0] as Record<string, unknown>;
    expect(first.action).toBe('tenant.provisioned');
  });
});

// ---------------------------------------------------------------------------
// §I7 — unknown/malformed tenant id → 404
// ---------------------------------------------------------------------------

describe('/api/operator/tenants/:id/audit — 404 on bad tenant ids', () => {
  it('GET /api/operator/tenants/not-a-uuid/audit is 404 no-such-tenant', async () => {
    const res = await server.getJson(
      '/api/operator/tenants/not-a-uuid/audit',
      operatorToken,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('no-such-tenant');
  });

  it('GET /api/operator/tenants/<valid-uuid-no-tenant>/audit is 404 no-such-tenant', async () => {
    const res = await server.getJson(
      '/api/operator/tenants/00000000-0000-4000-8000-000000000000/audit',
      operatorToken,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('no-such-tenant');
  });
});
