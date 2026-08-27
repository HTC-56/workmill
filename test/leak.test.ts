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
const EXPECTED_TABLES = ['tenants', 'work_orders', 'jobs'] as const;

let db: Engine;
let alice: TestTenant;
let bob: TestTenant;
let tables: TenantScopedTable[];
/** A row id belonging to each tenant, per table, inserted as admin. */
const seeded = new Map<string, { alice: string; bob: string }>();

/** Insert one row owned by `tenant`, bypassing RLS. Returns its id. */
async function seedRow(sql: Session, table: string, tenant: TestTenant): Promise<string> {
  if (table === 'tenants') return tenant.id;
  if (table === 'work_orders') {
    const [row] = await sql.query<{ id: string }>(
      'INSERT INTO work_orders (tenant_id, item_count) VALUES ($1, 1) RETURNING id',
      [tenant.id],
    );
    return row!.id;
  }
  if (table === 'jobs') {
    const [order] = await sql.query<{ id: string }>(
      'INSERT INTO work_orders (tenant_id, item_count) VALUES ($1, 1) RETURNING id',
      [tenant.id],
    );
    const [job] = await sql.query<{ id: string }>(
      'INSERT INTO jobs (tenant_id, order_id, idx, input) VALUES ($1, $2, 0, $3) RETURNING id',
      [tenant.id, order!.id, `seed for ${tenant.slug}`],
    );
    return job!.id;
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
});
