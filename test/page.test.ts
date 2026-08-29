import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb, makeTenant } from './helpers/db.js';
import { startTestServer, type TestServer } from './helpers/server.js';
import { DASHBOARD_CSP, TOKEN_STORAGE_KEY } from '../src/dashboard/page.js';

/**
 * Integration + string tests for `GET /` in `src/server/app.ts` and the
 * dashboard document itself.
 *
 * §H8 of TASK_PHASE_H.md.
 *
 * Pattern: `test/server.test.ts` — its `beforeAll`/`afterAll` shape, its
 * use of `startTestServer` and `mintTestToken`, and its assertion style.
 *
 * Facts from the phase header that matter most:
 *  - `GET /` needs no bearer and carries the CSP.
 *  - The document contains no external resource references.
 *  - The body contains the four panel ids and the TOKEN_STORAGE_KEY string.
 *  - An unknown path is still the JSON 404.
 */

let db: Awaited<ReturnType<typeof freshDb>>;
let server: TestServer;

beforeAll(async () => {
  db = await freshDb();
  await makeTenant(db, 'page');
  server = await startTestServer(db);
});

afterAll(async () => {
  await server.close();
  await db?.close();
});

// ---------------------------------------------------------------------------
// §H8 — GET / answers 200, text/html, doctype
// ---------------------------------------------------------------------------

describe('GET / — the tenant dashboard', () => {
  it('GET / answers 200, content-type text/html, body starts with <!doctype html>', async () => {
    const res = await server.get('/');
    expect(res.status).toBe(200);
    const contentType = res.headers.get('content-type') ?? '';
    expect(contentType).toContain('text/html');
    const body = await res.text();
    expect(body).toMatch(/^<!doctype html>/i);
  });
});

// ---------------------------------------------------------------------------
// §H8 — needs no bearer (same request WITH a made-up bearer is still 200)
// ---------------------------------------------------------------------------

describe('GET / — no bearer required', () => {
  it('a request WITH a made-up bearer is still 200', async () => {
    const res = await server.get('/', 'bearer fake-token');
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// §H8 — CSP header
// ---------------------------------------------------------------------------

describe('GET / — content-security-policy', () => {
  it('the response carries a content-security-policy containing default-src \'none\' and connect-src \'self\'', async () => {
    const res = await server.get('/');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
  });

  it('the exported DASHBOARD_CSP string matches the header', async () => {
    const res = await server.get('/');
    const headerCsp = res.headers.get('content-security-policy') ?? '';
    expect(headerCsp).toBe(DASHBOARD_CSP);
  });
});

// ---------------------------------------------------------------------------
// §H8 — nothing is fetched from anywhere
// ---------------------------------------------------------------------------

describe('GET / — self-contained document', () => {
  it('the body contains no external resource references', async () => {
    const res = await server.get('/');
    const body = await res.text();

    expect(body).not.toContain('<script src');
    expect(body).not.toContain('<link ');
    expect(body).not.toContain('http://');
    expect(body).not.toContain('https://');
    expect(body.toLowerCase()).not.toContain('cdn');
  });
});

// ---------------------------------------------------------------------------
// §H8 — panel ids and TOKEN_STORAGE_KEY
// ---------------------------------------------------------------------------

describe('GET / — panel ids and TOKEN_STORAGE_KEY', () => {
  it('the body contains submit-workflow, orders, dead, usage-meter, and TOKEN_STORAGE_KEY', async () => {
    const res = await server.get('/');
    const body = await res.text();

    expect(body).toContain('submit-workflow');
    expect(body).toContain('orders');
    expect(body).toContain('dead');
    expect(body).toContain('usage-meter');
    expect(TOKEN_STORAGE_KEY).toBe('workmill.token');
  });
});

// ---------------------------------------------------------------------------
// §H8 — unknown path is still the JSON 404
// ---------------------------------------------------------------------------

describe('unknown path → 404', () => {
  it('an unknown path is still the JSON 404 with an error field', async () => {
    const res = await server.get('/nonexistent');
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('not-found');
  });
});
