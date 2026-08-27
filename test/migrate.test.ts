import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Engine } from '../src/db/engine.js';
import { loadMigrations } from '../src/db/migrate.js';
import { migrate } from '../src/db/migrate.js';
import { withAdmin } from '../src/seam/withTenant.js';
import { freshDb } from './helpers/db.js';

/**
 * Assertions for `loadMigrations` and `migrate` in `src/db/migrate.ts`.
 *
 * Pattern: `test/claim.test.ts` — same import shape, `beforeAll`/`afterAll`,
 * and `freshDb()` usage. Malformed-cases use a throwaway temp directory so
 * the real `sql/` directory is never touched.
 */

let db: Engine;

beforeAll(async () => {
  db = await freshDb();
});

afterAll(async () => {
  await db?.close();
});

describe('loadMigrations', () => {
  it('returns the real migrations in ascending version order, first being 001_tenancy.sql', async () => {
    const migrations = await loadMigrations();

    expect(migrations.length).toBeGreaterThanOrEqual(2);
    const first = migrations[0]!;
    const second = migrations[1]!;
    expect(first.version).toBe(1);
    expect(first.name).toBe('001_tenancy.sql');
    expect(second.version).toBe(2);
    expect(second.name).toBe('002_queue.sql');
  });

  it('rejects when versions are not dense from 001', async () => {
    const dir = await mkdtemp(join(await tmpdir(), 'migrate-'));
    await writeFile(join(dir, '001_x.sql'), '');
    await writeFile(join(dir, '003_y.sql'), '');

    await expect(loadMigrations(dir)).rejects.toThrow('dense');
  });

  it('rejects filenames that do not match NNN_name.sql', async () => {
    const dir = await mkdtemp(join(await tmpdir(), 'migrate-'));
    await writeFile(join(dir, 'nope.sql'), '');

    await expect(loadMigrations(dir)).rejects.toThrow(
      'migration filename must be NNN_name.sql: nope.sql',
    );
  });
});

describe('migrate', () => {
  it('records exactly one row per migration file and re-running is a no-op', async () => {
    const engine = await freshDb();

    try {
      const rows = await withAdmin(engine, async (sql) =>
        sql.query<{ version: number; name: string }>(
          'SELECT version, name FROM schema_migrations ORDER BY version',
        ),
      );
      // Derived from disk, not hard-coded: a new migration must not make this
      // test fail, but a migration that fails to record itself still must.
      const onDisk = await loadMigrations();
      expect(rows.map((r) => [Number(r.version), r.name])).toEqual(
        onDisk.map((m) => [m.version, m.name]),
      );
      expect(rows.at(0)!.name).toBe('001_tenancy.sql');

      // Second call returns empty — already applied.
      const ran = await migrate(engine);
      expect(ran).toHaveLength(0);
    } finally {
      await engine.close();
    }
  });
});
