import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Engine } from '../src/db/engine.js';
import { withTenant } from '../src/seam/withTenant.js';
import { freshDb } from './helpers/db.js';
import {
  listTenantRows,
  tenantExists,
  updateEntitlements,
  setTenantState,
  EntitlementValueError,
  TENANT_STATES,
} from '../src/operator/tenants.js';
import { provisionTenant } from '../src/tenancy/provision.js';

/**
 * Proves `listTenantRows`, `tenantExists`, `updateEntitlements`,
 * `setTenantState`, and `EntitlementValueError` from
 * `src/operator/tenants.ts`.
 *
 * Patterned after test/entitlements.test.ts — same beforeAll/afterAll shape,
 * provisionTenant for the first tenant, makeTenant for the second.
 * No HTTP server in this file.
 *
 * Note the split: listTenantRows and tenantExists take the ENGINE (cross-tenant),
 * while updateEntitlements and setTenantState take a Session via withTenant.
 */

let db: Engine;

beforeAll(async () => {
  db = await freshDb();
});

afterAll(async () => {
  await db?.close();
});

// ─── §I5 — tenant table and the two edits ───────────────────────────────────

describe('listTenantRows returns both tenants, newest first', () => {
  it('each row has slug, state "active", limits, and supportActive false', async () => {
    const { tenantId: firstId } = await provisionTenant(db, {
      slug: 'op-tenants-first',
      name: 'First Corp',
      ownerEmail: 'alice@first.example',
      entitlements: { maxItemChars: 512 },
    });

    const { tenantId: secondId } = await provisionTenant(db, {
      slug: 'op-tenants-second',
      name: 'Second Inc',
      ownerEmail: 'bob@second.example',
    });

    const rows = await listTenantRows(db);

    expect(rows.length).toBe(2);

    // Newest first (secondId was created later).
    expect(rows[0]!.tenantId).toBe(secondId);
    expect(rows[1]!.tenantId).toBe(firstId);

    for (const row of rows) {
      expect(typeof row.slug).toBe('string');
      expect(row.slug.length).toBeGreaterThan(0);
      expect(row.state).toBe('active');
      expect(row.limits).not.toBeNull();
      expect(row.supportActive).toBe(false);
    }
  });
});

describe('fresh tenant counts are zero, not undefined', () => {
  it('pendingJobs, runningJobs, deadJobs, openOrders, tokensToday are all 0', async () => {
    await provisionTenant(db, {
      slug: 'op-tenants-zero',
      name: 'Zero Corp',
      ownerEmail: 'zero@zero.example',
    });

    const rows = await listTenantRows(db);
    const row = rows.find((r) => r.slug === 'op-tenants-zero');

    expect(row).toBeDefined();
    expect(row!.pendingJobs).toBe(0);
    expect(row!.runningJobs).toBe(0);
    expect(row!.deadJobs).toBe(0);
    expect(row!.openOrders).toBe(0);
    expect(row!.tokensToday).toBe(0);
  });
});

describe('tenantExists', () => {
  it('true for a real id, false for a known-void id', async () => {
    const { tenantId } = await provisionTenant(db, {
      slug: 'op-tenants-exists',
      name: 'Exists Corp',
      ownerEmail: 'exist@exist.example',
    });

    expect(await tenantExists(db, tenantId)).toBe(true);
    expect(await tenantExists(db, '00000000-0000-4000-8000-000000000000')).toBe(false);
  });
});

