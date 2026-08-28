import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Engine } from '../src/db/engine.js';
import { claimJobs } from '../src/queue/claim.js';
import {
  backoffMs,
  heartbeat,
  finishJob,
  cancelOrder,
  failAttempt,
  requeueJob,
  DEFAULT_MAX_ATTEMPTS,
  JobNotRunningError,
} from '../src/queue/lifecycle.js';
import { enqueueOrder } from '../src/queue/enqueue.js';
import { withAdmin, withTenant } from '../src/seam/withTenant.js';
import { freshDb, makeTenant, type TestTenant } from './helpers/db.js';

/**
 * Lifecycle mechanics for jobs that have been claimed: backoff, heartbeat,
 * finishJob.  §E4 of TASK_PHASE_E.md.
 *
 * Retry with backoff via `failAttempt`, dead-letter at three attempts, and
 * requeue by verb.  §E5 of TASK_PHASE_E.md.
 *
 * No stub gateway is needed — nothing here calls a model.
 */

let db: Engine;
let tenant: TestTenant;
let versionId: string;

const LEASE_MS = 30_000;

beforeAll(async () => {
  db = await freshDb();
  tenant = await makeTenant(db, 'lifecycle');
  versionId = await withAdmin(db, async (sql) => {
    const [workflow] = await sql.query<{ id: string }>(
      "INSERT INTO workflows (tenant_id, slug, name) VALUES ($1, 'lifecycle-fixture', 'Lifecycle fixture') RETURNING id",
      [tenant.id],
    );
    const [version] = await sql.query<{ id: string }>(
      `INSERT INTO workflow_versions
         (tenant_id, workflow_id, version, prompt_template, output_schema, model)
       VALUES ($1, $2, 1, 'Do this: {{input}}', '{"type":"object"}'::jsonb, 'default')
       RETURNING id`,
      [tenant.id, workflow!.id],
    );
    return version!.id;
  });
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await withAdmin(db, (sql) => sql.query('DELETE FROM work_orders WHERE tenant_id = $1', [tenant.id]));
});

async function submit(count: number): Promise<string[]> {
  const { jobIds } = await withTenant(db, tenant.id, (sql) =>
    enqueueOrder(
      sql,
      tenant.id,
      Array.from({ length: count }, (_, i) => `item ${i}`),
      { workflowVersionId: versionId },
    ),
  );
  return jobIds;
}

async function claimOne(workerId: string) {
  const result = await withTenant(db, tenant.id, (sql) =>
    claimJobs(sql, { limit: 1, workerId, leaseMs: LEASE_MS }),
  );
  return result[0]!;
}

// ---------------------------------------------------------------------------
// backoffMs — pure function, no database
// ---------------------------------------------------------------------------

describe('backoffMs — exact under injected random', () => {
  it('attempt 1 with random=0 is 500, attempt 2 is 1000', () => {
    const r = () => 0;
    expect(backoffMs(1, r)).toBe(500);
    expect(backoffMs(2, r)).toBe(1000);
  });

  it('attempt 1 with random=1 is 1000, attempt 3 is 4000', () => {
    const r = () => 1;
    expect(backoffMs(1, r)).toBe(1000);
    expect(backoffMs(3, r)).toBe(4000);
  });
});

describe('backoffMs — clamping', () => {
  it('attempt 0 is treated as attempt 1', () => {
    expect(backoffMs(0, () => 0)).toBe(500);
    expect(backoffMs(0, () => 1)).toBe(1000);
  });

  it('very large attempt count returns MAX_BACKOFF_MS', () => {
    expect(backoffMs(99, () => 1)).toBe(300_000);
  });
});

// ---------------------------------------------------------------------------
// heartbeat
// ---------------------------------------------------------------------------

