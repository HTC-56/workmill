import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Engine } from '../src/db/engine.js';
import { claimJobs } from '../src/queue/claim.js';
import {
  backoffMs,
  heartbeat,
  finishJob,
  cancelOrder,
  JobNotRunningError,
} from '../src/queue/lifecycle.js';
import { enqueueOrder } from '../src/queue/enqueue.js';
import { withAdmin, withTenant } from '../src/seam/withTenant.js';
import { freshDb, makeTenant, type TestTenant } from './helpers/db.js';

/**
 * Lifecycle mechanics for jobs that have been claimed: backoff, heartbeat,
 * finishJob.  §E4 of TASK_PHASE_E.md.
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
      sql.query<{ state: string; lease_expires_at: unknown }>('SELECT state, lease_expires_at FROM jobs WHERE id = $1', [job.id]),
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
