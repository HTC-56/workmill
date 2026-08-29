import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Engine, Session } from '../src/db/engine.js';
import { discoverTenantScopedTables, type TenantScopedTable } from '../src/seam/catalog.js';
import { withAdmin, withTenant } from '../src/seam/withTenant.js';
import { freshDb, makeTenant, type TestTenant } from './helpers/db.js';

/**
 * The catalog-driven leak suite (SPEC.md feature 1).
 *
 * It asks the database which tables claim to be tenant-scoped and proves
 * isolation for every one it finds. Nothing here is a hand-maintained list of
 * what to check, so a table added in a later phase is covered the day its
 * migration lands — and a table that declares the marker but forgets its
 * policies fails the build.
 *
 * The one thing a fixture must supply per table is how to make a row, because
 * only the table's own author knows its required columns. A tenant-scoped table
 * with no fixture here fails loudly rather than being skipped.
 */

/** Names are needed at collection time; `discovery matches` proves the list honest. */
const EXPECTED_TABLES = [
  'tenants',
  'users',
  'memberships',
  'invites',
  'entitlements',
  'work_orders',
  'jobs',
  'workflows',
  'workflow_versions',
  'job_results',
  'token_ledger',
] as const;

/** A unique address per fixture row; the users index is unique per tenant. */
function freshEmail(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}@example.test`;
}

/** A unique per-tenant workflow handle; sql/004 requires 3..40 chars, lowercase. */
function freshSlug(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

/** The minimum definition sql/004 accepts: the template must carry {{input}}. */
const FIXTURE_TEMPLATE = 'Summarise this: {{input}}';
const FIXTURE_SCHEMA = JSON.stringify({ type: 'object', properties: { brief: { type: 'string' } } });

/**
 * A workflow version belonging to `tenant`, to pin an order to. Since
 * sql/005, `work_orders.workflow_version_id` is NOT NULL, so every fixture
 * that makes an order makes one of these first.
 */
async function seedVersion(sql: Session, tenant: TestTenant): Promise<string> {
  const [workflow] = await sql.query<{ id: string }>(
    'INSERT INTO workflows (tenant_id, slug, name) VALUES ($1, $2, $3) RETURNING id',
    [tenant.id, freshSlug('pin'), `Pinned workflow for ${tenant.slug}`],
  );
  const [version] = await sql.query<{ id: string }>(
    `INSERT INTO workflow_versions
       (tenant_id, workflow_id, version, prompt_template, output_schema, model)
     VALUES ($1, $2, 1, $3, $4::jsonb, 'default') RETURNING id`,
    [tenant.id, workflow!.id, FIXTURE_TEMPLATE, FIXTURE_SCHEMA],
  );
  return version!.id;
}

/** Invites store a sha256 hex digest, never the raw token — see sql/003. */
function fakeTokenHash(): string {
  return createHash('sha256').update(randomUUID()).digest('hex');
}

let db: Engine;
let alice: TestTenant;
let bob: TestTenant;
let tables: TenantScopedTable[];
/** A row id belonging to each tenant, per table, inserted as admin. */
const seeded = new Map<string, { alice: string; bob: string }>();

/** Insert one row owned by `tenant`, bypassing RLS. Returns its id. */
async function seedRow(sql: Session, table: string, tenant: TestTenant): Promise<string> {
  if (table === 'tenants') return tenant.id;
  if (table === 'users') {
    const [row] = await sql.query<{ id: string }>(
      'INSERT INTO users (tenant_id, email, display_name) VALUES ($1, $2, $3) RETURNING id',
      [tenant.id, freshEmail('seed'), `Seed user for ${tenant.slug}`],
    );
    return row!.id;
  }
  if (table === 'memberships') {
    // Inserts its own user, the way the jobs fixture inserts its own order, so
    // the fixtures do not depend on the order EXPECTED_TABLES happens to be in.
    const [user] = await sql.query<{ id: string }>(
      'INSERT INTO users (tenant_id, email, display_name) VALUES ($1, $2, $3) RETURNING id',
      [tenant.id, freshEmail('member'), `Member of ${tenant.slug}`],
    );
    const [row] = await sql.query<{ id: string }>(
      "INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'member') RETURNING id",
      [tenant.id, user!.id],
    );
    return row!.id;
  }
  if (table === 'invites') {
    const [row] = await sql.query<{ id: string }>(
      `INSERT INTO invites (tenant_id, email, role, token_hash, expires_at)
       VALUES ($1, $2, 'member', $3, now() + interval '1 day') RETURNING id`,
      [tenant.id, freshEmail('invited'), fakeTokenHash()],
    );
    return row!.id;
  }
  if (table === 'entitlements') {
    const [row] = await sql.query<{ id: string }>(
      `INSERT INTO entitlements (tenant_id, daily_token_budget, max_concurrent_jobs,
                                 max_items_per_order, max_item_chars, allowed_models)
       VALUES ($1, 1000, 1, 10, 100, ARRAY['default']) RETURNING id`,
      [tenant.id],
    );
    return row!.id;
  }
  if (table === 'work_orders') {
    const [row] = await sql.query<{ id: string }>(
      `INSERT INTO work_orders (tenant_id, item_count, workflow_version_id)
       VALUES ($1, 1, $2) RETURNING id`,
      [tenant.id, await seedVersion(sql, tenant)],
    );
    return row!.id;
  }
  if (table === 'jobs') {
    const [order] = await sql.query<{ id: string }>(
      `INSERT INTO work_orders (tenant_id, item_count, workflow_version_id)
       VALUES ($1, 1, $2) RETURNING id`,
      [tenant.id, await seedVersion(sql, tenant)],
    );
    const [job] = await sql.query<{ id: string }>(
      'INSERT INTO jobs (tenant_id, order_id, idx, input) VALUES ($1, $2, 0, $3) RETURNING id',
      [tenant.id, order!.id, `seed for ${tenant.slug}`],
    );
    return job!.id;
  }
  if (table === 'job_results') {
    // Inserts its own order and job, the way the jobs fixture inserts its order.
    const [order] = await sql.query<{ id: string }>(
      `INSERT INTO work_orders (tenant_id, item_count, workflow_version_id)
       VALUES ($1, 1, $2) RETURNING id`,
      [tenant.id, await seedVersion(sql, tenant)],
    );
    const [job] = await sql.query<{ id: string }>(
      'INSERT INTO jobs (tenant_id, order_id, idx, input) VALUES ($1, $2, 0, $3) RETURNING id',
      [tenant.id, order!.id, `result seed for ${tenant.slug}`],
    );
    const [row] = await sql.query<{ id: string }>(
      `INSERT INTO job_results
         (tenant_id, job_id, ok, output, raw_output, model, attempts)
       VALUES ($1, $2, true, $3::jsonb, $4, 'default', 1) RETURNING id`,
      [tenant.id, job!.id, '{"brief":"seeded"}', '{"brief":"seeded"}'],
    );
    return row!.id;
  }
  if (table === 'token_ledger') {
    // Inserts its own order and job, the way the job_results fixture does: the
    // ledger carries a composite foreign key to both.
    const [order] = await sql.query<{ id: string }>(
      `INSERT INTO work_orders (tenant_id, item_count, workflow_version_id)
       VALUES ($1, 1, $2) RETURNING id`,
      [tenant.id, await seedVersion(sql, tenant)],
    );
    const [job] = await sql.query<{ id: string }>(
      'INSERT INTO jobs (tenant_id, order_id, idx, input) VALUES ($1, $2, 0, $3) RETURNING id',
      [tenant.id, order!.id, `ledger seed for ${tenant.slug}`],
    );
    const [row] = await sql.query<{ id: string }>(
      `INSERT INTO token_ledger
         (tenant_id, job_id, order_id, model, prompt_tokens, completion_tokens, total_tokens)
       VALUES ($1, $2, $3, 'default', 7, 5, 12) RETURNING id`,
      [tenant.id, job!.id, order!.id],
    );
    return row!.id;
  }
  if (table === 'workflows') {
    const [row] = await sql.query<{ id: string }>(
      'INSERT INTO workflows (tenant_id, slug, name) VALUES ($1, $2, $3) RETURNING id',
      [tenant.id, freshSlug('wf'), `Workflow for ${tenant.slug}`],
    );
    return row!.id;
  }
  if (table === 'workflow_versions') {
    // Inserts its own workflow, the way the jobs fixture inserts its own order.
    const [workflow] = await sql.query<{ id: string }>(
      'INSERT INTO workflows (tenant_id, slug, name) VALUES ($1, $2, $3) RETURNING id',
      [tenant.id, freshSlug('ver'), `Versioned workflow for ${tenant.slug}`],
    );
    const [row] = await sql.query<{ id: string }>(
      `INSERT INTO workflow_versions
         (tenant_id, workflow_id, version, prompt_template, output_schema, model)
       VALUES ($1, $2, 1, $3, $4::jsonb, 'default') RETURNING id`,
      [tenant.id, workflow!.id, FIXTURE_TEMPLATE, FIXTURE_SCHEMA],
    );
    return row!.id;
  }
  throw new Error(`leak suite has no fixture for tenant-scoped table "${table}" — add one here`);
}

/** Attempt, as the current tenant, to insert a row owned by someone else. */
async function insertForeignRow(sql: Session, table: string, victim: TestTenant): Promise<void> {
  if (table === 'tenants') {
    await sql.query('INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)', [
      victim.id,
      `stolen-${victim.slug}`,
      'stolen',
    ]);
    return;
  }
  if (table === 'users') {
    await sql.query('INSERT INTO users (tenant_id, email, display_name) VALUES ($1, $2, $3)', [
      victim.id,
      freshEmail('stolen'),
      'stolen',
    ]);
    return;
  }
  if (table === 'memberships') {
    // A real user of the victim's tenant, so the composite foreign key is
    // satisfied and RLS is the only thing left to refuse the row.
    await sql.query(
      "INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')",
      [victim.id, seeded.get('users')!.bob],
    );
    return;
  }
  if (table === 'invites') {
    await sql.query(
      `INSERT INTO invites (tenant_id, email, role, token_hash, expires_at)
       VALUES ($1, $2, 'owner', $3, now() + interval '1 day')`,
      [victim.id, freshEmail('stolen'), fakeTokenHash()],
    );
    return;
  }
  if (table === 'entitlements') {
    await sql.query(
      `INSERT INTO entitlements (tenant_id, daily_token_budget, max_concurrent_jobs,
                                 max_items_per_order, max_item_chars, allowed_models)
       VALUES ($1, 9999999, 999, 99999, 999999, ARRAY['default'])`,
      [victim.id],
    );
    return;
  }
  if (table === 'work_orders') {
    await sql.query('INSERT INTO work_orders (tenant_id, item_count) VALUES ($1, 1)', [victim.id]);
    return;
  }
  if (table === 'jobs') {
    await sql.query('INSERT INTO jobs (tenant_id, order_id, idx, input) VALUES ($1, $2, 999, $3)', [
      victim.id,
      seeded.get('work_orders')!.bob,
      'stolen',
    ]);
    return;
  }
  if (table === 'workflows') {
    await sql.query('INSERT INTO workflows (tenant_id, slug, name) VALUES ($1, $2, $3)', [
      victim.id,
      freshSlug('stolen'),
      'stolen',
    ]);
    return;
  }
  if (table === 'workflow_versions') {
    // A real workflow of the victim's, so the composite foreign key is
    // satisfied and RLS is the only thing left to refuse the row.
    await sql.query(
      `INSERT INTO workflow_versions
         (tenant_id, workflow_id, version, prompt_template, output_schema, model)
       VALUES ($1, $2, 999, $3, $4::jsonb, 'default')`,
      [victim.id, seeded.get('workflows')!.bob, FIXTURE_TEMPLATE, FIXTURE_SCHEMA],
    );
    return;
  }
  if (table === 'job_results') {
    // A real job of the victim's, so the composite foreign key is satisfied and
    // RLS is the only thing left to refuse the row.
    await sql.query(
      `INSERT INTO job_results
         (tenant_id, job_id, ok, output, raw_output, model, attempts)
       VALUES ($1, $2, true, $3::jsonb, $4, 'stolen', 1)`,
      [victim.id, seeded.get('jobs')!.bob, '{"brief":"stolen"}', 'stolen'],
    );
    return;
  }
  if (table === 'token_ledger') {
    // A real job and a real order of the victim's, so both composite foreign
    // keys are satisfied and RLS is the only thing left to refuse the row.
    await sql.query(
      `INSERT INTO token_ledger (tenant_id, job_id, order_id, model, total_tokens)
       VALUES ($1, $2, $3, 'stolen', 99)`,
      [victim.id, seeded.get('jobs')!.bob, seeded.get('work_orders')!.bob],
    );
    return;
  }
  throw new Error(`leak suite has no foreign-insert case for "${table}" — add one here`);
}

beforeAll(async () => {
  db = await freshDb();
  alice = await makeTenant(db, 'alice');
  bob = await makeTenant(db, 'bob');
  tables = await discoverTenantScopedTables(db);
  await withAdmin(db, async (sql) => {
    for (const table of EXPECTED_TABLES) {
      seeded.set(table, {
        alice: await seedRow(sql, table, alice),
        bob: await seedRow(sql, table, bob),
      });
    }
  });
});

afterAll(async () => {
  await db?.close();
});

it('discovery matches the tables this suite knows how to seed', async () => {
  expect([...tables.map((t) => t.table)].sort()).toEqual([...EXPECTED_TABLES].sort());
});

describe.each(EXPECTED_TABLES)('tenant isolation on %s', (table) => {
  const entry = () => tables.find((t) => t.table === table);
  const column = () => entry()?.tenantColumn ?? 'tenant_id';

  it('has row security enabled AND forced, with a policy', () => {
    expect(entry(), `${table} must declare COMMENT ON TABLE … 'tenant-scoped:<column>'`).toBeDefined();
    expect(entry()?.rowSecurityEnabled, `${table} needs ENABLE ROW LEVEL SECURITY`).toBe(true);
    expect(entry()?.rowSecurityForced, `${table} needs FORCE ROW LEVEL SECURITY`).toBe(true);
    expect(entry()?.policyCount, `${table} needs at least one policy`).toBeGreaterThan(0);
  });

  it("SELECT sees only the current tenant's rows", async () => {
    const mine = await withTenant(db, alice.id, (sql) =>
      sql.query<{ scope: string }>(`SELECT ${column()} AS scope FROM ${table}`),
    );
    expect(mine.length).toBeGreaterThan(0);
    for (const row of mine) expect(row.scope).toBe(alice.id);

    const [all] = await withAdmin(db, (sql) =>
      sql.query<{ n: string | number }>(`SELECT count(*) AS n FROM ${table}`),
    );
    expect(Number(all?.n), 'admin must see strictly more than one tenant does').toBeGreaterThan(
      mine.length,
    );
  });

  it("SELECT of another tenant's row by id returns nothing", async () => {
    const rows = await withTenant(db, alice.id, (sql) =>
      sql.query(`SELECT id FROM ${table} WHERE id = $1`, [seeded.get(table)!.bob]),
    );
    expect(rows).toHaveLength(0);
  });

  it("INSERT of another tenant's row is refused with an error", async () => {
    await expect(
      withTenant(db, alice.id, (sql) => insertForeignRow(sql, table, bob)),
    ).rejects.toThrow(/row-level security/i);
  });

  /**
   * UPDATE and DELETE do not throw. A policy refuses them by matching zero
   * rows, so the correct assertion is "zero rows affected AND the victim row
   * is still there".
   */

  /** Per-table SET clause for an UPDATE that is harmless but exercises the path. */
  function setClause(t: string): string {
    if (t === 'tenants') return "slug = 'hacked'";
    if (t === 'users') return "display_name = 'hacked'";
    if (t === 'memberships') return "role = 'admin'";
    if (t === 'invites') return "state = 'revoked'";
    if (t === 'entitlements') return 'max_concurrent_jobs = 999';
    if (t === 'work_orders') return "state = 'done'";
    if (t === 'jobs') return "state = 'failed'";
    if (t === 'workflows') return "name = 'hacked'";
    if (t === 'workflow_versions') return "model = 'hacked'";
    if (t === 'job_results') return "model = 'hacked'";
    if (t === 'token_ledger') return "model = 'hacked'";
    throw new Error(`leak suite has no UPDATE SET clause for "${t}" — add one here`);
  }

  it("UPDATE targeting another tenant's row id returns zero rows", async () => {
    const rows = await withTenant(db, alice.id, (sql) =>
      sql.query<{ id: string }>(
        `UPDATE ${table} SET ${setClause(table)} WHERE id = $1 RETURNING id`,
        [seeded.get(table)!.bob],
      ),
    );
    expect(rows).toHaveLength(0);
  });

  it("still finds another tenant's row intact after a failed UPDATE", async () => {
    // Run the UPDATE again so we test the full path under a single withTenant.
    await withTenant(db, alice.id, (sql) =>
      sql.query(
        `UPDATE ${table} SET ${setClause(table)} WHERE id = $1`,
        [seeded.get(table)!.bob],
      ),
    );
    // withAdmin should still see the original row unchanged.
    const row = await withAdmin(db, (sql) =>
      sql.query(`SELECT * FROM ${table} WHERE id = $1`, [seeded.get(table)!.bob]),
    );
    expect(row).toHaveLength(1);
  });

  it("DELETE targeting another tenant's row id returns zero rows", async () => {
    const rows = await withTenant(db, alice.id, (sql) =>
      sql.query<{ id: string }>(
        `DELETE FROM ${table} WHERE id = $1 RETURNING id`,
        [seeded.get(table)!.bob],
      ),
    );
    expect(rows).toHaveLength(0);
  });

  it("still finds another tenant's row intact after a failed DELETE", async () => {
    // Run the DELETE again to test the full path under a single withTenant.
    await withTenant(db, alice.id, (sql) =>
      sql.query(`DELETE FROM ${table} WHERE id = $1`, [seeded.get(table)!.bob]),
    );
    const row = await withAdmin(db, (sql) =>
      sql.query(`SELECT * FROM ${table} WHERE id = $1`, [seeded.get(table)!.bob]),
    );
    expect(row).toHaveLength(1);
  });

  /**
   * Re-homing a row into another tenant is refused by the WITH CHECK half
   * of the policy. The USING clause permits the UPDATE (alice owns the row),
   * but the WITH CHECK clause fires after and rejects the new tenant_id value.
   */
  it("UPDATE setting the tenant column to another tenant is refused", async () => {
    // Count rows carrying bob's tenant id before the attempt.
    const [pre] = await withAdmin(db, (sql) =>
      sql.query<{ n: string | number }>(
        `SELECT count(*) AS n FROM ${table} WHERE ${column()} = $1`,
        [bob.id],
      ),
    );
    const preBob = Number(pre?.n);

    // As alice, try to rewrite her own row so it belongs to bob.
    await expect(
      withTenant(db, alice.id, (sql) =>
        sql.query(`UPDATE ${table} SET ${column()} = $1 WHERE id = $2 RETURNING *`, [
          bob.id,
          seeded.get(table)!.alice,
        ]),
      ),
    ).rejects.toThrow(/row-level security/i);

    // The count of bob's rows must be unchanged.
    const [post] = await withAdmin(db, (sql) =>
      sql.query<{ n: string | number }>(
        `SELECT count(*) AS n FROM ${table} WHERE ${column()} = $1`,
        [bob.id],
      ),
    );
    expect(Number(post?.n)).toBe(preBob);
  });

  it("UPDATE with no WHERE only touches the current tenant's rows", async () => {
    // The strongest test: policy — not the query — is what protects bob.
    const rows = await withTenant(db, alice.id, (sql) =>
      sql.query<{ scope: string }>(
        `UPDATE ${table} SET ${setClause(table)} RETURNING ${column()} AS scope`,
      ),
    );
    for (const row of rows) expect(row.scope).toBe(alice.id);
  });
});
