import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Engine } from '../src/db/engine.js';
import { withAdmin, withTenant } from '../src/seam/withTenant.js';
import { freshDb, countAsAdmin } from './helpers/db.js';
import { provisionTenant } from '../src/tenancy/provision.js';
import {
  seedDemo,
  DemoExistsError,
  DEMO_TENANTS,
  type DemoManifest,
  type DemoTenantSpec,
} from '../src/demo/seed.js';
import {
  clearDemo,
  resetDemo,
  DemoResetRefusedError,
} from '../src/demo/reset.js';
import { readLimits } from '../src/metering/limits.js';

/**
 * Proves `seedDemo`, `DemoExistsError`, `DEMO_TENANTS` from
 * `src/demo/seed.ts`, and `clearDemo`, `resetDemo`, `DemoResetRefusedError`
 * from `src/demo/reset.ts`: the seed shape, the tight budgets, double-seed
 * refusal, cascade delete, non-demo refusal, and reset token rotation.
 *
 * Patterned after test/tenancy.test.ts: same beforeAll shape (freshDb) and
 * afterAll shape (db.close), with `withTenant` reads throughout.
 */

let db: Engine;
let manifest: DemoManifest;

beforeAll(async () => {
  db = await freshDb();
  manifest = await seedDemo(db);
});

afterAll(async () => {
  await db?.close();
});

// ── 1. The seed ──────────────────────────────────────────────────────────────

describe('seedDemo returns two tenants with workflows and tokens', () => {
  it('two tenants in DEMO_TENANTS order, each with three workflows and a wm_ token', async () => {
    const tenants = manifest.tenants;
    expect(tenants).toHaveLength(2);
    expect(tenants[0]!.slug).toBe(DEMO_TENANTS[0]!.slug);
    expect(tenants[1]!.slug).toBe(DEMO_TENANTS[1]!.slug);

    for (const tenant of tenants) {
      expect(tenant.tenantId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(tenant.workflows).toHaveLength(3);
      expect(tenant.workflows.map((w) => w.slug)).toEqual(['extract', 'classify', 'summarize']);
      expect(tenant.token.startsWith('wm_')).toBe(true);
    }
  });
});

// ── 2. The tight budgets landed ──────────────────────────────────────────────

describe('demo-globex and demo-acme have the exact tight budgets', () => {
  it('globex: dailyTokenBudget=600, maxConcurrentJobs=1; acme: 20000 and 2', async () => {
    const acme = manifest.tenants.find((t) => t.slug === 'demo-acme');
    const globex = manifest.tenants.find((t) => t.slug === 'demo-globex');

    expect(acme).toBeDefined();
    expect(globex).toBeDefined();

    const acmeLimits = await withTenant(db, acme!.tenantId, readLimits);
    const globexLimits = await withTenant(db, globex!.tenantId, readLimits);

    expect(acmeLimits).not.toBeNull();
    expect(globexLimits).not.toBeNull();

    expect(acmeLimits!.dailyTokenBudget).toBe(20_000);
    expect(acmeLimits!.maxConcurrentJobs).toBe(2);

    expect(globexLimits!.dailyTokenBudget).toBe(600);
    expect(globexLimits!.maxConcurrentJobs).toBe(1);
  });
});

// ── 3. Seeding twice refuses ─────────────────────────────────────────────────

describe('a second seedDemo throws DemoExistsError and leaves exactly two tenants', () => {
  it('DemoExistsError carries the slug; countAsAdmin still finds two tenants', async () => {
    const err = await seedDemo(db).catch((e) => e);

    expect(err).toBeInstanceOf(DemoExistsError);
    expect((err as DemoExistsError).slug).toBeDefined();

    // Count tenants via admin: should still be exactly 2 (no rollback of the
    // first tenant on second's failure).
    const count = await countAsAdmin(db, 'tenants', '1=1', []);
    expect(count).toBe(2);
  });
});

// ── 4. Clearing cascades ─────────────────────────────────────────────────────

describe('clearDemo removes tenants and cascades to workflows', () => {
  it('tenantsRemoved: 2; zero tenants and zero workflows afterwards', async () => {
    const cleared = await clearDemo(db);

    expect(cleared.tenantsRemoved).toBe(2);

    const tenantCount = await countAsAdmin(db, 'tenants', '1=1', []);
    expect(tenantCount).toBe(0);

    const workflowCount = await countAsAdmin(db, 'workflows', '1=1', []);
    expect(workflowCount).toBe(0);
  });
});

// ── 5. Non-demo slug refused before anything happens ─────────────────────────

describe('clearDemo with a non-demo specs array throws DemoResetRefusedError', () => {
  it('a regular tenant slug is refused; the tenant is still there', async () => {
    // Provision a non-demo tenant — track the slug we passed in.
    const slug = 'acme-corp';
    await provisionTenant(db, {
      slug,
      name: 'Acme Corp',
      ownerEmail: 'alice@acme.example',
    });

    // Build a specs array with that slug — clearDemo will reject it.
    const specs: DemoTenantSpec[] = [{
      slug,
      name: 'x',
      ownerEmail: 'x',
      entitlements: {},
      note: 'x',
    }];

    const err = await clearDemo(db, specs).catch((e) => e);

    expect(err).toBeInstanceOf(DemoResetRefusedError);
    expect((err as DemoResetRefusedError).slug).toBe(slug);

    // The tenant must still exist — nothing was deleted.
    const count = await countAsAdmin(
      db,
      'tenants',
      'slug = $1',
      [slug],
    );
    expect(count).toBe(1);
  });
});

// ── 6. Reset is clear-then-seed with new tokens ──────────────────────────────

describe('resetDemo clears then seeds with new tokens', () => {
  it('cleared.tenantsRemoved is 2 and all tokens differ from the first seed', async () => {
    // The DB is currently empty (cleared in test 4, then the non-demo test
    // provisioned one tenant that we haven't cleaned up). Reset will refuse
    // because the non-demo tenant is still there AND the specs don't match.
    // We need a clean DB for this assertion, so we re-seed first, capture
    // tokens, then reset.

    // First, clear the stray non-demo tenant.
    await withAdmin(db, async (sql) => {
      await sql.exec("DELETE FROM tenants WHERE slug = 'acme-corp'");
    });

    // Seed fresh.
    const first = await seedDemo(db);
    const firstTokens = first.tenants.map((t) => t.token);

    // Reset.
    const result = await resetDemo(db);

    expect(result.cleared.tenantsRemoved).toBe(2);
    expect(result.manifest.tenants).toHaveLength(2);

    const secondTokens = result.manifest.tenants.map((t) => t.token);

    // Every token must be DIFFERENT — reset rotates them.
    for (let i = 0; i < firstTokens.length; i++) {
      expect(secondTokens[i]).not.toBe(firstTokens[i]);
    }
  });
});
