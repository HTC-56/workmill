import type { Session } from '../db/engine.js';
import type { TokenUsage } from '../gateway/client.js';

/**
 * Everything that happens to a job after it is claimed (SPEC.md feature 3).
 *
 * `claim.ts` takes work out of the queue. This file is the other side of that
 * transaction: renewing a lease while work is genuinely in flight, writing down
 * what the model said, putting a job back with a backoff when the hop failed,
 * retiring it to the dead-letter, requeueing it by verb, and cancelling it.
 *
 * Every function here takes a `Session` from `withTenant()`, so RLS scopes each
 * one: a lifecycle call can only ever move the current tenant's jobs. Nothing
 * here opens a transaction of its own.
 *
 * Two failure words, and they are not synonyms (see the header of
 * `sql/005_runner.sql`). A job is **failed** when the model answered but the
 * answer never validated — a content outcome, terminal, and `job_results` holds
 * the raw text and the validation errors. A job is **dead** when we could not
 * get an answer at all after `max_attempts` transport failures — an
 * infrastructure outcome, retryable by hand, and what the dead-letter view
 * lists. Only the second one goes through the backoff.
 *
 * Delivery is at-least-once and this file is where that shows: a lease that
 * expires while work is still in flight is reclaimed, so the item can run
 * twice, so `job_results` upserts on `job_id` instead of accumulating rows.
 */

/** Matches the `max_attempts` column default in sql/005. */
export const DEFAULT_MAX_ATTEMPTS = 3;

/** First retry waits about a second. */
export const BASE_BACKOFF_MS = 1_000;

/** No retry ever waits longer than five minutes, however many attempts in. */
export const MAX_BACKOFF_MS = 300_000;

/** How a run ended badly. The kind is stored verbatim in the failure trail. */
export type FailureKind = 'transport' | 'lease-expired' | 'cancelled' | 'requeued';

/** What a heartbeat learned about the job it just renewed. */
export type HeartbeatState = 'renewed' | 'cancel-requested' | 'lost';

/** The outcome of a completed model run — what `job_results` records. */
export type JobOutcome =
  | {
      ok: true;
      output: Record<string, unknown>;
      raw: string;
      model: string;
      attempts: number;
      usage: TokenUsage;
      latencyMs: number;
    }
  | {
      ok: false;
      reason: 'unparseable' | 'schema-invalid';
      errors: readonly string[];
      raw: string;
      model: string;
      attempts: number;
      usage: TokenUsage;
      latencyMs: number;
    };

/** What `failAttempt` decided: back into the pool, or into the dead-letter. */
export interface AttemptFailure {
  state: 'pending' | 'dead';
  attempts: number;
  /** Zero when the job went dead — there is no next run. */
  backoffMs: number;
}

/** Counts by state for one order, plus the order's own state. */
export interface OrderProgress {
  orderState: 'open' | 'done' | 'cancelled';
  total: number;
  pending: number;
  running: number;
  succeeded: number;
  failed: number;
  dead: number;
  cancelled: number;
}

/** What a cancel actually did, since a running job can only be asked. */
export interface CancelResult {
  /** Pending jobs, flipped straight to cancelled. */
  cancelled: number;
  /** Running jobs, stamped for the runner's heartbeat to notice. */
  requested: number;
}

/**
 * Exponential backoff with jitter, as a pure function of the attempt count.
 *
 * The ceiling doubles per attempt from `BASE_BACKOFF_MS` and stops at
 * `MAX_BACKOFF_MS`; the wait is a uniform draw from the top half of that
 * ceiling. Half fixed and half random rather than fully random for two reasons:
 * a fully random draw can return zero, which retries a broken gateway
 * instantly, and a fixed wait synchronises every job of a hundred-item order
 * into one thundering herd the moment the gateway comes back.
 *
 * `random` is injectable so the law can be asserted exactly rather than
 * sampled: with `() => 0` attempt 1 waits 500ms and attempt 2 waits 1000ms,
 * with `() => 1` they wait 1000ms and 2000ms.
 */
export function backoffMs(attempts: number, random: () => number = Math.random): number {
  const n = Number.isFinite(attempts) && attempts > 1 ? Math.floor(attempts) : 1;
  // 2 ** 30 already exceeds the ceiling; clamping the exponent keeps the
  // doubling from overflowing into Infinity on an absurd attempt count.
  const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.min(n - 1, 30));
  const half = ceiling / 2;
  return Math.round(half + random() * half);
}

