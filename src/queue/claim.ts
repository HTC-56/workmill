import type { Session } from '../db/engine.js';

/**
 * The claim query — worklane's mechanic, re-proven on Postgres.
 *
 * `FOR UPDATE SKIP LOCKED` inside a subselect is what makes two workers pulling
 * at the same instant hand back disjoint sets instead of blocking or colliding:
 * the second claimant skips rows the first has locked rather than waiting for
 * them. The outer UPDATE then flips exactly those rows to `running` and stamps a
 * lease, all in the claiming transaction, so a worker that dies before COMMIT
 * releases its rows automatically.
 *
 * Delivery is at-least-once and the repo says so out loud: a lease that expires
 * while work is genuinely still in flight will be reclaimed, and the item runs
 * twice. Exactly-once is not on offer here and is not promised anywhere.
 *
 * Jobs come out oldest-due first, and within one order in the position the
 * tenant submitted them. `id` is deliberately not the tiebreaker: every item of
 * an order shares a `created_at`, so a uuid tiebreak would shuffle a five-item
 * order into random order. `(order_id, idx)` is unique, so this is a total one.
 *
 * Every call runs inside withTenant(), so RLS scopes the inner select as well —
 * a claim can only ever see, and can only ever take, the current tenant's jobs.
 */

export interface ClaimedJob {
  id: string;
  order_id: string;
  idx: number;
  input: string;
  attempts: number;
  lease_expires_at: Date;
}

export interface ClaimOptions {
  /** Maximum jobs to take in one call. */
  limit: number;
  /** Identifies the claimant in the row, for operator visibility. */
  workerId: string;
  /** Lease length; the job returns to the pool if it is not finished in time. */
  leaseMs: number;
}

export async function claimJobs(sql: Session, opts: ClaimOptions): Promise<ClaimedJob[]> {
  if (!Number.isInteger(opts.limit) || opts.limit < 1) {
    throw new RangeError(`claim limit must be a positive integer, got ${opts.limit}`);
  }
  if (!Number.isInteger(opts.leaseMs) || opts.leaseMs < 1) {
    throw new RangeError(`lease must be a positive whole number of ms, got ${opts.leaseMs}`);
  }

  return sql.query<ClaimedJob>(
    // `AS MATERIALIZED` is not a hint here, it is the correctness of the LIMIT.
    // Written as a plain `WHERE id IN (SELECT … LIMIT $1)`, the planner is free
    // to treat the subquery as a re-runnable subplan, and when it does, a claim
    // for three jobs takes five: the LIMIT applies to each evaluation, not to
    // the statement. This is not theoretical — the shape held for two phases and
    // then broke the day migration 005 added an index that shifted the plan, and
    // it broke NON-DETERMINISTICALLY, sometimes four rows and sometimes five.
    // MATERIALIZED forces the candidate set to be computed exactly once.
    //
    // The ORDER BY inside that CTE decides WHICH rows are taken. It does not
    // decide what order UPDATE … RETURNING hands them back in — that is
    // undefined in Postgres, and it really does come back shuffled. Wrapping the
    // update in a second CTE and sorting its output by the same keys makes the
    // returned order match the claim order, so no caller has to know this.
    `WITH candidates AS MATERIALIZED (
       SELECT c.id
         FROM jobs AS c
        WHERE c.state = 'pending'
          AND c.run_at <= now()
        ORDER BY c.run_at, c.created_at, c.order_id, c.idx
          FOR UPDATE SKIP LOCKED
        LIMIT $1
     ),
     claimed AS (
       UPDATE jobs AS j
          SET state            = 'running',
              attempts         = j.attempts + 1,
              claimed_by       = $2,
              lease_expires_at = now() + make_interval(secs => $3::double precision / 1000),
              updated_at       = now()
        WHERE j.id IN (SELECT id FROM candidates)
        RETURNING j.id, j.order_id, j.idx, j.input, j.attempts,
                  j.lease_expires_at, j.run_at, j.created_at
     )
     SELECT id, order_id, idx, input, attempts, lease_expires_at
       FROM claimed
      ORDER BY run_at, created_at, order_id, idx`,
    [opts.limit, opts.workerId, opts.leaseMs],
  );
}
