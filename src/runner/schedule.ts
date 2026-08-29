import type { Engine } from '../db/engine.js';
import type { GatewayConfig } from '../gateway/client.js';
import { withAdmin } from '../seam/withTenant.js';
import { runOnce, type RunnerOptions, type RunSummary } from './run.js';

/**
 * The schedule the runner never had (ROADMAP row #9, and the reservation
 * "`runOnce` is a function nobody calls on a timer").
 *
 * Everything hard about running work has already been solved by `runOnce`:
 * leases, heartbeats, backoff, dead-letter, cancel, billing. What was missing
 * was the boring part — something that calls it, forever, without falling over.
 * So this file adds exactly three guarantees and no queue logic at all:
 *
 * 1. **Ticks never overlap.** The timer sets a flag, not a task. If a tick is
 *    still running when the next one is due, the next one is skipped rather
 *    than queued: a slow gateway must not build a backlog of concurrent ticks
 *    that all claim at once. (Correctness does not depend on this — the claim
 *    query and the leases are safe against any number of workers — but a
 *    process that quietly multiplies its own concurrency is a bad neighbour.)
 * 2. **One tenant's failure is not the fleet's.** Each tenant's tick is caught
 *    separately and reported through `onError`; the loop goes on to the next
 *    tenant and comes back next interval.
 * 3. **`stop()` is a real stop.** It clears the timer and AWAITS the tick that
 *    may already be in flight, so a caller that stops the loop and then closes
 *    the engine cannot pull the connection out from under a running job.
 *
 * The loop is deliberately per-tenant rather than fleet-wide, because the claim
 * query is tenant-scoped by construction: `withTenant` pins one tenant per
 * transaction, and that is the seam that makes the whole repo safe. A
 * fleet-wide claim would need an admin-role query over every tenant's jobs,
 * which is precisely the door this codebase spent Phase A closing.
 */

/** How long between ticks when nobody configures it. */
export const DEFAULT_TICK_INTERVAL_MS = 2_000;

/** Every tenant, oldest first. An admin read: the scheduler is not a tenant. */
export async function listTenantIds(engine: Engine): Promise<string[]> {
  return withAdmin(engine, async (sql) => {
    const rows = await sql.query<{ id: string }>(
      'SELECT id FROM tenants ORDER BY created_at, id',
    );
    return rows.map((row) => row.id);
  });
}

/** What one sweep across the fleet did, per tenant that had work. */
export interface SweepResult {
  readonly tenants: number;
  readonly summaries: ReadonlyMap<string, RunSummary>;
  readonly errors: readonly { tenantId: string; error: unknown }[];
}

export interface RunnerLoopOptions extends RunnerOptions {
  readonly intervalMs?: number;
  /** Called after every sweep, for logging. Never awaited by the loop. */
  readonly onSweep?: (result: SweepResult) => void;
  /** Called for each tenant whose tick threw. The loop continues either way. */
  readonly onError?: (tenantId: string, error: unknown) => void;
}

export interface RunnerLoop {
  /** False once `stop()` has been called. */
  readonly running: boolean;
  /** Sweeps every tenant once, in series. Safe to call from a test or a timer. */
  sweep(): Promise<SweepResult>;
  /** Clears the timer and awaits any sweep already in flight. Idempotent. */
  stop(): Promise<void>;
}

/**
 * One sweep: tick every tenant once.
 *
 * Series, not parallel. Ticks are database-bound and PGlite serves exactly one
 * connection, so running tenants concurrently would buy nothing on the default
 * engine and would make the ordering of a test's assertions depend on timing.
 */
export async function sweepOnce(
  engine: Engine,
  gateway: GatewayConfig,
  options: RunnerLoopOptions,
): Promise<SweepResult> {
  const tenantIds = await listTenantIds(engine);
  const summaries = new Map<string, RunSummary>();
  const errors: { tenantId: string; error: unknown }[] = [];

  for (const tenantId of tenantIds) {
    try {
      summaries.set(tenantId, await runOnce(engine, tenantId, gateway, options));
    } catch (error) {
      errors.push({ tenantId, error });
      options.onError?.(tenantId, error);
    }
  }

  return { tenants: tenantIds.length, summaries, errors };
}

/**
 * Start ticking. Returns immediately; the first sweep happens one interval
 * later, so a caller can finish wiring the process before any work is claimed.
 */
export function startRunnerLoop(
  engine: Engine,
  gateway: GatewayConfig,
  options: RunnerLoopOptions,
): RunnerLoop {
  const intervalMs = options.intervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();
  let busy = false;

  const sweep = async (): Promise<SweepResult> => {
    const result = await sweepOnce(engine, gateway, options);
    options.onSweep?.(result);
    return result;
  };

  const timer = setInterval(() => {
    if (stopped || busy) return;
    busy = true;
    inFlight = sweep()
      .then(() => undefined)
      // A sweep that throws is a database blip, not a reason to stop ticking;
      // per-tenant failures were already reported through `onError`.
      .catch(() => undefined)
      .finally(() => {
        busy = false;
      });
  }, intervalMs);
  // A timer must never be the reason a process refuses to exit.
  timer.unref?.();

  return {
    get running(): boolean {
      return !stopped;
    },
    sweep,
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
