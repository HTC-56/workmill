import type { Engine } from '../db/engine.js';
import { withAdmin } from '../seam/withTenant.js';

/**
 * `GET /metrics` in Prometheus text exposition format (SPEC.md feature 8).
 *
 * Split in two on purpose: `collectMetrics` asks the database a handful of
 * aggregate questions, and `renderMetrics` turns the answers into text. The
 * renderer is pure, so the format — which is the part that silently breaks a
 * scrape — is testable without a database.
 *
 * THE LABEL RULE: no metric here carries a tenant id, a tenant slug, or
 * anything else that names a customer. Queue depth, jobs per hour and tokens
 * spent are fleet numbers. Per-tenant series would turn a scrape endpoint into a
 * customer census and give the metrics store an unbounded label cardinality at
 * the same time; a tenant's own numbers are on its dashboard, under RLS, where
 * they belong.
 *
 * The counts are collected under withAdmin() because they are deliberately
 * cross-tenant, which is exactly why the route that serves them is behind the
 * operator bearer.
 */

/** The job states sql/002 allows, in the order a human reads a queue. */
export const JOB_STATES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'dead',
  'cancelled',
] as const;

/** The work-order states sql/002 allows. */
export const ORDER_STATES = ['open', 'done', 'cancelled'] as const;

export interface MetricsSnapshot {
  /** Seconds this process has been serving. */
  uptimeSeconds: number;
  tenants: number;
  /** Every state in JOB_STATES is present, zero included — a series that
   *  disappears when it hits zero makes `rate()` lie. */
  jobsByState: Record<string, number>;
  ordersByState: Record<string, number>;
  /** Orders currently stamped with a blocked_reason (budget exhaustion). */
  ordersBlocked: number;
  /** Jobs that reached a terminal state in the last hour — the "jobs/hour". */
  jobsCompletedLastHour: number;
  /** Tokens billed across all tenants on the current UTC day. */
  tokensToday: number;
  /** Live SSE connections. */
  eventSubscribers: number;
}

/** Escape a Prometheus label value: backslash, quote, newline. */
export function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function line(name: string, value: number, labels?: Record<string, string>): string {
  const rendered = labels
    ? `{${Object.entries(labels)
        .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`)
        .join(',')}}`
    : '';
  // Prometheus wants a plain decimal; NaN and Infinity are valid but a count
  // that is not finite is a bug here, so it is reported as zero.
  const n = Number.isFinite(value) ? value : 0;
  return `${name}${rendered} ${n}\n`;
}

function block(name: string, help: string, type: 'gauge' | 'counter', body: string): string {
  return `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n${body}`;
}

/**
 * Render a snapshot as Prometheus text. Ends with a newline, as the format
 * requires — a body without one is rejected by some scrapers.
 */
export function renderMetrics(snapshot: MetricsSnapshot): string {
  let out = '';
  out += block('workmill_up', 'Always 1 when the process is serving.', 'gauge', line('workmill_up', 1));
  out += block(
    'workmill_uptime_seconds',
    'Seconds since this process started serving.',
    'gauge',
    line('workmill_uptime_seconds', Math.max(0, Math.round(snapshot.uptimeSeconds))),
  );
  out += block(
    'workmill_tenants',
    'Provisioned tenants.',
    'gauge',
    line('workmill_tenants', snapshot.tenants),
  );
  out += block(
    'workmill_jobs',
    'Jobs by state, across all tenants.',
    'gauge',
    JOB_STATES.map((state) => line('workmill_jobs', snapshot.jobsByState[state] ?? 0, { state })).join(''),
  );
  out += block(
    'workmill_work_orders',
    'Work orders by state, across all tenants.',
    'gauge',
    ORDER_STATES.map((state) =>
      line('workmill_work_orders', snapshot.ordersByState[state] ?? 0, { state }),
    ).join(''),
  );
  out += block(
    'workmill_work_orders_blocked',
    'Open work orders stopped by an entitlement, e.g. the daily token budget.',
    'gauge',
    line('workmill_work_orders_blocked', snapshot.ordersBlocked),
  );
  out += block(
    'workmill_jobs_completed_last_hour',
    'Jobs that reached a terminal state in the last hour.',
    'gauge',
    line('workmill_jobs_completed_last_hour', snapshot.jobsCompletedLastHour),
  );
  out += block(
    'workmill_tokens_today',
    'Tokens billed to the ledger on the current UTC day, all tenants.',
    'gauge',
    line('workmill_tokens_today', snapshot.tokensToday),
  );
  out += block(
    'workmill_event_subscribers',
    'Open Server-Sent Events connections.',
    'gauge',
    line('workmill_event_subscribers', snapshot.eventSubscribers),
  );
  return out;
}

function tally(rows: { state: string; n: string | number }[], states: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const state of states) out[state] = 0;
  for (const row of rows) out[row.state] = Number(row.n);
  return out;
}

export interface CollectOptions {
  /** Seconds this process has been up. */
  uptimeSeconds: number;
  /** Live SSE connections, from the EventBus. */
  eventSubscribers: number;
}

/**
 * Ask the database for the fleet numbers. One round trip per question rather
 * than one clever union: a scrape runs every fifteen seconds against indexes
 * that already exist, and a readable query is worth more than a saved round
 * trip on a single-box deployment.
 */
export async function collectMetrics(
  engine: Engine,
  options: CollectOptions,
): Promise<MetricsSnapshot> {
  return withAdmin(engine, async (sql) => {
    const [tenants] = await sql.query<{ n: string | number }>('SELECT count(*) AS n FROM tenants');
    const jobs = await sql.query<{ state: string; n: string | number }>(
      'SELECT state, count(*) AS n FROM jobs GROUP BY state',
    );
    const orders = await sql.query<{ state: string; n: string | number }>(
      'SELECT state, count(*) AS n FROM work_orders GROUP BY state',
    );
    const [blocked] = await sql.query<{ n: string | number }>(
      "SELECT count(*) AS n FROM work_orders WHERE blocked_reason IS NOT NULL AND state = 'open'",
    );
    // `updated_at` is the closest thing the queue has to a finished-at: sql/002
    // stamps it on every transition, and for a terminal row the last transition
    // IS the finish. A job that reached a terminal state and was never touched
    // again therefore ages out of this window exactly when it should.
    const [recent] = await sql.query<{ n: string | number }>(
      `SELECT count(*) AS n FROM jobs
        WHERE state IN ('succeeded', 'failed', 'dead', 'cancelled')
          AND updated_at > now() - interval '1 hour'`,
    );
    const [tokens] = await sql.query<{ n: string | number }>(
      `SELECT COALESCE(sum(total_tokens), 0) AS n FROM token_ledger
        WHERE usage_day = ((now() AT TIME ZONE 'UTC')::date)`,
    );
    return {
      uptimeSeconds: options.uptimeSeconds,
      tenants: Number(tenants?.n ?? 0),
      jobsByState: tally(jobs, JOB_STATES),
      ordersByState: tally(orders, ORDER_STATES),
      ordersBlocked: Number(blocked?.n ?? 0),
      jobsCompletedLastHour: Number(recent?.n ?? 0),
      tokensToday: Number(tokens?.n ?? 0),
      eventSubscribers: options.eventSubscribers,
    };
  });
}
