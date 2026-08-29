import type { Engine, Session } from '../db/engine.js';
import { withTenant } from '../seam/withTenant.js';
import { claimJobs, type ClaimedJob } from '../queue/claim.js';
import {
  cancelOrder,
  failAttempt,
  finishJob,
  heartbeat,
  markCancelled,
  reapExpiredLeases,
  type HeartbeatState,
} from '../queue/lifecycle.js';
import { GatewayAbortedError, GatewayError, type GatewayConfig } from '../gateway/client.js';
import { runCompletion } from '../gateway/complete.js';
import {
  BUDGET_EXHAUSTED,
  blockOpenOrders,
  budgetStatus,
  clearOrderBlocks,
} from '../metering/limits.js';
import type { EventBus } from '../ops/events.js';

/**
 * The job runner (SPEC.md feature 3): the loop that turns claimed jobs into
 * durable results.
 *
 * One tick is `runOnce`: reap the leases nobody is holding any more, claim a
 * batch, and run each item through the gateway. Everything it can do to a job
 * row is a call into `../queue/lifecycle.js`; everything it can do to a model is
 * a call into `../gateway/complete.js`. This file owns exactly one thing
 * neither of those can: the shape of the work, and when each transaction opens.
 *
 * That shape is load-bearing. The claim commits, THEN the model is called with
 * no transaction open, THEN the outcome is written in a new transaction. A
 * database transaction is never held across a network call to a model that may
 * think for a minute — that is what turns a slow gateway into a locked queue.
 * It is also why PGlite, which serves exactly one connection, can run this
 * runner at all: the heartbeat's transaction only ever opens while the model
 * call is in flight and no other transaction exists.
 *
 * Jobs in a batch run one after another, so `max_concurrent_jobs` is enforced by
 * the claim query rather than by this loop: the claim never hands back more rows
 * than the cap allows, whoever asks and however large a batch they ask for.
 *
 * The budget is the one entitlement this file has anything to say about, and
 * what it says is only reporting. A spent daily budget already makes the claim
 * take nothing (src/queue/claim.ts); what a tick adds is the reason, stamped on
 * the orders that stopped, because "refuses further claims mid-order" is only
 * half of SPEC.md feature 5 — "and the order says so" is the other half. A tick
 * that can claim again clears the stamp.
 */

/** How long a claimed job's lease lasts before the reaper may take it back. */
export const DEFAULT_LEASE_MS = 30_000;

/** How many items one tick takes. */
export const DEFAULT_BATCH_SIZE = 4;

export interface RunnerOptions {
  /** Identifies this worker in the job row, for operator visibility. */
  workerId: string;
  batchSize?: number;
  leaseMs?: number;
  /** Defaults to a third of the lease: two beats may be lost before it expires. */
  heartbeatMs?: number;
  /** Injectable for tests, so a backoff can be asserted rather than sampled. */
  random?: () => number;
  /**
   * Where transitions are announced, for `GET /events` (SPEC.md feature 8).
   *
   * Optional, and the runner behaves identically without one: publishing is
   * reporting, never control flow. Every publish happens AFTER the transaction
   * that made the transition durable has committed, so the stream can never
   * describe a state the database would deny.
   */
  events?: EventBus;
}

/** What one tick did. Every claimed job lands in exactly one of these buckets. */
export interface RunSummary {
  claimed: number;
  succeeded: number;
  /** The model answered, but the answer never validated. Terminal. */
  failed: number;
  /** Transport failure, and the job has another attempt coming. */
  retried: number;
  /** Transport failure, and the attempt budget is gone. */
  dead: number;
  cancelled: number;
  /** Lost the lease mid-run: another worker owns this job now. */
  abandoned: number;
  /** Leases returned to the pool at the top of the tick. */
  reaped: number;
  /** Orders newly stamped with why they stopped: the day's budget is spent. */
  blocked: number;
}

