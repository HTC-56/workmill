import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb, makeTenant, type TestTenant } from './helpers/db.js';
import { mintTestToken, readSseEvents, startTestServer, type TestServer } from './helpers/server.js';
import { EventBus, type OpsEvent } from '../src/ops/events.js';

/**
 * Tests for the live event stream: `GET /events` in `src/server/app.ts`.
 *
 * §G9 of TASK_PHASE_G.md.
 *
 * Two servers are spun up so we can assert both the guarded and unguarded
 * modes of `/events`: one with operator auth (the usual path) and one with
 * tenant auth (the stream path). The bus is created once in `beforeAll` and
 * shared across all tests so that publishing before a stream hits the server
 * exercises replay and tenant scoping.
 *
 * No runner, no model calls — just the SSE route and the bus.
 */

let db: Awaited<ReturnType<typeof freshDb>>;
let tenant: TestTenant;
let otherTenant: TestTenant;
let server: TestServer;
let operatorToken: string;
let tenantToken: string;

beforeAll(async () => {
  db = await freshDb();
  tenant = await makeTenant(db, 'sse');
  otherTenant = await makeTenant(db, 'other-tenant');

  tenantToken = await mintTestToken(db, tenant.id);
  operatorToken = 'operator-token-for-sse-testing-only';

  server = await startTestServer(db, {
    operatorToken,
  });
});

afterAll(async () => {
  await server.close();
  await db?.close();
});

/** Build an isolated server with a fresh bus for tests that need isolation. */
async function makeIsolatedServer(): Promise<TestServer> {
  return startTestServer(db, {
    bus: new EventBus(),
    operatorToken,
  });
}

// ---------------------------------------------------------------------------
// §G9 — 401s
// ---------------------------------------------------------------------------

describe('/events — 401s', () => {
  it('no bearer answers 401 with WWW-Authenticate', async () => {
    const res = await server.get('/events');
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer');
  });

  it('a made-up bearer answers 401 with WWW-Authenticate', async () => {
    const res = await server.get('/events', 'wm_made_up_token_12345');
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer');
  });
});

// ---------------------------------------------------------------------------
// §G9 — 200 with tenant token, content-type is SSE
// ---------------------------------------------------------------------------

describe('/events — tenant token → 200 SSE', () => {
  it('a valid tenant bearer answers 200 with content-type text/event-stream', async () => {
    const res = await server.get('/events', tenantToken);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
  });
});

// ---------------------------------------------------------------------------
// §G9 — tenant-scoped delivery
// ---------------------------------------------------------------------------

describe('/events — tenant-scoped delivery', () => {
  let iso: TestServer;
  let bus: EventBus;

  beforeAll(async () => {
    iso = await makeIsolatedServer();
    bus = iso.app.bus;
  });

  afterAll(async () => {
    await iso.close();
  });

  it('only events for the connected tenant arrive, in publish order', async () => {
    // Publish one event for the other tenant and two for the connected tenant.
    bus.publish({ kind: 'job', tenantId: otherTenant.id, id: 'job-other', state: 'done' });
    bus.publish({ kind: 'job', tenantId: tenant.id, id: 'job-one', state: 'running' });
    bus.publish({ kind: 'job', tenantId: tenant.id, id: 'job-two', state: 'done' });

    const res = await iso.get('/events', tenantToken);
    const events = await readSseEvents(res, 2);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: 'job', id: 'job-one', state: 'running' });
    expect(events[1]).toMatchObject({ kind: 'job', id: 'job-two', state: 'done' });
    // Every event carries the connected tenant's id.
    for (const ev of events) {
      expect((ev as unknown as OpsEvent).tenantId).toBe(tenant.id);
    }
  });
});

// ---------------------------------------------------------------------------
// §G9 — payload shape: required fields present, forbidden absent
// ---------------------------------------------------------------------------

describe('/events — payload shape', () => {
  let iso: TestServer;
  let bus: EventBus;

  beforeAll(async () => {
    iso = await makeIsolatedServer();
    bus = iso.app.bus;
  });

  afterAll(async () => {
    await iso.close();
  });

  it('every delivered event carries seq, at, kind, id, state and no input/output', async () => {
    bus.publish({ kind: 'order', tenantId: tenant.id, id: 'order-1', state: 'blocked' });

    const res = await iso.get('/events', tenantToken);
    const events = await readSseEvents(res, 1);

    const ev = events[0] as unknown as OpsEvent;
    expect(typeof ev.seq).toBe('number');
    expect(typeof ev.at).toBe('string');
    expect(ev.kind).toBe('order');
    expect(ev.id).toBe('order-1');
    expect(ev.state).toBe('blocked');

    // Forbidden keys must never appear in the stream payload.
    expect(ev).not.toHaveProperty('input');
    expect(ev).not.toHaveProperty('output');
  });
});

// ---------------------------------------------------------------------------
// §G9 — unsubscribe on close
// ---------------------------------------------------------------------------

describe('/events — unsubscribe on close', () => {
  let iso: TestServer;
  let bus: EventBus;

  beforeAll(async () => {
    iso = await makeIsolatedServer();
    bus = iso.app.bus;
  });

  afterAll(async () => {
    await iso.close();
  });

  it('subscriberCount drops to 0 after the body is cancelled', async () => {
    expect(bus.subscriberCount).toBe(0);

    // Use AbortController so cancelling the signal closes the TCP connection
    // and triggers the server-side 'close' handler (which calls unsubscribe).
    const ac = new AbortController();
    // The response is not consumed — we close the connection immediately
    // via abort() to exercise the unsubscribe path.
    await fetch(`${iso.url}/events`, {
      headers: { authorization: `Bearer ${tenantToken}` },
      signal: ac.signal,
    });
    // Wait for the subscription to register on the server.
    await new Promise((r) => setTimeout(r, 50));
    expect(bus.subscriberCount).toBe(1);

    // Abort closes the TCP connection, which fires the server-side 'close'
    // handler that calls unsubscribe().
    ac.abort();
    await new Promise((r) => setTimeout(r, 50));
    expect(bus.subscriberCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §G9 — ops log records stream open and close
// ---------------------------------------------------------------------------

describe('/events — ops log stream records', () => {
  let iso: TestServer;

  beforeAll(async () => {
    iso = await makeIsolatedServer();
  });

  afterAll(async () => {
    await iso.close();
  });

  it('the ops ledger holds kind: stream open and close records', async () => {
    // Clear the in-memory ops log so counts are exact.
    const log = iso.opsLog;
    if ('lines' in log) {
      (log as { lines: string[] }).lines.length = 0;
    }

    const res = await iso.get('/events', tenantToken);
    // Cancel the body — this triggers the server-side close handler.
    await res.body?.cancel();

    // Wait for the close handler to flush.
    await new Promise((r) => setTimeout(r, 50));

    const records = iso.opsLog.records();
    const streamRecords = records.filter(
      (r) => (r as Record<string, unknown>).kind === 'stream',
    );

    const openRec = streamRecords.find(
      (r) => (r as Record<string, unknown>).event === 'open',
    );
    const closeRec = streamRecords.find(
      (r) => (r as Record<string, unknown>).event === 'close',
    );

    expect(openRec).toBeDefined();
    expect((openRec as Record<string, unknown>).tenantId).toBe(tenant.id);

    expect(closeRec).toBeDefined();
    expect((closeRec as Record<string, unknown>).tenantId).toBe(tenant.id);
  });
});
