import type { Engine } from '../db/engine.js';
import { withAdmin } from '../seam/withTenant.js';
import type { GatewayConfig } from '../gateway/client.js';

/**
 * The fleet panel (SPEC.md feature 7): "gateway health, queue depth,
 * jobs/hour".
 *
 * `/metrics` already answers most of these for a scraper. This exists anyway,
 * and the difference is the gateway probe: Prometheus asks what this process
 * knows, and an operator staring at a stalled queue needs to know whether the
 * thing on the other end of the only outbound HTTP in `src/` is answering. A
 * scrape endpoint cannot do that without making every scrape hit the gateway.
 *
 * The probe is a GET of the configured base URL's `/models`. That is the same
 * base URL `chatCompletion` uses and the only one this repo may reach — a
 * health check pointed anywhere else would be a second outbound host smuggled
 * in as an ops feature. `fetchImpl` is injectable so tests prove both the
 * reachable and the unreachable branch without a network.
 *
 * A gateway that is down is REPORTED, never thrown: an operator console whose
 * fleet panel 500s because the gateway is unreachable is a console that breaks
 * exactly when it is needed.
 */

/** How long the probe waits before calling the gateway unreachable. */
export const PROBE_TIMEOUT_MS = 3_000;

export interface GatewayHealth {
  /** The configured root, echoed so the console shows where it looked. */
  baseUrl: string | null;
  reachable: boolean;
  /** The HTTP status, or null when nothing answered. */
  status: number | null;
  latencyMs: number;
  /** Why it failed, short. Null when it did not. */
  error: string | null;
}

export interface FleetSnapshot {
  gateway: GatewayHealth;
  queue: {
    pending: number;
    running: number;
    dead: number;
    /** Age of the oldest job still waiting — the number that says "stalled". */
    oldestPendingSeconds: number;
  };
  throughput: {
    jobsLastHour: number;
    succeededLastHour: number;
    failedLastHour: number;
    tokensToday: number;
  };
  tenants: {
    total: number;
    suspended: number;
    /** Tenants with a live support grant — how much of the fleet is being looked at. */
    withActiveGrant: number;
  };
}

export interface ProbeOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

/** Trim an error to something a panel can show without wrapping three lines. */
function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 120);
}

/**
 * Ask the gateway whether it is there. Never throws.
 *
 * With no configured gateway the answer is an honest "not configured" rather
 * than a green light — the same rule `loadOperatorToken` follows, where a
 * missing secret means "off" and never "unguarded".
 */
export async function probeGateway(
  config: GatewayConfig | null,
  options: ProbeOptions = {},
): Promise<GatewayHealth> {
  const now = options.now ?? Date.now;
  if (!config) {
    return { baseUrl: null, reachable: false, status: null, latencyMs: 0, error: 'not-configured' };
  }
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const url = `${config.baseUrl.replace(/\/+$/, '')}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const startedAt = now();
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (config.apiKey) headers['authorization'] = `Bearer ${config.apiKey}`;
    const response = await doFetch(url, { method: 'GET', headers, signal: controller.signal });
    // The body is not read: whether the gateway can list models is not the
    // question, only whether it answered.
    return {
      baseUrl: config.baseUrl,
      reachable: response.ok,
      status: response.status,
      latencyMs: Math.max(0, Math.round(now() - startedAt)),
      error: response.ok ? null : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      baseUrl: config.baseUrl,
      reachable: false,
      status: null,
      latencyMs: Math.max(0, Math.round(now() - startedAt)),
      error: shortError(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface FleetOptions extends ProbeOptions {
  /** Null means no gateway is configured; the panel says so. */
  gateway?: GatewayConfig | null;
}

/**
 * The whole panel in one call: the database numbers under `withAdmin` (they are
 * deliberately cross-tenant, which is why the route is behind the operator
 * bearer) and the gateway probe beside them.
 */
export async function collectFleet(
  engine: Engine,
  options: FleetOptions = {},
): Promise<FleetSnapshot> {
  const gateway = await probeGateway(options.gateway ?? null, options);
  return withAdmin(engine, async (sql) => {
    const [queue] = await sql.query<{
      pending: string | number;
      running: string | number;
      dead: string | number;
      oldest: string | number | null;
    }>(
      `SELECT count(*) FILTER (WHERE state = 'pending') AS pending,
              count(*) FILTER (WHERE state = 'running') AS running,
              count(*) FILTER (WHERE state = 'dead')    AS dead,
              COALESCE(EXTRACT(EPOCH FROM (now() - min(created_at)
                FILTER (WHERE state = 'pending'))), 0) AS oldest
         FROM jobs`,
    );
    // `updated_at` is the queue's closest thing to a finished-at, for the same
    // reason `collectMetrics` uses it: sql/002 stamps it on every transition, so
    // for a terminal row the last transition IS the finish.
    const [recent] = await sql.query<{
      total: string | number;
      succeeded: string | number;
      failed: string | number;
    }>(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE state = 'succeeded') AS succeeded,
              count(*) FILTER (WHERE state IN ('failed', 'dead')) AS failed
         FROM jobs
        WHERE state IN ('succeeded', 'failed', 'dead', 'cancelled')
          AND updated_at > now() - interval '1 hour'`,
    );
    const [tokens] = await sql.query<{ n: string | number }>(
      `SELECT COALESCE(sum(total_tokens), 0) AS n FROM token_ledger
        WHERE usage_day = ((now() AT TIME ZONE 'UTC')::date)`,
    );
    const [tenants] = await sql.query<{
      total: string | number;
      suspended: string | number;
      granted: string | number;
    }>(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE state = 'suspended') AS suspended,
              count(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM support_grants g
                 WHERE g.tenant_id = t.id AND g.revoked_at IS NULL AND g.expires_at > now()
              )) AS granted
         FROM tenants t`,
    );
    return {
      gateway,
      queue: {
        pending: Number(queue?.pending ?? 0),
        running: Number(queue?.running ?? 0),
        dead: Number(queue?.dead ?? 0),
        oldestPendingSeconds: Math.max(0, Math.round(Number(queue?.oldest ?? 0))),
      },
      throughput: {
        jobsLastHour: Number(recent?.total ?? 0),
        succeededLastHour: Number(recent?.succeeded ?? 0),
        failedLastHour: Number(recent?.failed ?? 0),
        tokensToday: Number(tokens?.n ?? 0),
      },
      tenants: {
        total: Number(tenants?.total ?? 0),
        suspended: Number(tenants?.suspended ?? 0),
        withActiveGrant: Number(tenants?.granted ?? 0),
      },
    };
  });
}
