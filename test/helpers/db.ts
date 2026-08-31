import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type { Engine, Session } from '../../src/db/engine.js';
import { openEngine } from '../../src/db/open.js';
import { migrate } from '../../src/db/migrate.js';
import { withAdmin } from '../../src/seam/withTenant.js';

/**
 * One migrated database per test file, on whichever engine is configured.
 *
 * `DATABASE_URL` unset → PGlite, so a clean clone runs the whole suite with no
 * database installed. Set → the same suite against a real Postgres server, and
 * that run is the authoritative one. No test may branch on the engine except to
 * skip a case the engine genuinely cannot express (see skipUnlessConcurrent).
 */
export async function freshDb(): Promise<Engine> {
  const url = process.env.DATABASE_URL;
  if (url) {
    // Each call gets its OWN database, mirroring PGlite's per-call instance.
    // The old approach (DROP SCHEMA public CASCADE on the shared database)
    // broke any file that opens two fixtures: the second freshDb() wiped the
    // first fixture's rows — a real-Postgres-only failure PGlite could never
    // show. CREATE DATABASE cannot run inside a transaction, so this uses a
    // one-off direct connection. Databases are named workmill_test_* and left
    // behind; CI's service container is ephemeral, and a local test server
    // can drop them wholesale.
    const dbName = `workmill_test_${randomUUID().slice(0, 8)}`;
    const admin = postgres(url, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await admin.end({ timeout: 5 });
    const perCallUrl = new URL(url);
    perCallUrl.pathname = `/${dbName}`;
    const engine = await openEngine(perCallUrl.toString());
    await migrate(engine);
    return engine;
  }
  const engine = await openEngine();
  await migrate(engine);
  return engine;
}

export interface TestTenant {
  id: string;
  slug: string;
}

/** Provision a tenant the way the operator will: as admin, outside RLS. */
export async function makeTenant(engine: Engine, slug: string): Promise<TestTenant> {
  const unique = `${slug}-${randomUUID().slice(0, 8)}`;
  return withAdmin(engine, async (sql) => {
    const [row] = await sql.query<{ id: string }>(
      'INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id',
      [unique, `Test tenant ${unique}`],
    );
    if (!row) throw new Error('tenant insert returned no row');
    return { id: row.id, slug: unique };
  });
}

/** Count rows ignoring RLS — used to prove a refused write really did nothing. */
export async function countAsAdmin(
  engine: Engine,
  table: string,
  where: string,
  params: readonly unknown[],
): Promise<number> {
  return withAdmin(engine, async (sql: Session) => {
    const [row] = await sql.query<{ n: string | number }>(
      `SELECT count(*) AS n FROM ${table} WHERE ${where}`,
      params,
    );
    return Number(row?.n ?? 0);
  });
}
