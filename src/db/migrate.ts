import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Engine } from './engine.js';

/** Where the numbered `.sql` files live, resolved relative to this module. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../sql', import.meta.url));

const NAME_RE = /^(\d{3})_[a-z0-9_]+\.sql$/;

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

/**
 * Read the migration set from disk, ordered by version. Filenames must be
 * `NNN_snake_name.sql`; anything else in the directory is a mistake worth
 * failing on rather than skipping quietly. Versions must be dense from 001 so a
 * merge that drops or duplicates a number is caught here, not in production.
 */
export async function loadMigrations(dir = MIGRATIONS_DIR): Promise<Migration[]> {
  const entries = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const migrations: Migration[] = [];
  for (const file of entries) {
    const match = NAME_RE.exec(file);
    if (!match) throw new Error(`migration filename must be NNN_name.sql: ${file}`);
    const version = Number(match[1]);
    const expected = migrations.length + 1;
    if (version !== expected) {
      throw new Error(`migration versions must be dense from 001: expected ${expected}, got ${version} (${file})`);
    }
    migrations.push({ version, name: file, sql: await readFile(join(dir, file), 'utf8') });
  }
  return migrations;
}

/**
 * Apply every migration not yet recorded, each in its own transaction, in
 * order. Already-applied migrations are checked by version, and a filename that
 * changed under a recorded version is a hard error — migrations are append-only
 * (LOOP_PROMPT.md), and this is where that rule is enforced by code.
 */
export async function migrate(engine: Engine, dir = MIGRATIONS_DIR): Promise<number[]> {
  const migrations = await loadMigrations(dir);

  await engine.transaction(async (sql) => {
    await sql.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     integer PRIMARY KEY,
        name        text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      );
    `);
  });

  const applied = new Map<number, string>();
  await engine.transaction(async (sql) => {
    const rows = await sql.query<{ version: number; name: string }>(
      'SELECT version, name FROM schema_migrations',
    );
    for (const row of rows) applied.set(Number(row.version), row.name);
  });

  const ran: number[] = [];
  for (const migration of migrations) {
    const seen = applied.get(migration.version);
    if (seen !== undefined) {
      if (seen !== migration.name) {
        throw new Error(
          `migration ${migration.version} was applied as ${seen} but is now ${migration.name}; migrations are append-only`,
        );
      }
      continue;
    }
    await engine.transaction(async (sql) => {
      await sql.exec(migration.sql);
      await sql.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [
        migration.version,
        migration.name,
      ]);
    });
    ran.push(migration.version);
  }
  return ran;
}
