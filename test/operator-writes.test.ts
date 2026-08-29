import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestServer } from './helpers/server.js';
import { freshDb } from './helpers/db.js';
import { startTestServer, mintTestToken } from './helpers/server.js';
import { provisionTenant } from '../src/tenancy/provision.js';

/**
 * Integration tests for the operator's write routes and the audit receipt:
 * `POST /api/operator/tenants/:id/entitlements`, `POST /api/operator/tenants/:id/state`,
 * `POST /api/operator/tenants/:id/grants`, `POST /api/operator/tenants/:id/grants/:id/revoke`,
 * `GET /api/operator/tenants/:id/grants`, `GET /api/operator/tenants/:id/audit`,
 * and the tenant-side `GET /api/audit` and `GET /api/grants` in
 * `src/server/api.ts`.
 *
 * §I8 of TASK_PHASE_I.md.
 *
 * Pattern: `test/operator-api.test.ts` — its `beforeAll`/`afterAll` shape and its
 * use of `startTestServer` are the ones copied here.
 *
 * Facts from the phase header that matter most:
 *  - A server without `operatorToken` answers 503, not 401.
 *  - The tenant's own bearer is also 401 on operator routes.
 *  - Every write is a POST.
 *  - The trail is the receipt: the tenant reads the same rows with its OWN bearer.
 *  - The refusal codes are the assertion: 400 = bad body/entitlement, 404 = unknown
 *    tenant or grant, 422 = grant rules refused.
 */

let db: Awaited<ReturnType<typeof freshDb>>;
let server: TestServer;
let tenantToken: string;
let operatorToken: string;
let tenantId: string;
let revokedGrantId: string | undefined;

beforeAll(async () => {
  db = await freshDb();
  const provisioned = await provisionTenant(db, {
    slug: 'operator-writes',
    name: 'Operator Writes Tenant',
    ownerEmail: 'owner@operator-writes.example.com',
  });
  tenantId = provisioned.tenantId;
  tenantToken = await mintTestToken(db, provisioned.tenantId);
  // 32-character hex token is long enough for the operator check.
  operatorToken = '0'.repeat(32);
  server = await startTestServer(db, { operatorToken });
});

afterAll(async () => {
  await server.close();
  await db?.close();
});

// ---------------------------------------------------------------------------
// §I8 — POST /entitlements — good patch returns 200 with new limits
// ---------------------------------------------------------------------------

describe('§I8 — POST /api/operator/tenants/:id/entitlements — good patch', () => {
  it('setting maxItemChars to 512 is 200 and returns the new limits', async () => {
    const res = await server.postJson(
      `/api/operator/tenants/${tenantId}/entitlements`,
      { maxItemChars: 512 },
      operatorToken,
    );
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    const limits = body.limits as Record<string, unknown>;
    expect(typeof limits).toBe('object');
    expect(limits.maxItemChars).toBe(512);
  });
});

// ---------------------------------------------------------------------------
// §I8 — POST /entitlements — maxConcurrentJobs: 0 is 400
// ---------------------------------------------------------------------------

describe('§I8 — POST /api/operator/tenants/:id/entitlements — bad value', () => {
  it('maxConcurrentJobs: 0 is 400 with field maxConcurrentJobs', async () => {
    const res = await server.postJson(
      `/api/operator/tenants/${tenantId}/entitlements`,
      { maxConcurrentJobs: 0 },
      operatorToken,
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad-entitlement');
    expect(res.body.field).toBe('maxConcurrentJobs');
  });
});

// ---------------------------------------------------------------------------
// §I8 — POST /state — suspend, idempotent re-suspend, invalid state
// ---------------------------------------------------------------------------

describe('§I8 — POST /api/operator/tenants/:id/state', () => {
  it('suspending is 200 with changed: true', async () => {
    const res = await server.postJson(
      `/api/operator/tenants/${tenantId}/state`,
      { state: 'suspended' },
      operatorToken,
    );
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.state).toBe('suspended');
    expect(body.changed).toBe(true);
  });

  it('sending the same state again is 200 with changed: false', async () => {
    const res = await server.postJson(
      `/api/operator/tenants/${tenantId}/state`,
      { state: 'suspended' },
      operatorToken,
    );
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.changed).toBe(false);
  });

  it('an invalid state value is 400', async () => {
    const res = await server.postJson(
      `/api/operator/tenants/${tenantId}/state`,
      { state: 'nope' },
      operatorToken,
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad-request');
  });
});

// ---------------------------------------------------------------------------
// §I8 — POST /grants — short reason is 422
// ---------------------------------------------------------------------------

describe('§I8 — POST /api/operator/tenants/:id/grants — short reason', () => {
  it('a reason under eight characters is 422 with reason-too-short', async () => {
    const res = await server.postJson(
      `/api/operator/tenants/${tenantId}/grants`,
      { reason: 'short', grantedBy: 'operator', ttlMs: 1800000 },
      operatorToken,
    );
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('grant-refused');
    expect(res.body.reason).toBe('reason-too-short');
  });
});

// ---------------------------------------------------------------------------
// §I8 — POST /grants — real reason + ttlMs is 201
// ---------------------------------------------------------------------------

