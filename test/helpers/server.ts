import type { Engine } from '../../src/db/engine.js';
import { withTenant } from '../../src/seam/withTenant.js';
import { createApp, type AppOptions, type WorkmillApp } from '../../src/server/app.js';
import { mintApiToken } from '../../src/server/auth.js';
import { memoryOpsLog, type MemoryOpsLog } from '../../src/ops/opslog.js';

/**
 * A real listening workmill server, for tests.
 *
 * `app.inject()` would be enough for `/healthz` and `/metrics`, but `/events`
 * hijacks its reply and streams forever — an injected response never completes,
 * so it cannot be asserted on. One loopback listener on an ephemeral port makes
 * every route testable the same way, with real headers and a real socket close.
 *
 * The ops log defaults to the in-memory one, so a test can assert on what the
 * ledger recorded without touching the filesystem.
 */
export interface TestServer {
  /** Base URL, e.g. `http://127.0.0.1:54321` — no trailing slash. */
  readonly url: string;
  readonly app: WorkmillApp;
  readonly opsLog: MemoryOpsLog;
  /** GET one path, with an optional bearer. */
  get(path: string, token?: string): Promise<Response>;
  /** POST one path with a JSON body, with an optional bearer. */
  post(path: string, body: unknown, token?: string): Promise<Response>;
  /** GET one path and parse the JSON body — `{ status, body }`. */
  getJson(path: string, token?: string): Promise<JsonResponse>;
  /** POST one path and parse the JSON body — `{ status, body }`. */
  postJson(path: string, body: unknown, token?: string): Promise<JsonResponse>;
  close(): Promise<void>;
}

/** A parsed reply: the status, and whatever JSON came back (`{}` if none). */
export interface JsonResponse {
  status: number;
  ok: boolean;
  body: Record<string, unknown>;
  headers: Headers;
}

async function toJson(response: Response): Promise<JsonResponse> {
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, ok: response.ok, body, headers: response.headers };
}

export type TestServerOptions = Omit<AppOptions, 'engine' | 'opsLog'>;

export async function startTestServer(
  engine: Engine,
  options: TestServerOptions = {},
): Promise<TestServer> {
  const opsLog = memoryOpsLog();
  const app = createApp({ engine, opsLog, ...options });
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  const address = app.fastify.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('test server did not bind a TCP port');
  }
  const url = `http://127.0.0.1:${address.port}`;
  const get = (path: string, token?: string): Promise<Response> =>
    fetch(`${url}${path}`, token ? { headers: { authorization: `Bearer ${token}` } } : undefined);
  const post = (path: string, body: unknown, token?: string): Promise<Response> => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token !== undefined) headers['authorization'] = `Bearer ${token}`;
    return fetch(`${url}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  };
  return {
    url,
    app,
    opsLog,
    get,
    post,
    getJson: (path, token) => get(path, token).then(toJson),
    postJson: (path, body, token) => post(path, body, token).then(toJson),
    close: () => app.fastify.close(),
  };
}

/** Mint a live tenant bearer the way the CLI helper will. Returns the raw token. */
export async function mintTestToken(
  engine: Engine,
  tenantId: string,
  name = 'test',
): Promise<string> {
  const minted = await withTenant(engine, tenantId, (sql) =>
    mintApiToken(sql, tenantId, { name }),
  );
  return minted.token;
}

/**
 * Read Server-Sent Event frames off a streaming response until `want` of them
 * have arrived or `timeoutMs` elapses, then cancel the body.
 *
 * Frames are split on the blank line SSE uses as a terminator; comment frames
 * (`: ping`) are skipped, because a keep-alive is not an event. Returns the
 * parsed `data:` payloads in order.
 */
export async function readSseEvents(
  response: Response,
  want: number,
  timeoutMs = 5_000,
): Promise<Record<string, unknown>[]> {
  if (!response.body) throw new Error('response has no body to stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: Record<string, unknown>[] = [];
  const deadline = Date.now() + timeoutMs;
  let buffer = '';
  try {
    while (events.length < want && Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split = buffer.indexOf('\n\n');
      while (split !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const data = frame
          .split('\n')
          .find((l) => l.startsWith('data: '))
          ?.slice('data: '.length);
        if (data !== undefined) events.push(JSON.parse(data) as Record<string, unknown>);
        split = buffer.indexOf('\n\n');
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return events;
}
