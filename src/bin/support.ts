import type { Engine } from '../db/engine.js';
import { openEngine } from '../db/open.js';
import { migrate } from '../db/migrate.js';
import { withAdmin } from '../seam/withTenant.js';
import { loadConfig, type WorkmillConfig } from '../config/config.js';

/**
 * The three lines every command-line entrypoint in `src/bin/` repeats: read the
 * config, open the engine it names, bring the schema up to date.
 *
 * These are operator tools, not a tenant-reachable path — they run as whoever
 * is at the terminal, and they use `withAdmin` for the one thing they must
 * (finding a tenant by its slug, which no tenant session can do because RLS
 * scopes `tenants` to the single row that IS the tenant). Everything else they
 * do goes through the same seam the server uses.
 */

export interface CliContext {
  readonly config: WorkmillConfig;
  readonly engine: Engine;
}

/**
 * Thrown when a command that writes durable state is pointed at PGlite.
 *
 * A MEASURED FACT, not a preference: `openPglite()` constructs `new PGlite()`
 * with no data directory, so its database lives in this process's memory and
 * dies with it. That is exactly right for `pnpm test` — the whole engines rule
 * is built on it — and exactly wrong for these commands, every one of which
 * exists to leave something behind for a DIFFERENT process to find. Seeding a
 * demo into memory and exiting prints tokens for tenants that no longer exist.
 * Refusing is the honest answer; a warning would be read as a success.
 */
export class EphemeralDatabaseError extends Error {
  constructor(what: string) {
    super(
      `${what} needs a durable database: set DATABASE_URL (or database.url in the config) `
        + 'to a real Postgres. The default engine, PGlite, lives in this process and dies with it.',
    );
    this.name = 'EphemeralDatabaseError';
  }
}

/** Refuse before doing any work, when the database would not outlive us. */
export function assertDurableDatabase(config: WorkmillConfig, what: string): void {
  if (config.database.url === null) throw new EphemeralDatabaseError(what);
}

/** Load, refuse an ephemeral database, open, migrate. The caller closes it. */
export async function openConfigured(what: string): Promise<CliContext> {
  const config = await loadConfig();
  assertDurableDatabase(config, what);
  const engine = await openEngine(config.database.url ?? '');
  await migrate(engine);
  return { config, engine };
}

/** A tenant id from a slug, or null. Admin-scoped: slugs are operator knowledge. */
export async function tenantIdBySlug(engine: Engine, slug: string): Promise<string | null> {
  return withAdmin(engine, async (sql) => {
    const [row] = await sql.query<{ id: string }>('SELECT id FROM tenants WHERE slug = $1', [slug]);
    return row?.id ?? null;
  });
}

/** Print to stderr and exit non-zero. Errors belong on stderr, always. */
export function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/** Print one line to stdout — the part a person pipes into something else. */
export function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * Run a command and turn any escaped error into a one-line failure. A stack
 * trace is the wrong answer to "your config file has a typo on line 7".
 */
export async function runCommand(
  what: string,
  body: (context: CliContext) => Promise<void>,
): Promise<void> {
  let context: CliContext | null = null;
  try {
    context = await openConfigured(what);
    await body(context);
  } catch (error) {
    fail(error instanceof Error ? `error: ${error.message}` : `error: ${String(error)}`);
  } finally {
    if (context !== null) await context.engine.close();
  }
}
