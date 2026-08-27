import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Engine } from '../src/db/engine.js';
import { withTenant } from '../src/seam/withTenant.js';
import { freshDb, makeTenant } from './helpers/db.js';
import {
  getEntitlements,
  MissingEntitlementsError,
  isModelAllowed,
} from '../src/tenancy/entitlements.js';
import {
  provisionTenant,
  DEFAULT_ENTITLEMENTS,
} from '../src/tenancy/provision.js';

/**
 * Proves `getEntitlements` and `isModelAllowed` in
 * `src/tenancy/entitlements.ts`: the defaults, overrides, per-tenant
 * isolation, the bare-tenant rejection path, and the model-check helper.
 *
 * Patterned after test/tenancy.test.ts: same beforeAll shape (freshDb) and
 * afterAll shape (db.close).
 */

let db: Engine;

beforeAll(async () => {
  db = await freshDb();
});

afterAll(async () => {
  await db?.close();
});

describe('getEntitlements returns DEFAULT_ENTITLEMENTS after provisionTenant', () => {
  it('dailyTokenBudget is a number matching the default', async () => {
    const { tenantId } = await provisionTenant(db, {
      slug: 'ent-acme',
      name: 'Acme Inc',
      ownerEmail: 'alice@acme.example',
    });

    const result = await withTenant(db, tenantId, getEntitlements);

    expect(typeof result.dailyTokenBudget).toBe('number');
    expect(result.dailyTokenBudget).toBe(DEFAULT_ENTITLEMENTS.dailyTokenBudget);
  });
});

describe('allowedModels contains "default"', () => {
  it('is an array with one entry: "default"', async () => {
    const { tenantId } = await provisionTenant(db, {
      slug: 'ent-globex',
      name: 'Globex Corp',
      ownerEmail: 'bob@globex.example',
    });

    const result = await withTenant(db, tenantId, getEntitlements);

    expect(Array.isArray(result.allowedModels)).toBe(true);
    expect(result.allowedModels).toContain('default');
  });
});

describe('entitlements override returns the overridden number', () => {
  it('maxItemsPerOrder: 7 shows as 7; others stay at defaults', async () => {
    const { tenantId } = await provisionTenant(db, {
      slug: 'ent-wayne',
      name: 'Wayne Enterprises',
      ownerEmail: 'bruce@wayne.example',
      entitlements: { maxItemsPerOrder: 7 },
    });

    const result = await withTenant(db, tenantId, getEntitlements);

    expect(result.maxItemsPerOrder).toBe(7);
    expect(result.dailyTokenBudget).toBe(DEFAULT_ENTITLEMENTS.dailyTokenBudget);
    expect(result.maxConcurrentJobs).toBe(DEFAULT_ENTITLEMENTS.maxConcurrentJobs);
    expect(result.maxItemChars).toBe(DEFAULT_ENTITLEMENTS.maxItemChars);
  });
});

describe('two tenants with different budgets read back their own', () => {
  it('acme=1000, umbrella=2000 each see their own budget', async () => {
    const { tenantId: acmeId } = await provisionTenant(db, {
      slug: 'ent-acme2',
      name: 'Acme Inc',
      ownerEmail: 'alice@acme.example',
      entitlements: { dailyTokenBudget: 1000 },
    });

    const { tenantId: umbrellaId } = await provisionTenant(db, {
      slug: 'ent-umbrella',
      name: 'Umbrella Corp',
      ownerEmail: 'charlie@umbrella.example',
      entitlements: { dailyTokenBudget: 2000 },
    });

    const acme = await withTenant(db, acmeId, getEntitlements);
    const umbrella = await withTenant(db, umbrellaId, getEntitlements);

    expect(acme.dailyTokenBudget).toBe(1000);
    expect(umbrella.dailyTokenBudget).toBe(2000);
  });
});

describe('a bare tenant without an entitlements row rejects', () => {
  it('makeTenant + getEntitlements throws MissingEntitlementsError', async () => {
    const bare = await makeTenant(db, 'bare');

    await expect(withTenant(db, bare.id, getEntitlements)).rejects
      .toBeInstanceOf(MissingEntitlementsError);
  });
});

describe('isModelAllowed', () => {
  it('returns true for "default" when present', () => {
    const et = {
      dailyTokenBudget: 1000,
      maxConcurrentJobs: 2,
      maxItemsPerOrder: 10,
      maxItemChars: 500,
      allowedModels: ['default'],
    };

    expect(isModelAllowed(et, 'default')).toBe(true);
  });

  it('returns false for "not-a-model"', () => {
    const et = {
      dailyTokenBudget: 1000,
      maxConcurrentJobs: 2,
      maxItemsPerOrder: 10,
      maxItemChars: 500,
      allowedModels: ['default'],
    };

    expect(isModelAllowed(et, 'not-a-model')).toBe(false);
  });
});
