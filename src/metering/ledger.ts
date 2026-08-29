import type { Session } from '../db/engine.js';
import type { TokenUsage } from '../gateway/client.js';

/**
 * The per-tenant token ledger (SPEC.md feature 5).
 *
 * `job_results` already records what one job cost. This module is the same
 * numbers arranged for the question the budget asks — how much has this tenant
 * spent today — so the check the claim query runs is an index lookup and a sum
 * rather than a join across results and jobs.
 *
 * Every function here takes a `Session` from `withTenant()`, so RLS scopes each
 * one: a ledger read can only ever see the current tenant's spend, and a write
 * can only ever attribute spend to the current tenant. Nothing here opens a
 * transaction of its own — `recordUsage` runs inside the same transaction that
 * writes the result, so a job can never be reported as done without being
 * billed, or billed without being done.
 *
 * Delivery is at-least-once, so the ledger is keyed by `job_id` and upserts: a
 * job whose lease expired and ran again replaces its row instead of being
 * charged twice. That is the same rule `job_results` follows, for the same
 * reason.
 */

/** One job's spend, as the runner knows it when the model has answered. */
export interface UsageEntry {
  jobId: string;
  orderId: string;
  /** The model the gateway reported running, matching `job_results.model`. */
  model: string;
  usage: TokenUsage;
}

/** A day's spend, for the usage meter and the operator's fleet panel. */
export interface DailyUsage {
  /** The UTC day, as `YYYY-MM-DD`. */
  day: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  jobs: number;
}

/**
 * Write (or replace) one job's spend.
 *
 * The `usage_day` is left to the column default rather than passed in, so every
 * row in the table is stamped by the same expression and a caller cannot
 * accidentally bill a job to yesterday. An upsert re-stamps it, because a
 * re-run's tokens were spent on the day of the re-run.
 */
export async function recordUsage(sql: Session, entry: UsageEntry): Promise<void> {
  await sql.query(
    `INSERT INTO token_ledger
       (tenant_id, job_id, order_id, model, prompt_tokens, completion_tokens, total_tokens)
     SELECT j.tenant_id, j.id, $2, $3, $4, $5, $6
       FROM jobs AS j
      WHERE j.id = $1
     ON CONFLICT (job_id) DO UPDATE SET
       usage_day         = ((now() AT TIME ZONE 'UTC')::date),
       model             = EXCLUDED.model,
       prompt_tokens     = EXCLUDED.prompt_tokens,
       completion_tokens = EXCLUDED.completion_tokens,
       total_tokens      = EXCLUDED.total_tokens,
       created_at        = now()`,
    [
      entry.jobId,
      entry.orderId,
      entry.model,
      Math.max(0, Math.round(entry.usage.promptTokens)),
      Math.max(0, Math.round(entry.usage.completionTokens)),
      Math.max(0, Math.round(entry.usage.totalTokens)),
    ],
  );
}

/**
 * Total tokens the current tenant has spent on the current UTC day.
 *
 * The day boundary is UTC everywhere in this feature. A budget that reset at
 * the server's local midnight would reset at a different instant on every
 * deployment, and "your budget resets at midnight" would mean something
 * different on each box.
 */
export async function tokensUsedToday(sql: Session): Promise<number> {
  const [row] = await sql.query<{ used: string | number }>(
    `SELECT COALESCE(sum(total_tokens), 0) AS used
       FROM token_ledger
      WHERE usage_day = ((now() AT TIME ZONE 'UTC')::date)`,
  );
  return Number(row?.used ?? 0);
}

/** Total tokens one order has cost so far — the per-item cost, summed. */
export async function tokensUsedForOrder(sql: Session, orderId: string): Promise<number> {
  const [row] = await sql.query<{ used: string | number }>(
    'SELECT COALESCE(sum(total_tokens), 0) AS used FROM token_ledger WHERE order_id = $1',
    [orderId],
  );
  return Number(row?.used ?? 0);
}

/**
 * The last `days` UTC days of spend, most recent first. Days with no spend are
 * simply absent — this is a ledger, not a calendar.
 */
export async function usageByDay(sql: Session, days = 30): Promise<DailyUsage[]> {
  if (!Number.isInteger(days) || days < 1) {
    throw new RangeError(`days must be a positive integer, got ${days}`);
  }
  const rows = await sql.query<{
    day: string | Date;
    prompt_tokens: string | number;
    completion_tokens: string | number;
    total_tokens: string | number;
    jobs: string | number;
  }>(
    `SELECT usage_day AS day,
            sum(prompt_tokens)     AS prompt_tokens,
            sum(completion_tokens) AS completion_tokens,
            sum(total_tokens)      AS total_tokens,
            count(*)               AS jobs
       FROM token_ledger
      WHERE usage_day > ((now() AT TIME ZONE 'UTC')::date - $1::int)
      GROUP BY usage_day
      ORDER BY usage_day DESC`,
    [days],
  );
  return rows.map((row) => ({
    // `date` comes back as a string on the server driver and a Date on PGlite;
    // both engines are real Postgres, only the client differs.
    day: row.day instanceof Date ? row.day.toISOString().slice(0, 10) : String(row.day).slice(0, 10),
    promptTokens: Number(row.prompt_tokens),
    completionTokens: Number(row.completion_tokens),
    totalTokens: Number(row.total_tokens),
    jobs: Number(row.jobs),
  }));
}