/** The pinned definition an order runs under, joined to the order in one read. */
interface PinnedDefinition {
  promptTemplate: string;
  outputSchema: Record<string, unknown>;
  model: string;
  temperature: number;
  maxOutputTokens: number;
}

/**
 * A repeating lease renewal that can also report a cancel.
 *
 * `stop()` awaits the beat that may already be in flight before it returns,
 * which is the whole reason this is a class and not two lines of `setInterval`.
 * The runner writes the job's outcome the moment it stops beating, and on a
 * single-connection engine an unawaited beat would collide with that write.
 */
class Heartbeat {
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly beat: () => Promise<HeartbeatState>,
    private readonly onLost: (state: HeartbeatState) => void,
    private readonly everyMs: number,
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      if (this.stopped) return;
      this.inFlight = this.inFlight.then(async () => {
        if (this.stopped) return;
        // A beat that throws is a database blip, not a reason to abandon work
        // that is otherwise going fine; the lease expiring is the backstop.
        const state = await this.beat().catch(() => 'renewed' as HeartbeatState);
        if (state !== 'renewed') this.onLost(state);
      });
    }, this.everyMs);
    // Never hold the process open for a heartbeat.
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    await this.inFlight;
  }
}

/** The definition an order pinned at submit time, by order id. */
async function loadPinnedDefinition(sql: Session, orderId: string): Promise<PinnedDefinition> {
  const [row] = await sql.query<{
    prompt_template: string;
    output_schema: Record<string, unknown> | string;
    model: string;
    temperature: string | number;
    max_output_tokens: number;
  }>(
    `SELECT v.prompt_template, v.output_schema, v.model, v.temperature, v.max_output_tokens
       FROM work_orders AS o
       JOIN workflow_versions AS v ON v.id = o.workflow_version_id
      WHERE o.id = $1`,
    [orderId],
  );
  if (!row) throw new MissingDefinitionError(orderId);
  return {
    promptTemplate: row.prompt_template,
    // `numeric` comes back as a string on the server driver and a number on
    // PGlite; both engines are real Postgres, only the client differs.
    outputSchema:
      typeof row.output_schema === 'string'
        ? (JSON.parse(row.output_schema) as Record<string, unknown>)
        : row.output_schema,
    model: row.model,
    temperature: Number(row.temperature),
    maxOutputTokens: row.max_output_tokens,
  };
}

/**
 * One tick of the runner for one tenant.
 *
 * Reap first, so work lost to a dead worker is back in the pool before this
 * tick claims anything; then claim; then run each item. Returns what happened,
 * so a caller looping on this can stop when a tick claims nothing.
 */
export async function runOnce(
  engine: Engine,
  tenantId: string,
  gateway: GatewayConfig,
  options: RunnerOptions,
): Promise<RunSummary> {
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const heartbeatMs = options.heartbeatMs ?? Math.max(1, Math.floor(leaseMs / 3));
  const random = options.random ?? Math.random;

  const summary: RunSummary = {
    claimed: 0,
    succeeded: 0,
    failed: 0,
    retried: 0,
    dead: 0,
    cancelled: 0,
    abandoned: 0,
    reaped: 0,
    blocked: 0,
  };

  const reaped = await withTenant(engine, tenantId, (sql) => reapExpiredLeases(sql, random));
  summary.reaped = reaped.length;

  // Asked before claiming so the answer can be reported, not so it can be
  // obeyed: the claim enforces it either way. A tick that finds the budget spent
  // stamps the orders that still have work in them and takes nothing.
  const budget = await withTenant(engine, tenantId, (sql) => budgetStatus(sql));
  if (budget.exhausted) {
    summary.blocked = await withTenant(engine, tenantId, (sql) => blockOpenOrders(sql));
    if (summary.blocked > 0 && options.events) {
      // Read back the ids rather than changing what blockOpenOrders returns: an
      // order that says why it stopped is only useful to a dashboard if the
      // dashboard is told which order, and this path runs once per exhausted
      // tick, not once per job.
      const blocked = await withTenant(engine, tenantId, (sql) =>
        sql.query<{ id: string }>(
          "SELECT id FROM work_orders WHERE state = 'open' AND blocked_reason IS NOT NULL",
        ),
      );
      for (const order of blocked) {
        options.events.publish({
          kind: 'order',
          tenantId,
          id: order.id,
          state: 'blocked',
          reason: BUDGET_EXHAUSTED,
        });
      }
    }
    return summary;
  }
  await withTenant(engine, tenantId, (sql) => clearOrderBlocks(sql));

  const jobs = await withTenant(engine, tenantId, (sql) =>
    claimJobs(sql, { limit: batchSize, workerId: options.workerId, leaseMs }),
  );
  summary.claimed = jobs.length;

  for (const job of jobs) {
    options.events?.publish({
      kind: 'job',
      tenantId,
      id: job.id,
      orderId: job.order_id,
      idx: job.idx,
      state: 'running',
    });
    await runClaimedJob(engine, tenantId, gateway, job, summary, {
      workerId: options.workerId,
      leaseMs,
      heartbeatMs,
      random,
      ...(options.events ? { events: options.events } : {}),
    });
  }

  return summary;
}

