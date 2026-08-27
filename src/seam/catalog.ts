import type { Engine } from '../db/engine.js';
import { withAdmin } from './withTenant.js';

/**
 * Runtime discovery of every tenant-scoped table.
 *
 * A table declares itself with `COMMENT ON TABLE x IS 'tenant-scoped:<column>'`
 * in its migration. The leak suite reads this catalog and proves isolation for
 * whatever it finds, so a table added later is covered the day it lands — and a
 * table that declares itself but forgets its policies fails the build. Nothing
 * here is a hand-maintained list; that is the whole point.
 */

export interface TenantScopedTable {
  readonly table: string;
  /** The column carrying the tenant id — `id` on the tenants table itself. */
  readonly tenantColumn: string;
  readonly rowSecurityEnabled: boolean;
  readonly rowSecurityForced: boolean;
  readonly policyCount: number;
}

const MARKER = 'tenant-scoped:';

export async function discoverTenantScopedTables(engine: Engine): Promise<TenantScopedTable[]> {
  return withAdmin(engine, async (sql) => {
    const rows = await sql.query<{
      table_name: string;
      comment: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
      policy_count: string | number;
    }>(
      `SELECT c.relname                                   AS table_name,
              obj_description(c.oid, 'pg_class')          AS comment,
              c.relrowsecurity                            AS relrowsecurity,
              c.relforcerowsecurity                       AS relforcerowsecurity,
              (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policy_count
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'r'
          AND n.nspname = 'public'
          AND obj_description(c.oid, 'pg_class') LIKE $1
        ORDER BY c.relname`,
      [`${MARKER}%`],
    );

    return rows.map((row) => ({
      table: row.table_name,
      tenantColumn: row.comment.slice(MARKER.length).trim(),
      rowSecurityEnabled: row.relrowsecurity === true,
      rowSecurityForced: row.relforcerowsecurity === true,
      policyCount: Number(row.policy_count),
    }));
  });
}
