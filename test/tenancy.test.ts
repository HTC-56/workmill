import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Engine } from '../src/db/engine.js';
import { withAdmin, withTenant } from '../src/seam/withTenant.js';
import { freshDb } from './helpers/db.js';
import {
  provisionTenant,
  DEFAULT_ENTITLEMENTS,
} from '../src/tenancy/provision.js';

/**
 * Proves `provisionTenant` and `DEFAULT_ENTITLEMENTS` in
 * `src/tenancy/provision.ts`: the four rows, the defaults, and the rollback.
 *
 * Patterned after test/seam.test.ts: same beforeAll shape (freshDb) and
 * afterAll shape (db.close).
 */

let db: Engine;

beforeAll(async () => {
  db = await freshDb();
});

afterAll(async () => {
  await db?.close();
});

describe('provisionTenant returns four non-empty ids', () => {
  it('tenantId, ownerUserId, membershipId, entitlementsId are all non-empty', async () => {
    const res = await provisionTenant(db, {
      slug: 'acme',
      name: 'Acme Inc',
      ownerEmail: 'alice@acme.example',
    });

    expect(res.tenantId).toBeDefined();
    expect(res.tenantId.length).toBeGreaterThan(0);
    expect(res.ownerUserId).toBeDefined();
    expect(res.ownerUserId.length).toBeGreaterThan(0);
    expect(res.membershipId).toBeDefined();
    expect(res.membershipId.length).toBeGreaterThan(0);
    expect(res.entitlementsId).toBeDefined();
    expect(res.entitlementsId.length).toBeGreaterThan(0);
  });
});

describe('reading inside withTenant finds exactly one user, one membership, one entitlements', () => {
  it('each table has exactly one row for the tenant', async () => {
    const { tenantId } = await provisionTenant(db, {
      slug: 'globex',
      name: 'Globex Corp',
      ownerEmail: 'bob@globex.example',
    });

    const counts = await withTenant(db, tenantId, async (sql) => {
      const [u] = await sql.query<{ n: number }>(
        "SELECT count(*) AS n FROM users WHERE tenant_id = $1",
        [tenantId],
      );
      const [m] = await sql.query<{ n: number }>(
        "SELECT count(*) AS n FROM memberships WHERE tenant_id = $1",
        [tenantId],
      );
      const [e] = await sql.query<{ n: number }>(
        "SELECT count(*) AS n FROM entitlements WHERE tenant_id = $1",
        [tenantId],
      );
      return { users: u?.n ?? 0, memberships: m?.n ?? 0, entitlements: e?.n ?? 0 };
    });

    expect(counts.users).toBe(1);
    expect(counts.memberships).toBe(1);
    expect(counts.entitlements).toBe(1);
  });
});

describe("the owner's membership role is 'owner'", () => {
  it('role column is "owner"', async () => {
    const { tenantId, ownerUserId } = await provisionTenant(db, {
      slug: 'initech',
      name: 'Initech',
      ownerEmail: 'bill@initech.example',
    });

    const [row] = await withTenant(db, tenantId, (sql) =>
      sql.query<{ role: string }>(
        'SELECT role FROM memberships WHERE tenant_id = $1 AND user_id = $2',
        [tenantId, ownerUserId],
      ),
    );

    expect(row!.role).toBe('owner');
  });
});

describe('the user email is stored exactly as passed', () => {
  it('preserves capitalisation', async () => {
    const { tenantId, ownerUserId } = await provisionTenant(db, {
      slug: 'soylent',
      name: 'Soylent Corp',
      ownerEmail: 'Elena@soylent.example',
    });

    const [row] = await withTenant(db, tenantId, (sql) =>
      sql.query<{ email: string }>(
        'SELECT email FROM users WHERE id = $1',
        [ownerUserId],
      ),
    );

    expect(row!.email).toBe('Elena@soylent.example');
  });
});

describe("omitting ownerName gives display_name equal to the local part of the address", () => {
  it('bob@example.com → display_name is "bob"', async () => {
    const { tenantId, ownerUserId } = await provisionTenant(db, {
      slug: 'umbrella',
      name: 'Umbrella Corp',
      ownerEmail: 'bob@example.com',
    });

    const [row] = await withTenant(db, tenantId, (sql) =>
      sql.query<{ display_name: string }>(
        'SELECT display_name FROM users WHERE id = $1',
        [ownerUserId],
      ),
    );

    expect(row!.display_name).toBe('bob');
  });
});