describe('heartbeat', () => {
  it("renews the lease and returns 'renewed' for this worker", async () => {
    await submit(1);
    const job = await claimOne('w1');
    const before = job.lease_expires_at.getTime();

    const state = await withTenant(db, tenant.id, (sql) => heartbeat(sql, job.id, 'w1', LEASE_MS));
    expect(state).toBe('renewed');

    const afterRows = await withTenant(db, tenant.id, (sql) =>
      sql.query<{ lease_expires_at: Date }>('SELECT lease_expires_at FROM jobs WHERE id = $1', [job.id]),
    );
    expect(afterRows[0]!.lease_expires_at.getTime()).toBeGreaterThan(before);
  });

  it("returns 'lost' when a different workerId tries to renew", async () => {
    await submit(1);
    const job = await claimOne('w1');
    const before = job.lease_expires_at.getTime();

    const state = await withTenant(db, tenant.id, (sql) => heartbeat(sql, job.id, 'w2', LEASE_MS));
    expect(state).toBe('lost');

    const afterRows = await withTenant(db, tenant.id, (sql) =>
      sql.query<{ lease_expires_at: Date }>('SELECT lease_expires_at FROM jobs WHERE id = $1', [job.id]),
    );
    expect(afterRows[0]!.lease_expires_at.getTime()).toBe(before);
  });

  it("returns 'cancel-requested' after cancelOrder stamps the job", async () => {
    await submit(1);
    const job = await claimOne('w1');

    await withTenant(db, tenant.id, (sql) => cancelOrder(sql, job.order_id));

    const state = await withTenant(db, tenant.id, (sql) => heartbeat(sql, job.id, 'w1', LEASE_MS));
    expect(state).toBe('cancel-requested');
  });
});

// ---------------------------------------------------------------------------
// finishJob
// ---------------------------------------------------------------------------

describe('finishJob', () => {
  it('ok=true flips job to succeeded, clears lease_expires_at, writes job_results', async () => {
    await submit(1);
    const job = await claimOne('w1');

    const result = await withTenant(db, tenant.id, (sql) =>
      finishJob(sql, job.id, {
        ok: true,
        output: { answer: 42 },
        raw: '{"answer":42}',
        model: 'default',
        attempts: 1,
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        latencyMs: 150,
      }),
    );

    expect(result.state).toBe('succeeded');
    expect(result.orderClosed).toBe(true);

    const jobRow = await withTenant(db, tenant.id, (sql) =>
      sql.query<{ state: string; lease_expires_at: unknown }>(
        'SELECT state, lease_expires_at FROM jobs WHERE id = $1',
        [job.id],
      ),
    );
    expect(jobRow[0]!.state).toBe('succeeded');
    expect(jobRow[0]!.lease_expires_at).toBeNull();

    const results = await withTenant(db, tenant.id, (sql) =>
      sql.query<{ output: unknown; total_tokens: number; attempts: number }>(
        'SELECT output, total_tokens, attempts FROM job_results WHERE job_id = $1',
        [job.id],
      ),
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.output).toEqual({ answer: 42 });
    expect(results[0]!.total_tokens).toBe(30);
    expect(results[0]!.attempts).toBe(1);
  });

  it('ok=false flips job to failed and writes failure_reason with raw text and errors', async () => {
    await submit(1);
    const job = await claimOne('w1');

    const result = await withTenant(db, tenant.id, (sql) =>
      finishJob(sql, job.id, {
        ok: false,
        reason: 'schema-invalid',
        errors: ['missing field "answer"'],
        raw: '{"foo":"bar"}',
        model: 'default',
        attempts: 1,
        usage: { promptTokens: 5, completionTokens: 10, totalTokens: 15 },
        latencyMs: 80,
      }),
    );

    expect(result.state).toBe('failed');

    const jobRow = await withTenant(db, tenant.id, (sql) =>
      sql.query<{ state: string }>('SELECT state FROM jobs WHERE id = $1', [job.id]),
    );
    expect(jobRow[0]!.state).toBe('failed');

    const results = await withTenant(db, tenant.id, (sql) =>
      sql.query<{ failure_reason: string; raw_output: string; errors: unknown }>(
        'SELECT failure_reason, raw_output, errors FROM job_results WHERE job_id = $1',
        [job.id],
      ),
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.failure_reason).toBe('schema-invalid');
    expect(results[0]!.raw_output).toBe('{"foo":"bar"}');
    expect(results[0]!.errors).toEqual(['missing field "answer"']);
  });

  it('finishJob on a non-running job throws JobNotRunningError', async () => {
    await submit(1);
    const job = await claimOne('w1');

    // Finish it successfully first.
    await withTenant(db, tenant.id, (sql) =>
      finishJob(sql, job.id, {
        ok: true,
        output: { done: true },
        raw: '{"done":true}',
        model: 'default',
        attempts: 1,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        latencyMs: 10,
      }),
    );

    // Now try again — the job is no longer running.
    await expect(
      withTenant(db, tenant.id, (sql) =>
        finishJob(sql, job.id, {
          ok: true,
          output: { again: true },
          raw: '{"again":true}',
          model: 'default',
          attempts: 2,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          latencyMs: 10,
        }),
      ),
    ).rejects.toThrow(JobNotRunningError);
  });
});

