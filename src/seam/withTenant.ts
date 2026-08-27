import type { Engine, Session } from '../db/engine.js';

/**
 * The only door to tenant data.
 *
 * Every query that touches a tenant-scoped table goes through withTenant(). It
 * opens a transaction, drops into the unprivileged application role, and pins
 * the current tenant into a transaction-local GUC that every RLS policy reads
 * via app_tenant_id(). Both settings are `LOCAL`, so they die with the
 * transaction and cannot leak into the next borrower of a pooled connection.
 *
 * Isolation is therefore enforced by the database, not by this function: even a
 * query that forgets its `WHERE tenant_id = …` returns only the current
 * tenant's rows. The leak suite proves that for every table in the catalog.
 */

/** The unprivileged role the application runs as. Created by migration 001. */
export const APP_ROLE = 'workmill_app';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InvalidTenantIdError extends Error {
  constructor(value: string) {
    super(`not a tenant id: ${JSON.stringify(value)}`);
    this.name = 'InvalidTenantIdError';
  }
}

export async function withTenant<T>(
  engine: Engine,
  tenantId: string,
  fn: (sql: Session) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(tenantId)) throw new InvalidTenantIdError(tenantId);
  return engine.transaction(async (sql) => {
    // Parameterised, so the tenant id is never interpolated into SQL. The role
    // name cannot be a parameter, but it is this module's constant — no caller
    // chooses it.
    await sql.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
    await sql.query(`SET LOCAL ROLE ${APP_ROLE}`);
    return fn(sql);
  });
}

/**
 * A transaction with the bootstrap role's privileges and no tenant pinned —
 * migrations, operator provisioning, and test fixtures. RLS does not constrain
 * this path, which is exactly why it is named: `withAdmin` is greppable, and
 * every hit is a place to ask whether tenant data should have been reachable.
 * Never call it from a tenant-reachable request handler.
 */
export async function withAdmin<T>(
  engine: Engine,
  fn: (sql: Session) => Promise<T>,
): Promise<T> {
  return engine.transaction(fn);
}
