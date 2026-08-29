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
  close(): Promise<void>;
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
  return {
    url,
    app,
    opsLog,
    get: (path, token) =>
      fetch(`${url}${path}`, token ? { headers: { authorization: `Bearer ${token}` } } : undefined),
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
