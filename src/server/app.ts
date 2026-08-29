import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Engine } from '../db/engine.js';
import { withAdmin } from '../seam/withTenant.js';
import {
  EventBus,
  formatSse,
  parseLastEventId,
  sseComment,
  sseRetry,
  type OpsEvent,
} from '../ops/events.js';
import { collectMetrics, renderMetrics } from '../ops/metrics.js';
import { nullOpsLog, type OpsLog } from '../ops/opslog.js';
import { isOperator, parseBearer, resolveApiToken, type TokenIdentity } from './auth.js';

/**
 * The HTTP surface (SPEC.md feature 8).
 *
 * Five phases of library code arrive here: this is the first thing in the repo a
 * stranger can reach. Three routes, and each one answers a different question —
 * `/healthz` "is this box alive", `/metrics` "what is the fleet doing",
 * `/events` "what is happening to MY work right now".
 *
 * The auth split is the load-bearing part. `/events` is TENANT data, so it takes
 * a tenant bearer and streams only that tenant's transitions. `/metrics` is
 * FLEET data, so it takes the operator bearer and carries no tenant labels at
 * all. `/healthz` is neither: it says whether the process and its database are
 * up and deliberately says nothing else, because it is the one route a load
 * balancer reaches unauthenticated.
 *
 * A NAMED CALL, recorded here rather than assumed: `/metrics` is behind the
 * operator bearer. The spec attaches auth to "the operator API" and lists
 * `/metrics` separately, which could be read either way. Fleet-wide queue depth
 * and token spend are operator information, and a scraper can send a bearer, so
 * the safe reading wins. With no operator token configured the route refuses
 * with 503 — a missing secret means "off", never "unguarded".
 *
 * Routes for the dashboard and the operator console (ROADMAP rows #6 and #7)
 * register onto the same instance in their own phases; this file stays the ops
 * surface plus the two guards they will reuse.
 */

/** Prometheus' text exposition content type, version included as it expects. */
export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/** How long a browser waits before reconnecting a dropped stream. */
export const SSE_RETRY_MS = 3_000;

/** Silence on an SSE stream longer than this gets a comment frame. */
export const SSE_HEARTBEAT_MS = 15_000;

export interface AppOptions {
  engine: Engine;
  /** Shared with the runner, which publishes job and order transitions to it. */
  bus?: EventBus;
  /** Where the JSONL ops ledger goes. Defaults to discarding. */
  opsLog?: OpsLog;
  /** The static operator bearer. Null disables every operator route. */
  operatorToken?: string | null;
  /** Overridable so tests can assert on uptime without waiting. */
  now?: () => number;
  /** Milliseconds between SSE keep-alive comments. */
  heartbeatMs?: number;
}