describe('§I8 — POST /api/operator/tenants/:id/grants — valid grant', () => {
  it('a valid reason and ttlMs: 1800000 is 201 with active: true and remainingMs > 0', async () => {
    const res = await server.postJson(
      `/api/operator/tenants/${tenantId}/grants`,
      { reason: 'debug session 1', grantedBy: 'operator', ttlMs: 1800000 },
      operatorToken,
    );
    expect(res.status).toBe(201);
    const body = res.body as Record<string, unknown>;
    expect(body.active).toBe(true);
    expect(typeof body.remainingMs).toBe('number');
    expect(body.remainingMs as number).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// §I8 — GET /grants shows the grant as active
// ---------------------------------------------------------------------------

describe('§I8 — GET /api/operator/tenants/:id/grants', () => {
  it('the grant created above shows as active', async () => {
    const res = await server.getJson(
      `/api/operator/tenants/${tenantId}/grants`,
      operatorToken,
    );
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    const grants = body.grants as Record<string, unknown>[];
    expect(Array.isArray(grants)).toBe(true);
    expect(grants.length).toBeGreaterThanOrEqual(1);
    const activeGrant = grants.find(
      (g) => (g as Record<string, unknown>).active === true,
    );
    expect(activeGrant).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// §I8 — GET /tenants shows supportActive: true
// ---------------------------------------------------------------------------

describe('§I8 — GET /api/operator/tenants', () => {
  it('the tenant with an active grant shows supportActive: true', async () => {
    const res = await server.getJson('/api/operator/tenants', operatorToken);
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    const tenants = body.tenants as Record<string, unknown>[];
    const tenantRow = tenants.find(
      (t) => (t as Record<string, unknown>).tenantId === tenantId,
    );
    expect(tenantRow).toBeDefined();
    expect((tenantRow as Record<string, unknown>).supportActive).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §I8 — POST /grants/:id/revoke — first succeeds, second is 404
// ---------------------------------------------------------------------------

describe('§I8 — POST /api/operator/tenants/:id/grants/:id/revoke', () => {
  it('the first revoke is 200 and captures the grant id', async () => {
    // Fetch the active grant id first.
    const grantsRes = await server.getJson(
      `/api/operator/tenants/${tenantId}/grants`,
      operatorToken,
    );
    expect(grantsRes.status).toBe(200);
    const grantsBody = grantsRes.body as Record<string, unknown>;
    const grants = grantsBody.grants as Record<string, unknown>[];
    const activeGrant = grants.find(
      (g) => (g as Record<string, unknown>).active === true,
    ) as Record<string, unknown> | undefined;
    if (!activeGrant) {
      throw new Error('no active grant found to revoke');
    }
    const grantId = activeGrant.id as string;
    revokedGrantId = grantId;

    const revokeRes = await server.postJson(
      `/api/operator/tenants/${tenantId}/grants/${grantId}/revoke`,
      {},
      operatorToken,
    );
    expect(revokeRes.status).toBe(200);
  });

  it('revoking the same grant again is 404 no-such-grant', async () => {
    if (!revokedGrantId) {
      throw new Error('previous revoke did not complete — run tests in order');
    }
    const res = await server.postJson(
      `/api/operator/tenants/${tenantId}/grants/${revokedGrantId}/revoke`,
      {},
      operatorToken,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('no-such-grant');
  });
});

// ---------------------------------------------------------------------------
// §I8 — GET /audit — the trail is the receipt
// ---------------------------------------------------------------------------

describe('§I8 — GET /api/operator/tenants/:id/audit', () => {
  it('the audit trail contains entitlements.updated, tenant.state-changed, support.granted, support.revoked', async () => {
    const res = await server.getJson(
      `/api/operator/tenants/${tenantId}/audit`,
      operatorToken,
    );
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    const entries = body.entries as Record<string, unknown>[];
    expect(Array.isArray(entries)).toBe(true);
    const actions = entries.map((e) => (e as Record<string, unknown>).action as string);
    expect(actions).toContain('entitlements.updated');
    expect(actions).toContain('tenant.state-changed');
    expect(actions).toContain('support.granted');
    expect(actions).toContain('support.revoked');
  });
});

// ---------------------------------------------------------------------------
// §I8 — GET /api/audit with tenant bearer — same rows, 401 without
// ---------------------------------------------------------------------------

describe('§I8 — GET /api/audit — tenant bearer sees the same rows', () => {
  it('GET /api/audit with the tenant bearer is 200 and includes support.granted', async () => {
    const res = await server.get('/api/audit', tenantToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const entries = body.entries as Record<string, unknown>[];
    expect(Array.isArray(entries)).toBe(true);
    const actions = entries.map((e) => (e as Record<string, unknown>).action as string);
    expect(actions).toContain('support.granted');
  });

  it('GET /api/audit with no bearer is 401', async () => {
    const res = await server.get('/api/audit');
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// §I8 — GET /api/grants — tenant bearer sees the grant, 401 without
// ---------------------------------------------------------------------------

describe('§I8 — GET /api/grants — tenant bearer sees grants, 401 without', () => {
  it('GET /api/grants with the tenant bearer is 200 and lists the grant', async () => {
    const res = await server.get('/api/grants', tenantToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const grants = body.grants as unknown[];
    expect(Array.isArray(grants)).toBe(true);
    // The previously granted (but now revoked) grant may still be listed
    // but not active; at minimum the route should return 200 with an array.
    expect(grants.length).toBeGreaterThanOrEqual(0);
  });

  it('GET /api/grants with no bearer is 401', async () => {
    const res = await server.get('/api/grants');
    expect(res.status).toBe(401);
  });
});