interface JobRunSettings {
  workerId: string;
  leaseMs: number;
  heartbeatMs: number;
  random: () => number;
  events?: EventBus;
}

async function runClaimedJob(
  engine: Engine,
  tenantId: string,
  gateway: GatewayConfig,
  job: ClaimedJob,
  summary: RunSummary,
  settings: JobRunSettings,
): Promise<void> {
  const definition = await withTenant(engine, tenantId, (sql) =>
    loadPinnedDefinition(sql, job.order_id),
  );

  /** Announce a durable transition. Called only after its write has committed. */
  const announce = (state: string, reason?: string): void => {
    settings.events?.publish({
      kind: 'job',
      tenantId,
      id: job.id,
      orderId: job.order_id,
      idx: job.idx,
      state,
      ...(reason === undefined ? {} : { reason }),
    });
  };

  const controller = new AbortController();
  let lostLease = false;
  let cancelRequested = false;

  const beat = (): Promise<HeartbeatState> =>
    withTenant(engine, tenantId, (sql) =>
      heartbeat(sql, job.id, settings.workerId, settings.leaseMs),
    );

  // One beat before the first token is spent: it both renews the lease and
  // closes the window between the claim committing and the model call starting,
  // in which a cancel could otherwise be missed for a whole heartbeat interval.
  const first = await beat().catch(() => 'renewed' as HeartbeatState);
  if (first === 'lost') {
    summary.abandoned++;
    return;
  }
  if (first === 'cancel-requested') {
    cancelRequested = true;
    controller.abort();
  }

  const pulse = new Heartbeat(
    beat,
    (state) => {
      if (state === 'lost') lostLease = true;
      if (state === 'cancel-requested') cancelRequested = true;
      controller.abort();
    },
    settings.heartbeatMs,
  );
  pulse.start();

  const startedAt = Date.now();
  let result: Awaited<ReturnType<typeof runCompletion>> | undefined;
  let thrown: unknown;
  try {
    result = await runCompletion(gateway, {
      promptTemplate: definition.promptTemplate,
      input: job.input,
      outputSchema: definition.outputSchema,
      model: definition.model,
      temperature: definition.temperature,
      maxOutputTokens: definition.maxOutputTokens,
      signal: controller.signal,
    });
  } catch (error) {
    thrown = error;
  } finally {
    // Stopping first is not tidiness: the writes below must not race a beat on
    // an engine that serves one connection.
    await pulse.stop();
  }
  const latencyMs = Date.now() - startedAt;
  // Narrowing a `let` does not survive into the closures below; these consts do.
  const error = thrown;
  const completion = result;

  if (cancelRequested) {
    // "RUNNING aborts the in-flight model call and records that it did."
    const marked = await withTenant(engine, tenantId, (sql) => markCancelled(sql, job.id));
    if (marked) {
      summary.cancelled++;
      announce('cancelled');
    } else summary.abandoned++;
    return;
  }

  if (lostLease || error instanceof GatewayAbortedError) {
    // Someone else owns this job now. Touching it would be the double-write the
    // lease exists to prevent, so this worker simply walks away.
    summary.abandoned++;
    return;
  }

  if (error !== undefined) {
    if (!(error instanceof GatewayError)) throw error;
    const outcome = await withTenant(engine, tenantId, (sql) =>
      failAttempt(sql, job.id, { kind: 'transport', error: error.message }, settings.random),
    );
    if (outcome.state === 'dead') summary.dead++;
    else summary.retried++;
    // 'retrying' rather than 'pending': the row IS pending, but what a dashboard
    // needs to show is that this item failed and will come back. The reason is
    // the error's CLASS, never its message — a gateway that echoes a prompt back
    // in its error text must not put tenant content on a stream.
    announce(outcome.state === 'dead' ? 'dead' : 'retrying', error.name);
    return;
  }

  if (completion === undefined) throw new Error('runner: completion neither returned nor threw');

  const finished = await withTenant(engine, tenantId, (sql) =>
    finishJob(
      sql,
      job.id,
      completion.ok
        ? {
            ok: true,
            output: completion.value,
            raw: completion.raw,
            model: completion.model,
            attempts: completion.attempts,
            usage: completion.usage,
            latencyMs,
          }
        : {
            ok: false,
            reason: completion.reason,
            errors: completion.errors,
            raw: completion.raw,
            model: completion.model,
            attempts: completion.attempts,
            usage: completion.usage,
            latencyMs,
          },
    ),
  );
  if (finished.state === 'succeeded') summary.succeeded++;
  else summary.failed++;
  announce(finished.state, completion.ok ? undefined : completion.reason);
  if (finished.orderClosed) {
    settings.events?.publish({ kind: 'order', tenantId, id: job.order_id, state: 'done' });
  }
}

