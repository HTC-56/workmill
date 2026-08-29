import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb, makeTenant } from './helpers/db.js';
import { startTestServer, type TestServer } from './helpers/server.js';
import { CONSOLE_CSP, OPERATOR_TOKEN_STORAGE_KEY } from '../src/console/page.js';

/**
 * Integration + string tests for `GET /operator` in `src/server/app.ts` and the
 * console document itself.
 *
 * §I9 of TASK_PHASE_I.md.
 *
 * Pattern: `test/page.test.ts` — its `beforeAll`/`afterAll` shape, its
 * use of `startTestServer` and its assertion style.
 *
 * Facts from the phase header that matter most:
 *  - `GET /operator` needs no bearer and carries the CSP.
 *  - The document contains no external resource references.
 *  - The body contains the six panel ids and the OPERATOR_TOKEN_STORAGE_KEY string.
 *  - `GET /` is still the tenant dashboard and is a different document.
 *  - An unknown path is still the JSON 404.
 */

let db: Awaited<ReturnType<typeof freshDb>>;
let server: TestServer;

beforeAll(async () => {
  db = await freshDb();
  await makeTenant(db, 'console');
  server = await startTestServer(db);
});

afterAll(async () => {
  await server.close();
  await db?.close();
});

// ---------------------------------------------------------------------------
// §I9 — GET /operator answers 200, text/html, doctype
// ---------------------------------------------------------------------------

describe('GET /operator — the operator console', () => {
  it('GET /operator answers 200, content-type text/html, body starts with <!doctype html>', async () => {
    const res = await server.get('/operator');
    expect(res.status).toBe(200);
    const contentType = res.headers.get('content-type') ?? '';
    expect(contentType).toContain('text/html');
    const body = await res.text();
    expect(body).toMatch(/^<!doctype html>/i);
  });
});

// ---------------------------------------------------------------------------
// §I9 — needs no bearer (same request WITH a made-up bearer is still 200)
// ---------------------------------------------------------------------------

describe('GET /operator — no bearer required', () => {
  it('a request WITH a made-up bearer is still 200', async () => {
    const res = await server.get('/operator', 'bearer fake-token');
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// §I9 — CSP header
// ---------------------------------------------------------------------------

describe('GET /operator — content-security-policy', () => {
  it('the response carries a content-security-policy containing default-src \'none\' and connect-src \'self\'', async () => {
    const res = await server.get('/operator');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
  });

  it('the exported CONSOLE_CSP string matches the header', async () => {
    const res = await server.get('/operator');
    const headerCsp = res.headers.get('content-security-policy') ?? '';
    expect(headerCsp).toBe(CONSOLE_CSP);
  });
});

// ---------------------------------------------------------------------------
// §I9 — nothing is fetched from anywhere
// ---------------------------------------------------------------------------

describe('GET /operator — self-contained document', () => {
  it('the body contains no external resource references', async () => {
    const res = await server.get('/operator');
    const body = await res.text();

    expect(body).not.toContain('<script src');
    expect(body).not.toContain('<link ');
    expect(body).not.toContain('http://');
    expect(body).not.toContain('https://');
    expect(body.toLowerCase()).not.toContain('cdn');
  });
});

// ---------------------------------------------------------------------------
// §I9 — panel ids and OPERATOR_TOKEN_STORAGE_KEY
// ---------------------------------------------------------------------------

describe('GET /operator — panel ids and OPERATOR_TOKEN_STORAGE_KEY', () => {
  it('the body contains fleet, tenants, provision, entitlements, grants, audit, and OPERATOR_TOKEN_STORAGE_KEY', async () => {
    const res = await server.get('/operator');
    const body = await res.text();

    expect(body).toContain('fleet');
    expect(body).toContain('tenants');
    expect(body).toContain('provision');
    expect(body).toContain('entitlements');
    expect(body).toContain('grants');
    expect(body).toContain('audit');
    expect(body).toContain(OPERATOR_TOKEN_STORAGE_KEY);
  });
});

// ---------------------------------------------------------------------------
// §I9 — unknown path is still the JSON 404; GET / is still the dashboard
// ---------------------------------------------------------------------------

describe('unknown path → 404; GET / ≠ GET /operator', () => {
  it('an unknown path is still the JSON 404 with an error field', async () => {
    const res = await server.get('/nonexistent');
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('not-found');
  });

  it('GET / and GET /operator return different documents', async () => {
    const dash = await server.get('/');
    const op = await server.get('/operator');
    const dashBody = await dash.text();
    const opBody = await op.text();
    expect(dashBody).not.toBe(opBody);
  });
});
