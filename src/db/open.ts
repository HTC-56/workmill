import type { Engine } from './engine.js';
import { openPglite } from './pglite.js';
import { openPostgres } from './postgres.js';

/**
 * Open the configured engine. `DATABASE_URL` present means a real Postgres
 * server; absent means PGlite. The same suite runs unchanged against either —
 * that switch IS the engines rule from SPEC.md, expressed in one function.
 */
export async function openEngine(url = process.env.DATABASE_URL): Promise<Engine> {
  return url ? openPostgres(url) : openPglite();
}
