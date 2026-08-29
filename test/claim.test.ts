import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Engine } from '../src/db/engine.js';
import { claimJobs } from '../src/queue/claim.js';
import { enqueueOrder } from '../src/queue/enqueue.js';
import { withAdmin, withTenant } from '../src/seam/withTenant.js';
import { freshDb, makeTenant, type TestTenant } from './helpers/db.js';
import { provisionTenant } from '../src/tenancy/provision.js';
import { recordUsage } from '../src/metering/ledger.js';

/**
 * The second load-bearing mechanism (SPEC.md "Engines & seams"): the
 * `FOR UPDATE SKIP LOCKED` claim.
 *
 * The serial half runs on both engines. The two-competing-claimants half needs
 * two live transactions at once, which PGlite — one connection — cannot express;
 * it is skipped there and recorded in DECISIONS.md, never silently dropped.
 */

/** True when the configured engine is a real server. Needed at collection time. */
const CONCURRENT = Boolean(process.env.DATABASE_URL);

let db: Engine;
let tenant: TestTenant;
/** Since sql/005 an order must pin a workflow version, so the suite makes one. */
let versionId: string;

const LEASE_MS = 30_000;

beforeAll(async () => {
  db = await freshDb();
  tenant = await makeTenant(db, 'claimant');
  versionId = await withAdmin(db, async (sql) => {
    const [workflow] = await sql.query<{ id: string }>(
      "INSERT INTO workflows (tenant_id, slug, name) VALUES ($1, 'claim-fixture', 'Claim fixture') RETURNING id",
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

const claim = (limit: number, workerId: string) =>
  withTenant(db, tenant.id, (sql) => claimJobs(sql, { limit, workerId, leaseMs: LEASE_MS }));

describe('claiming, on either engine', () => {
  it('hands out each job exactly once across successive claims', async () => {
    const jobIds = await submit(5);

    const first = await claim(3, 'w1');
    const second = await claim(3, 'w2');
    const third = await claim(3, 'w3');

    expect(first).toHaveLength(3);
    expect(second).toHaveLength(2);
    expect(third).toHaveLength(0);

    const handed = [...first, ...second].map((j) => j.id);
    expect(new Set(handed).size).toBe(5);
    expect([...handed].sort()).toEqual([...jobIds].sort());
  });

  it('claims in submitted order and marks rows running under a lease', async () => {
    await submit(3);
    const claimed = await claim(3, 'w1');

    expect(claimed.map((j) => j.idx)).toEqual([0, 1, 2]);
    for (const job of claimed) {
      expect(job.attempts).toBe(1);
      expect(job.lease_expires_at.getTime()).toBeGreaterThan(Date.now());
    }

    const rows = await withTenant(db, tenant.id, (sql) =>
      sql.query<{ state: string; claimed_by: string }>('SELECT state, claimed_by FROM jobs'),
    );
    expect(rows.every((r) => r.state === 'running')).toBe(true);
    expect(rows.every((r) => r.claimed_by === 'w1')).toBe(true);
  });

  it('never hands out a job that is not yet due', async () => {
    await submit(2);
    await withAdmin(db, (sql) =>
      sql.query("UPDATE jobs SET run_at = now() + interval '1 hour' WHERE tenant_id = $1", [
        tenant.id,
      ]),
    );
    expect(await claim(10, 'w1')).toHaveLength(0);
  });

  it("cannot claim another tenant's jobs even with an unscoped query", async () => {
    await submit(3);
    const other = await makeTenant(db, 'bystander');
    expect(await claim(10, 'w1')).toHaveLength(3);

    // A fresh claim as the other tenant sees an empty queue: RLS scopes the
    // SKIP LOCKED subselect too, so the queue is inside the tenant boundary.
    const stolen = await withTenant(db, other.id, (sql) =>
      claimJobs(sql, { limit: 10, workerId: 'thief', leaseMs: LEASE_MS }),
    );
    expect(stolen).toHaveLength(0);
  });

  it('rejects nonsense claim parameters before touching the database', async () => {
    await expect(claim(0, 'w1')).rejects.toThrow(RangeError);
    await expect(
      withTenant(db, tenant.id, (sql) =>
        claimJobs(sql, { limit: 1, workerId: 'w1', leaseMs: 0 }),
      ),
    ).rejects.toThrow(RangeError);
  });
});

it('ties the concurrency skip to the engine, not to a flag', () => {
  // If this ever disagrees, the authoritative Postgres job is skipping the
  // cases it exists to run, and would do it silently. SPEC.md forbids silent.
  expect(db.supportsConcurrentSessions).toBe(CONCURRENT);
});

describe.skipIf(!CONCURRENT)('two competing claimants (real Postgres only)', () => {
  it('hands disjoint sets to overlapping claims instead of blocking', async () => {
    await submit(6);

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    // Claimant A takes rows and holds its transaction open.
    const aPromise = withTenant(db, tenant.id, async (sql) => {
      const claimed = await claimJobs(sql, { limit: 3, workerId: 'A', leaseMs: LEASE_MS });
      await held;
      return claimed;
    });

    // Give A time to lock its rows, then let B claim while A is still open. If
    // SKIP LOCKED were absent, this await would hang until A committed.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const b = await withTenant(db, tenant.id, (sql) =>
      claimJobs(sql, { limit: 3, workerId: 'B', leaseMs: LEASE_MS }),
    );

    release();
    const a = await aPromise;

    expect(a).toHaveLength(3);
    expect(b).toHaveLength(3);
    const overlap = a.map((j) => j.id).filter((id) => b.some((j) => j.id === id));
    expect(overlap, 'two claimants must never receive the same job').toEqual([]);
    expect(new Set([...a, ...b].map((j) => j.id)).size).toBe(6);
  });

  it('leaves nothing claimable once both claimants have taken their share', async () => {
    await submit(4);
    const [a, b] = await Promise.all([claim(2, 'A'), claim(2, 'B')]);
    expect(new Set([...a, ...b].map((j) => j.id)).size).toBe(4);
    expect(await claim(10, 'C')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// §F9 — the claim query enforces entitlements: max_concurrent_jobs + budget
// ---------------------------------------------------------------------------

let dbF9: Engine;

/** Tenant provisioned with tight limits so the claim caps are easy to hit. */
let tenantF9: { tenantId: string };
/** Workflow version under the provisioned tenant. */
let versionIdF9: string;

beforeAll(async () => {
  dbF9 = await freshDb();

  const prov = await provisionTenant(dbF9, {
    slug: 'claim-f9',
    name: 'Claim F9',
    ownerEmail: 'admin@claimf9.example',
    entitlements: {
      maxConcurrentJobs: 2,
      dailyTokenBudget: 100,
    },
  });
  tenantF9 = { tenantId: prov.tenantId };

  versionIdF9 = await withAdmin(dbF9, async (sql) => {
    const [workflow] = await sql.query<{ id: string }>(
      "INSERT INTO workflows (tenant_id, slug, name) VALUES ($1, 'claim-f9', 'Claim F9 fixture') RETURNING id",
      [tenantF9.tenantId],
    );
    const [version] = await sql.query<{ id: string }>(
      `INSERT INTO workflow_versions
         (tenant_id, workflow_id, version, prompt_template, output_schema, model)
       VALUES ($1, $2, 1, 'Do this: {{input}}', '{"type":"object"}'::jsonb, 'default')
       RETURNING id`,
      [tenantF9.tenantId, workflow!.id],
    );
    return version!.id;
  });
});

afterAll(async () => {
  await dbF9?.close();
});

beforeEach(async () => {
  await withAdmin(dbF9, (sql) =>
    sql.query('DELETE FROM work_orders WHERE tenant_id = $1', [tenantF9.tenantId]),
  );
  await withAdmin(dbF9, (sql) =>
    sql.query('DELETE FROM jobs WHERE tenant_id = $1', [tenantF9.tenantId]),
  );
});

async function submitF9(count: number): Promise<string[]> {
  const { jobIds } = await withTenant(dbF9, tenantF9.tenantId, (sql) =>
    enqueueOrder(
      sql,
      tenantF9.tenantId,
      Array.from({ length: count }, (_, i) => `item ${i}`),
      { workflowVersionId: versionIdF9 },
    ),
  );
  return jobIds;
}

const claimF9 = (limit: number, workerId: string) =>
  withTenant(dbF9, tenantF9.tenantId, (sql) =>
    claimJobs(sql, { limit, workerId, leaseMs: LEASE_MS }),
  );

describe('§F9 — claim query enforces entitlements', () => {
  it('caps claims at max_concurrent_jobs: 2 even when asking for 10', async () => {
    await submitF9(3);

    const claimed = await claimF9(10, 'w1');

    expect(claimed).toHaveLength(2);
  });

  it('returns 0 when two jobs are already running (max_concurrent_jobs reached)', async () => {
    await submitF9(3);
    await claimF9(10, 'w1');

    const second = await claimF9(10, 'w2');

    expect(second).toHaveLength(0);
  });

  it('lets the next claim take exactly 1 after releasing a job', async () => {
    await submitF9(3);
    await claimF9(10, 'w1');

    // Pick exactly one running job and release it back to pending under admin.
    const [toRelease] = await withAdmin(dbF9, (sql) =>
      sql.query<{ id: string }>(
        `SELECT id FROM jobs WHERE tenant_id = $1 AND state = 'running' LIMIT 1`,
        [tenantF9.tenantId],
      ),
    );
    if (toRelease) {
      await withAdmin(dbF9, (sql) =>
        sql.query(
          `UPDATE jobs SET state = 'pending', lease_expires_at = NULL, claimed_by = NULL WHERE id = $1`,
          [toRelease.id],
        ),
      );
    }

    const released = await claimF9(10, 'w2');

    expect(released).toHaveLength(1);
  });

  it('returns 0 when the daily token budget is spent', async () => {
    await submitF9(3);
    const claimed = await claimF9(10, 'w1');

    // Bill more than dailyTokenBudget (100) using recordUsage.
    for (const job of claimed) {
      await withTenant(dbF9, tenantF9.tenantId, (sql) =>
        recordUsage(sql, {
          jobId: job.id,
          orderId: job.order_id,
          model: 'default',
          usage: { promptTokens: 60, completionTokens: 0, totalTokens: 60 },
        }),
      );
    }

    // Put every job back to pending so the claim query can see them.
    await withAdmin(dbF9, (sql) =>
      sql.query(
        "UPDATE jobs SET state = 'pending', lease_expires_at = NULL, claimed_by = NULL WHERE tenant_id = $1",
        [tenantF9.tenantId],
      ),
    );

    const spent = await claimF9(10, 'w3');

    expect(spent).toHaveLength(0);
  });

  it('the original makeTenant tenant still claims its full limit — no entitlements row', async () => {
    // This proves the above cases are measuring the entitlement and not
    // something else: makeTenant creates a tenant with NO entitlements row,
    // so no cap applies.
    await submit(5);

    const claimed = await claim(10, 'w1');

    expect(claimed).toHaveLength(5);
  });
});
