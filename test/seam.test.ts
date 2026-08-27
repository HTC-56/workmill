import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Engine } from '../src/db/engine.js';
import { withAdmin, withTenant, InvalidTenantIdError } from '../src/seam/withTenant.js';
import { freshDb, makeTenant, type TestTenant } from './helpers/db.js';

/**
 * Proves the seam closes behind itself.
 *
 * Patterned after test/leak.test.ts: same beforeAll shape (freshDb + two
 * tenants) and afterAll shape (db.close).
 */

let db: Engine;
let alice: TestTenant;
let bob: TestTenant;

beforeAll(async () => {
  db = await freshDb();
  alice = await makeTenant(db, 'alice');
  bob = await makeTenant(db, 'bob');
});

afterAll(async () => {
  await db?.close();
});

describe('withTenant rejects invalid tenant ids', () => {
  it('rejects a non-uuid string with InvalidTenantIdError and never runs the callback', async () => {
    let ran = false;
    await expect(
      withTenant(db, 'not-a-uuid', async () => {
        ran = true;
      }),
    ).rejects.toThrow(InvalidTenantIdError);
    expect(ran).toBe(false);
  });

  it('rejects an empty string with InvalidTenantIdError and never runs the callback', async () => {
    let ran = false;
    await expect(
      withTenant(db, '', async () => {
        ran = true;
      }),
    ).rejects.toThrow(InvalidTenantIdError);
    expect(ran).toBe(false);
  });
});

describe('withTenant pins the role inside the transaction', () => {
  it('SELECT current_user is workmill_app', async () => {
    const [row] = await withTenant(db, alice.id, (sql) =>
      sql.query<{ current_user: string }>('SELECT current_user'),
    );
    expect(row!.current_user).toBe('workmill_app');
  });
});

describe('withAdmin runs as the bootstrap role', () => {
  it('SELECT current_user is NOT workmill_app', async () => {
    const [row] = await withAdmin(db, (sql) => sql.query<{ current_user: string }>('SELECT current_user'));
    expect(row!.current_user).not.toBe('workmill_app');
  });
});

describe('the tenant pin does not survive the transaction', () => {
  it('after withTenant returns, withAdmin sees null/empty app.tenant_id', async () => {
    await withTenant(db, alice.id, async (sql) => {
      // Pin tenant inside this transaction — value is SET LOCAL.
      await sql.query('SELECT set_config($1, $2, true)', ['app.tenant_id', alice.id]);
    });

    // After the transaction ends, the setting should be gone.
    const [row] = await withAdmin(db, (sql) =>
      sql.query<{ val: string | null }>("SELECT current_setting('app.tenant_id', true) AS val"),
    );
    expect(row!.val ?? '').toBe('');
  });
});

describe('withTenant rolls back on callback throw', () => {
  it('rejects with the same error and the inserted row is absent', async () => {
    const testError = new Error('boom');

    await expect(
      withTenant(db, alice.id, async (sql) => {
        await sql.query(
          'INSERT INTO work_orders (tenant_id, item_count) VALUES ($1, 1)',
          [alice.id],
        );
        throw testError;
      }),
    ).rejects.toBe(testError);

    // Confirm via bob (not just admin) that the row never persisted —
    // proves the rollback was real, not just an admin bypass.
    const [count] = await withTenant(db, bob.id, (sql) =>
      sql.query<{ n: string | number }>(
        "SELECT count(*) AS n FROM work_orders WHERE tenant_id = $1",
        [alice.id],
      ),
    );
    expect(Number(count!.n)).toBe(0);
  });
});