// ---------------------------------------------------------------------------
// failAttempt — retry with backoff, dead-letter at three attempts
// ---------------------------------------------------------------------------

/**
 * Run `n` claim-then-fail rounds on a single job.
 *
 * `failAttempt` sets `run_at` in the future (backoff). Between rounds we reset
 * `run_at = now()` so the next claim can actually find the job — this simulates
 * the backoff period elapsing.
 */
async function claimThenFail(workerId: string, jobId: string, rounds: number) {
  for (let i = 0; i < rounds; i++) {
    await withTenant(db, tenant.id, (sql) =>
      claimJobs(sql, { limit: 1, workerId, leaseMs: LEASE_MS }),
    );
    await withTenant(db, tenant.id, (sql) =>
      failAttempt(sql, jobId, { kind: 'transport', error: 'timeout' }, () => 0),
    );
    // Reset run_at so the next claim can find the job again.
    await withTenant(db, tenant.id, (sql) =>
      sql.query("UPDATE jobs SET run_at = now() WHERE id = $1", [jobId]),
    );
  }
}

describe('failAttempt — retry with backoff', () => {
  it('returns pending with positive backoffMs, clears the lease, leaves run_at in the future', async () => {
    await submit(1);
    const job = await claimOne('w1');

    const result = await withTenant(db, tenant.id, (sql) =>
      failAttempt(sql, job.id, { kind: 'transport', error: 'connection refused' }, () => 0),
    );

    expect(result.state).toBe('pending');
    expect(result.backoffMs).toBeGreaterThan(0);

    const jobRow = await withTenant(db, tenant.id, (sql) =>
      sql.query<{ state: string; lease_expires_at: unknown; run_at: Date }>(
        'SELECT state, lease_expires_at, run_at FROM jobs WHERE id = $1',
        [job.id],
      ),
    );
    expect(jobRow[0]!.state).toBe('pending');
    expect(jobRow[0]!.lease_expires_at).toBeNull();
    expect(jobRow[0]!.run_at.getTime()).toBeGreaterThan(Date.now());
  });

  it('appends exactly one entry to failure_trail with the passed kind and error', async () => {
    await submit(1);
    const job = await claimOne('w1');

    await withTenant(db, tenant.id, (sql) =>
      failAttempt(sql, job.id, { kind: 'transport', error: 'connection refused' }, () => 0),
    );

    const trail = await withTenant(db, tenant.id, (sql) =>
      sql.query<{ failure_trail: unknown }>('SELECT failure_trail FROM jobs WHERE id = $1', [job.id]),
    );
    const entries = trail[0]!.failure_trail as Array<{ attempt: number; kind: string; error: string }>;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe('transport');
    expect(entries[0]!.error).toBe('connection refused');
  });
});

