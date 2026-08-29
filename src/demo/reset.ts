import type { Engine } from '../db/engine.js';
import { withAdmin } from '../seam/withTenant.js';
import {
  DEMO_SLUG_PREFIX,
  DEMO_TENANTS,
  seedDemo,
  type DemoManifest,
  type DemoTenantSpec,
  type SeedDemoOptions,
} from './seed.js';

/**
 * Restore the demo to seed state (SPEC.md feature 9), which the reference
 * deployment runs from a timer.
 *
 * This is the one file in the repo that deletes tenant data, so it is the one
 * file that needs a rule about what it may reach. The rule is a prefix: a slug
 * that does not begin with `demo-` is refused BEFORE any statement runs, and
 * refused by name so the message says which one. A reset script pointed at a
 * real tenant by a stray argument or a copied config is the failure worth
 * spending a guard on, and the guard is cheaper than the recovery.
 *
 * The delete itself is one statement against `tenants`. Every tenant-scoped
 * table in the repo declares `REFERENCES tenants(id) ON DELETE CASCADE`, so the
 * database removes the tenant's jobs, results, ledger rows, tokens, grants and
 * audit entries in the same transaction. There is no list of tables here to
 * fall out of date as tables are added — the foreign keys already know.
 */

/** Thrown before anything is deleted, when a slug is not a demo slug. */
export class DemoResetRefusedError extends Error {
  constructor(readonly slug: string) {
    super(
      `refusing to reset "${slug}": only slugs beginning with "${DEMO_SLUG_PREFIX}" may be cleared`,
    );
    this.name = 'DemoResetRefusedError';
  }
}

/** True for a slug the reset is allowed to touch. */
export function isDemoSlug(slug: string): boolean {
  return slug.startsWith(DEMO_SLUG_PREFIX) && slug.length > DEMO_SLUG_PREFIX.length;
}

export interface ClearedDemo {
  /** How many tenant rows were removed; their children went with them. */
  readonly tenantsRemoved: number;
  readonly slugs: readonly string[];
}

/**
 * Remove the demo tenants and everything that hangs off them. Removing a demo
 * that is not there is not an error — a reset from a clean database is exactly
 * what the first run of the timer does.
 */
export async function clearDemo(
  engine: Engine,
  specs: readonly DemoTenantSpec[] = DEMO_TENANTS,
): Promise<ClearedDemo> {
  const slugs = specs.map((spec) => spec.slug);
  for (const slug of slugs) {
    if (!isDemoSlug(slug)) throw new DemoResetRefusedError(slug);
  }

  const removed = await withAdmin(engine, async (sql) => {
    const rows = await sql.query<{ slug: string }>(
      'DELETE FROM tenants WHERE slug = ANY($1) RETURNING slug',
      [slugs],
    );
    return rows.map((row) => row.slug);
  });

  return { tenantsRemoved: removed.length, slugs: removed.sort() };
}

export interface ResetDemoResult {
  readonly cleared: ClearedDemo;
  readonly manifest: DemoManifest;
}

/**
 * Clear, then seed. The tokens change every time, which is the point: a reset
 * ends every session that was open against the old demo, so whatever the last
 * visitor pasted into the dashboard stops working the moment the timer fires.
 */
export async function resetDemo(
  engine: Engine,
  options: SeedDemoOptions = {},
): Promise<ResetDemoResult> {
  const specs = options.specs ?? DEMO_TENANTS;
  const cleared = await clearDemo(engine, specs);
  const manifest = await seedDemo(engine, options);
  return { cleared, manifest };
}