describe('the entitlements row carries DEFAULT_ENTITLEMENTS', () => {
  it('daily_token_budget, max_concurrent_jobs, max_items_per_order, max_item_chars', async () => {
    const { tenantId, entitlementsId } = await provisionTenant(db, {
      slug: 'wayne',
      name: 'Wayne Enterprises',
      ownerEmail: 'bruce@wayne.example',
    });

    const [row] = await withTenant(db, tenantId, (sql) =>
      sql.query<{
        daily_token_budget: unknown;
        max_concurrent_jobs: unknown;
        max_items_per_order: unknown;
        max_item_chars: unknown;
      }>(
        'SELECT daily_token_budget, max_concurrent_jobs, max_items_per_order, max_item_chars FROM entitlements WHERE id = $1',
        [entitlementsId],
      ),
    );

    expect(Number(row!.daily_token_budget)).toBe(DEFAULT_ENTITLEMENTS.dailyTokenBudget);
    expect(Number(row!.max_concurrent_jobs)).toBe(DEFAULT_ENTITLEMENTS.maxConcurrentJobs);
    expect(Number(row!.max_items_per_order)).toBe(DEFAULT_ENTITLEMENTS.maxItemsPerOrder);
    expect(Number(row!.max_item_chars)).toBe(DEFAULT_ENTITLEMENTS.maxItemChars);
  });

  it('allowed_models equals the default array', async () => {
    const { tenantId, entitlementsId } = await provisionTenant(db, {
      slug: 'stark',
      name: 'Stark Industries',
      ownerEmail: 'tony@stark.example',
    });

    const [row] = await withTenant(db, tenantId, (sql) =>
      sql.query<{ allowed_models: unknown }>(
        'SELECT allowed_models FROM entitlements WHERE id = $1',
        [entitlementsId],
      ),
    );

    const models = row!.allowed_models as unknown[];
    expect(models).toEqual(['default']);
  });
});

describe('passing entitlements overrides only the given field', () => {
  it('maxItemsPerOrder: 7 overrides only that; others stay at defaults', async () => {
    const { tenantId, entitlementsId } = await provisionTenant(db, {
      slug: 'cyberdyne',
      name: 'Cyberdyne Systems',
      ownerEmail: 'skynet@cyberdyne.example',
      entitlements: { maxItemsPerOrder: 7 },
    });

    const [row] = await withTenant(db, tenantId, (sql) =>
      sql.query<{
        daily_token_budget: unknown;
        max_concurrent_jobs: unknown;
        max_items_per_order: unknown;
        max_item_chars: unknown;
      }>(
        'SELECT daily_token_budget, max_concurrent_jobs, max_items_per_order, max_item_chars FROM entitlements WHERE id = $1',
        [entitlementsId],
      ),
    );

    expect(Number(row!.max_items_per_order)).toBe(7);
    expect(Number(row!.daily_token_budget)).toBe(DEFAULT_ENTITLEMENTS.dailyTokenBudget);
    expect(Number(row!.max_concurrent_jobs)).toBe(DEFAULT_ENTITLEMENTS.maxConcurrentJobs);
    expect(Number(row!.max_item_chars)).toBe(DEFAULT_ENTITLEMENTS.maxItemChars);
  });
});

describe('atomicity: duplicate slug rejects and rolls back', () => {
  it('second provision with same slug rejects; withAdmin finds zero users with the second email', async () => {
    await provisionTenant(db, {
      slug: 'omni',
      name: 'Omni Consumer Products',
      ownerEmail: 'first@omni.example',
    });

    await expect(
      provisionTenant(db, {
        slug: 'omni',
        name: 'Omni Consumer Products (duplicate)',
        ownerEmail: 'second@omni.example',
      }),
    ).rejects.toThrow();

    // The rollback should leave zero users with the second email.
    const [count] = await withAdmin(db, (sql) =>
      sql.query<{ n: number }>(
        'SELECT count(*) AS n FROM users WHERE email = $1',
        ['second@omni.example'],
      ),
    );

    expect(count!.n).toBe(0);
  });
});
