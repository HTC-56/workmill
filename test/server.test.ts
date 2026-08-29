import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MemoryOpsLog } from '../src/ops/opslog.js';
import { freshDb, makeTenant, type TestTenant } from './helpers/db.js';
import { startTestServer, mintTestToken, type TestServer } from './helpers/server.js';

/**
 * Integration tests for the HTTP surface in `src/server/app.ts`.
 *
 * §G8 of TASK_PHASE_G.md.
 *
 * Two servers are spun up so we can assert both the guarded and unguarded
 * modes of `/metrics`: one with an operator token, one without. The guarded
 * server also serves `/healthz` and the catch-all 404.
 *
 * No model calls, no runner — just the HTTP routes and their auth gates.
 */

let db: Awaited<ReturnType<typeof freshDb>>;
let tenant: TestTenant;
let server: TestServer;
let operatorToken: string;
let tenantToken: string;

const OPERATOR = 'operator-token-for-testing-only';

beforeAll(async () => {
  db = await freshDb();
  tenant = await makeTenant(db, 'server');
  // Mint a tenant bearer so we can exercise the "wrong bearer on /metrics" path.
  tenantToken = await mintTestToken(db, tenant.id);

  // Operator token is set in the guarded server; the second server gets none.
  operatorToken = OPERATOR;
  server = await startTestServer(db, { operatorToken });
});

afterAll(async () => {
  await server.close();
  await db?.close();
});

/** Clear the in-memory ops log so per-test counts are exact. */
function clearOpsLog() {
  const log = server.opsLog as MemoryOpsLog;
  log.lines.length = 0;
}

// ---------------------------------------------------------------------------
// §G8 — /healthz
// ---------------------------------------------------------------------------

describe('/healthz', () => {
  it('GET /healthz with no bearer answers 200 with status ok, database up, engine matching db.kind', async () => {
    const res = await server.get('/healthz');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body.database).toBe('up');
    expect(body.engine).toBe(db.kind);
  });
});

// ---------------------------------------------------------------------------
// §G8 — /metrics operator guard
// ---------------------------------------------------------------------------

describe('/metrics — operator guard', () => {
  beforeEach(clearOpsLog);

  it('no bearer answers 401', async () => {
    const res = await server.get('/metrics');
    expect(res.status).toBe(401);
  });

  it('a wrong bearer answers 401', async () => {
    const res = await server.get('/metrics', 'wrong-token');
    expect(res.status).toBe(401);
  });

  it('the operator bearer answers 200', async () => {
    const res = await server.get('/metrics', operatorToken);
    expect(res.status).toBe(200);
  });

  it('the 200 body has content-type text/plain and contains workmill_up 1', async () => {
    const res = await server.get('/metrics', operatorToken);
    expect(res.status).toBe(200);
    const contentType = res.headers.get('content-type') ?? '';
    expect(contentType).toContain('text/plain');
    const body = await res.text();
    expect(body).toContain('workmill_up 1');
  });
});

// ---------------------------------------------------------------------------
// §G8 — missing secret means 503, never unguarded
// ---------------------------------------------------------------------------

describe('/metrics — missing operator token → 503', () => {
  let unguarded: TestServer;

  beforeAll(async () => {
    // Second server with NO operator token at all.
    unguarded = await startTestServer(db);
  });

  afterAll(async () => {
    await unguarded.close();
  });

  it('no bearer answers 503', async () => {
    const res = await unguarded.get('/metrics');
    expect(res.status).toBe(503);
  });

  it('any bearer answers 503', async () => {
    const res = await unguarded.get('/metrics', operatorToken);
    expect(res.status).toBe(503);
  });

  it('a tenant bearer also answers 503', async () => {
    const res = await unguarded.get('/metrics', tenantToken);
    expect(res.status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// §G8 — 404
// ---------------------------------------------------------------------------

describe('unknown path → 404', () => {
  beforeEach(clearOpsLog);

  it('an unknown path answers 404 with a JSON error field', async () => {
    const res = await server.get('/nonexistent');
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('not-found');
  });
});

// ---------------------------------------------------------------------------
// §G8 — ops log records every request
// ---------------------------------------------------------------------------

describe('ops log records every request', () => {
  beforeEach(clearOpsLog);

  it('every request produces one ops-log record with kind request, status and numeric ms', async () => {
    // Fire a small set of requests.
    await server.get('/healthz');
    await server.get('/metrics'); // no bearer → 401
    await server.get('/metrics', operatorToken); // → 200
    await server.get('/nonexistent'); // → 404

    const recs = (server.opsLog as MemoryOpsLog).records();
    expect(recs).toHaveLength(4);

    for (const rec of recs) {
      expect(rec.kind).toBe('request');
      expect(typeof rec.status).toBe('number');
      expect(typeof rec.ms).toBe('number');
    }

    // Spot-check specific statuses.
    expect(recs[0]!.status).toBe(200); // /healthz
    expect(recs[1]!.status).toBe(401); // /metrics no bearer
    expect(recs[2]!.status).toBe(200); // /metrics operator
    expect(recs[3]!.status).toBe(404); // 404
  });
});