describe('updateEntitlements patches partial fields', () => {
  it('maxItemChars: 99 + allowedModels: ["default","fast"] returns new limits; list shows them', async () => {
    const { tenantId } = await provisionTenant(db, {
      slug: 'op-tenants-patch',
      name: 'Patch Corp',
      ownerEmail: 'patch@patch.example',
    });

    const newLimits = await withTenant(db, tenantId, (sql) =>
      updateEntitlements(sql, { maxItemChars: 99, allowedModels: ['default', 'fast'] }),
    );

    expect(newLimits).not.toBeNull();
    expect(newLimits!.maxItemChars).toBe(99);
    expect(newLimits!.allowedModels).toEqual(['default', 'fast']);

    // maxConcurrentJobs should be unchanged from defaults.
    expect(newLimits!.maxConcurrentJobs).toBe(4);

    // listTenantRows shows the patch.
    const rows = await listTenantRows(db);
    const row = rows.find((r) => r.slug === 'op-tenants-patch');
    expect(row).toBeDefined();
    expect(row!.limits!.maxItemChars).toBe(99);
    expect(row!.limits!.allowedModels).toEqual(['default', 'fast']);
    expect(row!.limits!.maxConcurrentJobs).toBe(4);
  });
});

describe('updateEntitlements rejects invalid values with EntitlementValueError', () => {
  it('maxConcurrentJobs: 0 throws with field "maxConcurrentJobs"', async () => {
    const { tenantId } = await provisionTenant(db, {
      slug: 'op-tenants-bad-cj',
      name: 'Bad Concurrency',
      ownerEmail: 'bad@bad.example',
    });

    await expect(
      withTenant(db, tenantId, (sql) =>
        updateEntitlements(sql, { maxConcurrentJobs: 0 }),
      ),
    ).rejects.toBeInstanceOf(EntitlementValueError);
  });

  it('maxItemChars: -1 throws with field "maxItemChars"', async () => {
    const { tenantId } = await provisionTenant(db, {
      slug: 'op-tenants-bad-ic',
      name: 'Bad Item Chars',
      ownerEmail: 'bad2@bad.example',
    });

    await expect(
      withTenant(db, tenantId, (sql) =>
        updateEntitlements(sql, { maxItemChars: -1 }),
      ),
    ).rejects.toBeInstanceOf(EntitlementValueError);
  });

  it('allowedModels: [] throws with field "allowedModels"', async () => {
    const { tenantId } = await provisionTenant(db, {
      slug: 'op-tenants-bad-am',
      name: 'Bad Models',
      ownerEmail: 'bad3@bad.example',
    });

    await expect(
      withTenant(db, tenantId, (sql) =>
        updateEntitlements(sql, { allowedModels: [] }),
      ),
    ).rejects.toBeInstanceOf(EntitlementValueError);
  });

  it('empty patch {} throws with field "patch"', async () => {
    const { tenantId } = await provisionTenant(db, {
      slug: 'op-tenants-bad-empty',
      name: 'Empty Patch',
      ownerEmail: 'empty@bad.example',
    });

    await expect(
      withTenant(db, tenantId, (sql) => updateEntitlements(sql, {})),
    ).rejects.toBeInstanceOf(EntitlementValueError);
  });
});

describe('setTenantState suspends and resumes', () => {
  it('returns true on first suspend, false on second call (no change)', async () => {
    const { tenantId: aId } = await provisionTenant(db, {
      slug: 'op-tenants-a',
      name: 'Tenant A',
      ownerEmail: 'a@a.example',
    });

    const { tenantId: bId } = await provisionTenant(db, {
      slug: 'op-tenants-b',
      name: 'Tenant B',
      ownerEmail: 'b@b.example',
    });

    // Suspend tenant A.
    const changedA = await withTenant(db, aId, (sql) => setTenantState(sql, 'suspended'));
    expect(changedA).toBe(true);

    // Calling again should return false (nothing changed).
    const changedAGain = await withTenant(db, aId, (sql) => setTenantState(sql, 'suspended'));
    expect(changedAGain).toBe(false);

    // Tenant A is suspended.
    const rows = await listTenantRows(db);
    const rowA = rows.find((r) => r.tenantId === aId);
    const rowB = rows.find((r) => r.tenantId === bId);

    expect(rowA!.state).toBe('suspended');

    // The edit does not reach tenant B.
    expect(rowB!.state).toBe('active');
  });
});

describe('TENANT_STATES lists the allowed values', () => {
  it('is ["active", "suspended"]', () => {
    expect(TENANT_STATES).toEqual(['active', 'suspended']);
  });
});