/** Failure text is diagnostic, not an archive; a runaway error cannot bloat a row. */
const MAX_ERROR_CHARS = 2_000;

function trimError(error: string): string {
  return error.length > MAX_ERROR_CHARS ? `${error.slice(0, MAX_ERROR_CHARS)}…` : error;
}

/**
 * Renew the lease on a job this worker is running, and report what the row says
 * about cancellation in the same round trip.
 *
 * The `claimed_by` match is the point: a worker whose lease already expired and
 * was reaped by someone else gets `'lost'` and must stop, rather than finishing
 * work a second worker is now also doing. A cancel request renews the lease too
 * — the job is still running until the runner has aborted it and said so.
 */
export async function heartbeat(
  sql: Session,
  jobId: string,
  workerId: string,
  leaseMs: number,
): Promise<HeartbeatState> {
  if (!Number.isInteger(leaseMs) || leaseMs < 1) {
    throw new RangeError(`lease must be a positive whole number of ms, got ${leaseMs}`);
  }
  const [row] = await sql.query<{ cancel_requested_at: Date | null }>(
    `UPDATE jobs
        SET lease_expires_at = now() + make_interval(secs => $3::double precision / 1000),
            updated_at       = now()
      WHERE id = $1 AND state = 'running' AND claimed_by = $2
      RETURNING cancel_requested_at`,
    [jobId, workerId, leaseMs],
  );
  if (!row) return 'lost';
  return row.cancel_requested_at === null ? 'renewed' : 'cancel-requested';
}

/**
 * The model answered — record what it said and retire the job.
 *
 * A valid answer makes the job `succeeded`; an answer that never validated
 * after the bounded re-ask makes it `failed`. Both write a `job_results` row,
 * because a tenant looking at an item that did not validate needs to see the
 * text that came back and the errors it produced.
 *
 * The upsert is at-least-once delivery made explicit: if this job already ran
 * once under a lease that expired, the second run replaces the first result
 * rather than adding a row the unique constraint would refuse.
 */
export async function finishJob(
  sql: Session,
  jobId: string,
  outcome: JobOutcome,
): Promise<{ state: 'succeeded' | 'failed'; orderClosed: boolean }> {
  const state = outcome.ok ? 'succeeded' : 'failed';
  const [job] = await sql.query<{ order_id: string; tenant_id: string }>(
    `UPDATE jobs
        SET state            = $2,
            lease_expires_at = NULL,
            last_error       = $3,
            updated_at       = now()
      WHERE id = $1 AND state = 'running'
      RETURNING order_id, tenant_id`,
    [jobId, state, outcome.ok ? null : trimError(outcome.errors.join('; '))],
  );
  if (!job) throw new JobNotRunningError(jobId);

  await sql.query(
    `INSERT INTO job_results
       (tenant_id, job_id, ok, output, raw_output, failure_reason, errors, model,
        attempts, prompt_tokens, completion_tokens, total_tokens, latency_ms)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (job_id) DO UPDATE SET
       ok = EXCLUDED.ok, output = EXCLUDED.output, raw_output = EXCLUDED.raw_output,
       failure_reason = EXCLUDED.failure_reason, errors = EXCLUDED.errors,
       model = EXCLUDED.model, attempts = EXCLUDED.attempts,
       prompt_tokens = EXCLUDED.prompt_tokens,
       completion_tokens = EXCLUDED.completion_tokens,
       total_tokens = EXCLUDED.total_tokens, latency_ms = EXCLUDED.latency_ms,
       created_at = now()`,
    [
      job.tenant_id,
      jobId,
      outcome.ok,
      outcome.ok ? JSON.stringify(outcome.output) : null,
      outcome.raw,
      outcome.ok ? null : outcome.reason,
      JSON.stringify(outcome.ok ? [] : outcome.errors.map(trimError)),
      outcome.model,
      outcome.attempts,
      outcome.usage.promptTokens,
      outcome.usage.completionTokens,
      outcome.usage.totalTokens,
      Math.max(0, Math.round(outcome.latencyMs)),
    ],
  );

  return { state, orderClosed: await closeOrderIfComplete(sql, job.order_id) };
}

