import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Engine } from '../src/db/engine.js';
import { claimJobs } from '../src/queue/claim.js';
import { enqueueOrder } from '../src/queue/enqueue.js';
import { withAdmin, withTenant } from '../src/seam/withTenant.js';
import { freshDb, makeTenant, type TestTenant } from './helpers/db.js';

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

const LEASE_MS = 30_000;

beforeAll(async () => {
  db = await freshDb();
  tenant = await makeTenant(db, 'claimant');
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