describe('failAttempt — dead-letter at three attempts', () => {
  it('three successive claim-then-fail rounds put the job in dead with dead_at and three-entry trail', async () => {
    await submit(1);
    const job = await claimOne('w1');

    // Each round: claim (increments attempts) → fail (sets pending+backoff).
    await claimThenFail('w1', job.id, DEFAULT_MAX_ATTEMPTS);

    const jobRow = await withTenant(db, tenant.id, (sql) =>
      sql.query<{ state: string; dead_at: unknown }>(
        'SELECT state, dead_at FROM jobs WHERE id = $1',
        [job.id],
      ),
    );
    expect(jobRow[0]!.state).toBe('dead');
    expect(jobRow[0]!.dead_at).not.toBeNull();

    const trail = await withTenant(db, tenant.id, (sql) =>
      sql.query<{ failure_trail: unknown }>('SELECT failure_trail FROM jobs WHERE id = $1', [job.id]),
    );
    const entries = trail[0]!.failure_trail as Array<unknown>;
    expect(entries).toHaveLength(DEFAULT_MAX_ATTEMPTS);
  });

  it('a dead job is not claimable', async () => {
    await submit(1);
    const job = await claimOne('w1');
    await claimThenFail('w1', job.id, DEFAULT_MAX_ATTEMPTS);

    const result = await withTenant(db, tenant.id, (sql) =>
      claimJobs(sql, { limit: 1, workerId: 'w2', leaseMs: LEASE_MS }),
    );
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// requeueJob — revive a dead/failed job, reject pending ones
// ---------------------------------------------------------------------------

describe('requeueJob', () => {
  async function makeDeadJob() {
    await submit(1);
    const job = await claimOne('w1');
    await claimThenFail('w1', job.id, DEFAULT_MAX_ATTEMPTS);
    return job.id;
  }

  it('on a dead job returns true, resets state to pending with attempts 0, clears dead_at, keeps trail + requeued entry', async () => {
    const jobId = await makeDeadJob();

    const trailBefore = await withTenant(db, tenant.id, (sql) =>
      sql.query<{ failure_trail: unknown }>('SELECT failure_trail FROM jobs WHERE id = $1', [jobId]),
    );
    const trailEntries = trailBefore[0]!.failure_trail as Array<unknown>;

    const result = await withTenant(db, tenant.id, (sql) => requeueJob(sql, jobId));
    expect(result).toBe(true);

    const jobRow = await withTenant(db, tenant.id, (sql) =>
      sql.query<{ state: string; attempts: number; dead_at: unknown }>(
        'SELECT state, attempts, dead_at FROM jobs WHERE id = $1',
        [jobId],
      ),
    );
    expect(jobRow[0]!.state).toBe('pending');
    expect(jobRow[0]!.attempts).toBe(0);
    expect(jobRow[0]!.dead_at).toBeNull();

    const trailAfter = await withTenant(db, tenant.id, (sql) =>
      sql.query<{ failure_trail: unknown }>('SELECT failure_trail FROM jobs WHERE id = $1', [jobId]),
    );
    const afterEntries = trailAfter[0]!.failure_trail as Array<{ kind: string }>;
    expect(afterEntries).toHaveLength(trailEntries.length + 1);
    expect(afterEntries[afterEntries.length - 1]!.kind).toBe('requeued');
  });

  it('on a pending job returns false and changes nothing', async () => {
    await submit(1);
    const job = await claimOne('w1');

    const beforeState = await withTenant(db, tenant.id, (sql) =>
      sql.query<{ state: string }>('SELECT state FROM jobs WHERE id = $1', [job.id]),
    );

    const result = await withTenant(db, tenant.id, (sql) => requeueJob(sql, job.id));
    expect(result).toBe(false);

    const afterState = await withTenant(db, tenant.id, (sql) =>
      sql.query<{ state: string }>('SELECT state FROM jobs WHERE id = $1', [job.id]),
    );
    expect(afterState[0]!.state).toBe(beforeState[0]!.state);
  });

  it('requeueing an item of a closed order puts the order back to open', async () => {
    await submit(3);
    const jobs = await withTenant(db, tenant.id, (sql) =>
      sql.query<{ id: string }>('SELECT id FROM jobs WHERE tenant_id = $1 ORDER BY idx', [tenant.id]),
    );
    expect(jobs).toHaveLength(3);

    // Each job needs one claim-then-fail round to become dead (claim increments
    // attempts to 1, fail reads attempts=1 < max=3 → pending; then repeat until
    // attempts >= max_attempts).  We process every job each round.
    for (let round = 0; round < DEFAULT_MAX_ATTEMPTS; round++) {
      for (const { id } of jobs) {
        await withTenant(db, tenant.id, (sql) =>
          claimJobs(sql, { limit: 1, workerId: 'w1', leaseMs: LEASE_MS }),
        );
        await withTenant(db, tenant.id, (sql) =>
          failAttempt(sql, id, { kind: 'transport', error: 'close' }, () => 0),
        );
        await withTenant(db, tenant.id, (sql) =>
          sql.query("UPDATE jobs SET run_at = now() WHERE id = $1", [id]),
        );
      }
    }

    // Order should be closed now.
    const orderState = await withTenant(db, tenant.id, (sql) =>
      sql.query<{ state: string }>('SELECT state FROM work_orders WHERE tenant_id = $1', [tenant.id]),
    );
    expect(orderState[0]!.state).toBe('done');

    // Requeue one dead job.
    const result = await withTenant(db, tenant.id, (sql) => requeueJob(sql, jobs[0]!.id));
    expect(result).toBe(true);

    // Order should be open again.
    const orderStateAfter = await withTenant(db, tenant.id, (sql) =>
      sql.query<{ state: string }>('SELECT state FROM work_orders WHERE tenant_id = $1', [tenant.id]),
    );
    expect(orderStateAfter[0]!.state).toBe('open');
  });
});