/**
 * The hop to the model failed — decide whether this job gets another turn.
 *
 * Under `max_attempts`, the job goes back to `pending` with a `run_at` in the
 * future, so the claim query simply will not see it until the backoff has
 * elapsed; there is no sleeping worker and no separate retry queue. At the
 * budget, it goes to `dead` with its stamp, and only a requeue moves it again.
 * Either way the attempt is appended to `failure_trail`.
 */
export async function failAttempt(
  sql: Session,
  jobId: string,
  failure: { kind: FailureKind; error: string },
  random: () => number = Math.random,
): Promise<AttemptFailure> {
  const [current] = await sql.query<{ attempts: number; max_attempts: number; state: string }>(
    'SELECT attempts, max_attempts, state FROM jobs WHERE id = $1',
    [jobId],
  );
  if (!current) throw new JobNotRunningError(jobId);

  const exhausted = current.attempts >= current.max_attempts;
  const wait = exhausted ? 0 : backoffMs(current.attempts, random);

  const [row] = await sql.query<{ state: string; attempts: number }>(
    // Every parameter inside jsonb_build_object is cast explicitly: an untyped
    // `$n` there is `unknown` to the planner, and Postgres refuses the statement
    // with "could not determine data type" rather than guessing text.
    `UPDATE jobs
        SET state            = CASE WHEN $4::boolean THEN 'dead' ELSE 'pending' END,
            dead_at          = CASE WHEN $4::boolean THEN now() ELSE NULL END,
            lease_expires_at = NULL,
            run_at           = now(),
            last_error       = $3::text,
            failure_trail    = failure_trail || jsonb_build_array(jsonb_build_object(
                                 'attempt', attempts, 'at', now(),
                                 'kind', $2::text, 'error', $3::text)),
            updated_at       = now()
      WHERE id = $1
      RETURNING state, attempts`,
    [jobId, failure.kind, trimError(failure.error), exhausted],
  );
  if (!row) throw new JobNotRunningError(jobId);

  if (row.state === 'dead') await closeOrderIfCompleteById(sql, jobId);
  return {
    state: row.state === 'dead' ? 'dead' : 'pending',
    attempts: row.attempts,
    backoffMs: wait,
  };
}

/**
 * Return jobs whose lease ran out to the pool.
 *
 * A worker that died mid-call leaves a `running` row nobody is working on. This
 * is the only thing that notices, and it treats the expiry as one failed
 * attempt: same backoff, same trail, same dead-letter at the budget. Run it at
 * the top of a runner tick, before claiming, so lost work is back in the queue
 * before new work is taken out.
 */
export async function reapExpiredLeases(
  sql: Session,
  random: () => number = Math.random,
): Promise<AttemptFailure[]> {
  const expired = await sql.query<{ id: string }>(
    `SELECT id FROM jobs
      WHERE state = 'running' AND lease_expires_at < now()
      ORDER BY lease_expires_at`,
  );
  const results: AttemptFailure[] = [];
  for (const { id } of expired) {
    results.push(
      await failAttempt(sql, id, { kind: 'lease-expired', error: 'lease expired mid-run' }, random),
    );
  }
  return results;
}

/**
 * Requeue by verb (SPEC.md feature 3): a dead or failed job gets a fresh
 * attempt budget and goes back into the pool immediately.
 *
 * `attempts` resets so the job gets its full retry budget again; the trail does
 * not, because it is the record of what already happened and losing it would
 * make a second death indistinguishable from a first. Requeueing an item of a
 * closed order reopens the order — otherwise the work would run with nothing
 * left to report into.
 */
export async function requeueJob(sql: Session, jobId: string): Promise<boolean> {
  const [row] = await sql.query<{ order_id: string }>(
    `UPDATE jobs
        SET state            = 'pending',
            dead_at          = NULL,
            lease_expires_at = NULL,
            attempts         = 0,
            run_at           = now(),
            failure_trail    = failure_trail || jsonb_build_array(jsonb_build_object(
                                 'attempt', attempts, 'at', now(),
                                 'kind', 'requeued', 'error', last_error)),
            updated_at       = now()
      WHERE id = $1 AND state IN ('dead', 'failed')
      RETURNING order_id`,
    [jobId],
  );
  if (!row) return false;
  await sql.query(
    `UPDATE work_orders SET state = 'open' WHERE id = $1 AND state = 'done'`,
    [row.order_id],
  );
  return true;
}