/**
 * Drain the queue: tick until one tick claims nothing.
 *
 * `maxTicks` is a guard, not a policy — a runner that cannot make progress
 * should stop rather than spin. There is no sleep and no schedule here: what
 * runs this in a deployment is a systemd timer or the server's own loop, and
 * that is the packaging phase's decision to make.
 */
export async function runUntilIdle(
  engine: Engine,
  tenantId: string,
  gateway: GatewayConfig,
  options: RunnerOptions & { maxTicks?: number },
): Promise<RunSummary> {
  const maxTicks = options.maxTicks ?? 100;
  const total: RunSummary = {
    claimed: 0,
    succeeded: 0,
    failed: 0,
    retried: 0,
    dead: 0,
    cancelled: 0,
    abandoned: 0,
    reaped: 0,
    blocked: 0,
  };
  for (let tick = 0; tick < maxTicks; tick++) {
    const summary = await runOnce(engine, tenantId, gateway, options);
    for (const key of Object.keys(total) as (keyof RunSummary)[]) total[key] += summary[key];
    if (summary.claimed === 0 && summary.reaped === 0) break;
  }
  return total;
}

/** Cancel an order from outside the runner — the verb the dashboard calls. */
export async function cancelOrderNow(
  engine: Engine,
  tenantId: string,
  orderId: string,
): Promise<{ cancelled: number; requested: number }> {
  return withTenant(engine, tenantId, (sql) => cancelOrder(sql, orderId));
}

/** The order pinned a version that no longer resolves — a corrupt row, not a retry. */
export class MissingDefinitionError extends Error {
  constructor(public readonly orderId: string) {
    super(`work order ${orderId} has no resolvable workflow version`);
    this.name = 'MissingDefinitionError';
  }
}