export interface WorkmillApp {
  readonly fastify: FastifyInstance;
  readonly bus: EventBus;
  readonly opsLog: OpsLog;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireTenant` once a bearer has resolved. */
    identity?: TokenIdentity;
  }
}

/**
 * Resolve the tenant bearer, or answer 401 and return null.
 *
 * A missing bearer, a made-up bearer, a revoked one and an expired one all get
 * the same reply. Distinguishing them would turn the 401 into an oracle for
 * which tokens once existed.
 */
async function requireTenant(
  engine: Engine,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<TokenIdentity | null> {
  const raw = parseBearer(request.headers.authorization);
  const identity = raw === null ? null : await resolveApiToken(engine, raw);
  if (!identity) {
    reply.header('WWW-Authenticate', 'Bearer');
    await reply.code(401).send({ error: 'unauthorized' });
    return null;
  }
  request.identity = identity;
  return identity;
}

/** Guard an operator route. Returns false once it has answered 401 or 503. */
async function requireOperator(
  operatorToken: string | null,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  if (!operatorToken) {
    await reply.code(503).send({ error: 'operator-api-disabled' });
    return false;
  }
  if (!isOperator(request.headers.authorization, operatorToken)) {
    reply.header('WWW-Authenticate', 'Bearer');
    await reply.code(401).send({ error: 'unauthorized' });
    return false;
  }
  return true;
}

export function createApp(options: AppOptions): WorkmillApp {
  const { engine } = options;
  const bus = options.bus ?? new EventBus();
  const opsLog = options.opsLog ?? nullOpsLog();
  const operatorToken = options.operatorToken ?? null;
  const now = options.now ?? Date.now;
  const heartbeatMs = options.heartbeatMs ?? SSE_HEARTBEAT_MS;
  const startedAt = now();

  // Fastify's own logger is off: the ops ledger below is this repo's request
  // log, it is the format the spec asked for, and two logs disagreeing about
  // what happened is worse than one.
  const fastify = Fastify({ logger: false });

  /**
   * Every non-streaming response becomes one ledger line. Ids and shapes only —
   * the ledger redacts anything that smells like content, and there is nothing
   * here that could carry any.
   */
  fastify.addHook('onResponse', async (request, reply) => {
    await opsLog.append({
      kind: 'request',
      method: request.method,
      path: request.routeOptions.url ?? request.url,
      status: reply.statusCode,
      ms: Math.round(reply.elapsedTime),
      tenantId: request.identity?.tenantId ?? null,
    });
  });

  /**
   * Liveness AND readiness in one route, because a box that cannot reach its
   * database is not usefully alive: it answers 503 with `database: "down"`
   * rather than 200 with a hidden problem. The body names the engine, which is
   * the single most useful fact when a deployment behaves unlike the tests.
   */
  fastify.get('/healthz', async (_request, reply) => {
    let databaseUp = true;
    try {
      await withAdmin(engine, (sql) => sql.query('SELECT 1'));
    } catch {
      databaseUp = false;
    }
    const body = {
      status: databaseUp ? 'ok' : 'degraded',
      engine: engine.kind,
      database: databaseUp ? 'up' : 'down',
      uptimeSeconds: Math.round((now() - startedAt) / 1000),
    };
    return reply.code(databaseUp ? 200 : 503).send(body);
  });

  fastify.get('/metrics', async (request, reply) => {
    if (!(await requireOperator(operatorToken, request, reply))) return reply;
    const snapshot = await collectMetrics(engine, {
      uptimeSeconds: (now() - startedAt) / 1000,
      eventSubscribers: bus.subscriberCount,
    });
    return reply.code(200).type(METRICS_CONTENT_TYPE).send(renderMetrics(snapshot));
  });

  /**
   * The live stream of this tenant's job and order transitions.
   *
   * The response is hijacked: Fastify stops managing it and this handler owns
   * the socket until the client goes away. That is what SSE needs, and it is
   * why the ops-ledger line for a stream is written on open and on close rather
   * than by the onResponse hook, which a hijacked reply never reaches.
   *
   * A reconnecting browser sends `Last-Event-ID` and gets everything the ring
   * still holds after it. If it was away longer than the ring is deep, it is
   * told so in one `event: gap` frame — a client that knows it missed something
   * can reload; a client silently handed a hole cannot.
   */
  fastify.get('/events', async (request, reply) => {
    const identity = await requireTenant(engine, request, reply);
    if (!identity) return reply;

    const { tenantId } = identity;
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Streaming through nginx without this buffers the whole response.
      'x-accel-buffering': 'no',
    });
    raw.write(sseRetry(SSE_RETRY_MS));

    const since = parseLastEventId(request.headers['last-event-id'] as string | undefined);
    if (bus.hasGapSince(since)) {
      raw.write(`event: gap\ndata: ${JSON.stringify({ since })}\n\n`);
    }
    for (const missed of bus.replay(tenantId, since)) raw.write(formatSse(missed));

    const send = (event: OpsEvent): void => {
      raw.write(formatSse(event));
    };
    const unsubscribe = bus.subscribe(tenantId, send);
    const heartbeat = setInterval(() => raw.write(sseComment()), heartbeatMs);
    // An interval must never be the reason a process refuses to exit.
    heartbeat.unref?.();

    await opsLog.append({ kind: 'stream', event: 'open', tenantId, since });

    let closed = false;
    const finish = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      void opsLog.append({ kind: 'stream', event: 'close', tenantId });
      raw.end();
    };
    request.raw.on('close', finish);
    request.raw.on('error', finish);
    return reply;
  });

  fastify.setNotFoundHandler(async (_request, reply) =>
    reply.code(404).send({ error: 'not-found' }),
  );

  return { fastify, bus, opsLog };
}