/**
 * Real cancel (SPEC.md feature 3): pending items flip, running items are asked.
 *
 * A pending job is not being worked on by anyone, so it becomes `cancelled` in
 * this transaction. A running job belongs to a process that is mid-call, so all
 * this can do is stamp `cancel_requested_at`; the runner's heartbeat reads it,
 * aborts the in-flight model call, and calls `markCancelled` to record that it
 * did. The order goes to `cancelled` either way, so nothing new is claimed.
 */
export async function cancelOrder(sql: Session, orderId: string): Promise<CancelResult> {
  const cancelled = await sql.query<{ id: string }>(
    `UPDATE jobs SET state = 'cancelled', lease_expires_at = NULL, updated_at = now()
      WHERE order_id = $1 AND state = 'pending' RETURNING id`,
    [orderId],
  );
  const requested = await sql.query<{ id: string }>(
    `UPDATE jobs SET cancel_requested_at = now(), updated_at = now()
      WHERE order_id = $1 AND state = 'running' AND cancel_requested_at IS NULL
      RETURNING id`,
    [orderId],
  );
  await sql.query(
    `UPDATE work_orders SET state = 'cancelled' WHERE id = $1 AND state <> 'cancelled'`,
    [orderId],
  );
  return { cancelled: cancelled.length, requested: requested.length };
}

/**
 * Record that a running job really did stop because it was cancelled — the
 * "and records that it did" half of SPEC.md's cancel. The trail entry is what
 * distinguishes a job abandoned mid-call from one that was never started.
 */
export async function markCancelled(sql: Session, jobId: string): Promise<boolean> {
  const [row] = await sql.query<{ id: string }>(
    `UPDATE jobs
        SET state            = 'cancelled',
            lease_expires_at = NULL,
            last_error       = 'cancelled while running',
            failure_trail    = failure_trail || jsonb_build_array(jsonb_build_object(
                                 'attempt', attempts, 'at', now(),
                                 'kind', 'cancelled', 'error', 'aborted mid-call')),
            updated_at       = now()
      WHERE id = $1 AND state = 'running'
      RETURNING id`,
    [jobId],
  );
  return row !== undefined;
}

/** Counts by state for one order — what a progress bar and the runner both read. */
export async function orderProgress(sql: Session, orderId: string): Promise<OrderProgress> {
  const [order] = await sql.query<{ state: OrderProgress['orderState'] }>(
    'SELECT state FROM work_orders WHERE id = $1',
    [orderId],
  );
  if (!order) throw new OrderNotFoundError(orderId);
  const rows = await sql.query<{ state: string; n: string | number }>(
    'SELECT state, count(*) AS n FROM jobs WHERE order_id = $1 GROUP BY state',
    [orderId],
  );
  const progress: OrderProgress = {
    orderState: order.state,
    total: 0,
    pending: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    dead: 0,
    cancelled: 0,
  };
  for (const row of rows) {
    const n = Number(row.n);
    progress.total += n;
    if (row.state in progress) {
      (progress as unknown as Record<string, number>)[row.state] = n;
    }
  }
  return progress;
}

/**
 * An order is done when nothing is left to run in it. Only an `open` order
 * closes: a cancelled order stays cancelled even once its running items stop.
 */
async function closeOrderIfComplete(sql: Session, orderId: string): Promise<boolean> {
  const [row] = await sql.query<{ id: string }>(
    `UPDATE work_orders SET state = 'done'
      WHERE id = $1 AND state = 'open'
        AND NOT EXISTS (
          SELECT 1 FROM jobs
           WHERE order_id = $1 AND state IN ('pending', 'running'))
      RETURNING id`,
    [orderId],
  );
  return row !== undefined;
}

async function closeOrderIfCompleteById(sql: Session, jobId: string): Promise<boolean> {
  const [row] = await sql.query<{ order_id: string }>(
    'SELECT order_id FROM jobs WHERE id = $1',
    [jobId],
  );
  return row ? closeOrderIfComplete(sql, row.order_id) : false;
}

/** The job is not in the state this transition needs — a lost lease, usually. */
export class JobNotRunningError extends Error {
  constructor(public readonly jobId: string) {
    super(`job ${jobId} is not claimable for this transition (lost lease, or not this tenant's)`);
    this.name = 'JobNotRunningError';
  }
}

export class OrderNotFoundError extends Error {
  constructor(public readonly orderId: string) {
    super(`no such work order: ${orderId}`);
    this.name = 'OrderNotFoundError';
  }
}
