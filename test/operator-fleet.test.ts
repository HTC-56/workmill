import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Engine } from '../src/db/engine.js';
import {
  probeGateway,
  collectFleet,
} from '../src/operator/fleet.js';
import { withTenant } from '../src/seam/withTenant.js';
import { freshDb, makeTenant } from './helpers/db.js';
import { grantSupportAccess } from '../src/operator/grants.js';

/**
 * The fleet panel: probeGateway (pure over injected fetch) and collectFleet
 * against a migrated database. §I6 of TASK_PHASE_I.md.
 *
 * No HTTP server, no real network.
 */

let db: Engine;

beforeAll(async () => {
  db = await freshDb();
});

afterAll(async () => {
  await db?.close();
});

// ---------------------------------------------------------------------------
// 1. probeGateway(null) — not-configured
// ---------------------------------------------------------------------------

describe('probeGateway — null config', () => {
  it('answers reachable:false, status:null, error:"not-configured"', async () => {
    const result = await probeGateway(null);

    expect(result.reachable).toBe(false);
    expect(result.status).toBeNull();
    expect(result.error).toBe('not-configured');
    expect(result.latencyMs).toBe(0);
    expect(result.baseUrl).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. probeGateway with fetch returning 200 — reachable
// ---------------------------------------------------------------------------

describe('probeGateway — reachable gateway', () => {
  it('returns reachable:true, status:200, numeric latencyMs, echoes baseUrl', async () => {
    const fakeFetch = async () =>
      new Response('{}', { status: 200 });

    const config = {
      baseUrl: 'http://localhost:8080/v1',
      timeoutMs: 100,
      models: {},
    };

    const result = await probeGateway(config, { fetchImpl: fakeFetch });

    expect(result.reachable).toBe(true);
    expect(result.status).toBe(200);
    expect(result.baseUrl).toBe('http://localhost:8080/v1');
    expect(typeof result.latencyMs).toBe('number');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. probeGateway with fetch returning 503 — unreachable
// ---------------------------------------------------------------------------

describe('probeGateway — 503 gateway', () => {
  it('returns reachable:false, error contains "503"', async () => {
    const fakeFetch = async () =>
      new Response('Service Unavailable', { status: 503 });

    const config = {
      baseUrl: 'http://localhost:8080/v1',
      timeoutMs: 100,
      models: {},
    };

    const result = await probeGateway(config, { fetchImpl: fakeFetch });

    expect(result.reachable).toBe(false);
    expect(result.status).toBe(503);
    expect(result.error).toContain('503');
  });
});

// ---------------------------------------------------------------------------
// 4. probeGateway with fetch that throws — never throws itself
// ---------------------------------------------------------------------------

describe('probeGateway — fetch throws', () => {
  it('returns reachable:false, status:null, error carries thrown message', async () => {
    const fakeFetch = async () => {
      throw new TypeError('ENOTFOUND');
    };

    const config = {
      baseUrl: 'http://localhost:8080/v1',
      timeoutMs: 100,
      models: {},
    };

    const result = await probeGateway(config, { fetchImpl: fakeFetch });

    expect(result.reachable).toBe(false);
    expect(result.status).toBeNull();
    expect(result.error).toContain('ENOTFOUND');
  });
});

// ---------------------------------------------------------------------------
// 5. collectFleet on a migrated database with two tenants, no gateway
// ---------------------------------------------------------------------------

describe('collectFleet — no gateway, two tenants', () => {
  it('reports tenants.total:2, suspended:0, withActiveGrant:0, all queue/throughput:0', async () => {
    await Promise.all([
      makeTenant(db, 'fleet-a'),
      makeTenant(db, 'fleet-b'),
    ]);

    const snapshot = await collectFleet(db, { gateway: null });

    expect(snapshot.tenants.total).toBe(2);
    expect(snapshot.tenants.suspended).toBe(0);
    expect(snapshot.tenants.withActiveGrant).toBe(0);

    expect(snapshot.queue.pending).toBe(0);
    expect(snapshot.queue.running).toBe(0);
    expect(snapshot.queue.dead).toBe(0);
    expect(snapshot.queue.oldestPendingSeconds).toBe(0);

    expect(snapshot.throughput.jobsLastHour).toBe(0);
    expect(snapshot.throughput.succeededLastHour).toBe(0);
    expect(snapshot.throughput.failedLastHour).toBe(0);
    expect(snapshot.throughput.tokensToday).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. collectFleet after granting support to one tenant — withActiveGrant:1
// ---------------------------------------------------------------------------

describe('collectFleet — with active grant', () => {
  it('tenants.withActiveGrant is 1 after one support grant', async () => {
    const [tenantA] = await Promise.all([
      makeTenant(db, 'grant-a'),
      makeTenant(db, 'grant-b'),
    ]);

    // Grant support access to tenant A.
    await withTenant(db, tenantA.id, (sql) =>
      grantSupportAccess(sql, {
        reason: 'investigating login issue for tenant A',
        grantedBy: 'ops-bot',
        ttlMs: 3600000,
      }),
    );

    const snapshot = await collectFleet(db, { gateway: null });

    // The earlier test already created 2 tenants, so total is at least 4.
    // The key invariant: exactly one tenant has an active grant.
    expect(snapshot.tenants.withActiveGrant).toBe(1);
  });
});
