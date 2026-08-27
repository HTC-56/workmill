import type { Engine } from '../db/engine.js';
import { withAdmin } from '../seam/withTenant.js';

/**
 * Provisioning a tenant — the operator action that creates the first row of a
 * tenant's world.
 *
 * This is an admin path by necessity: before the tenant exists there is no
 * tenant to pin, so RLS has nothing to scope. `withAdmin` is greppable for
 * exactly this reason (src/seam/withTenant.ts) — every hit is a place to ask
 * whether tenant data should have been reachable. Here the answer is yes, and
 * only here: everything a tenant does afterwards goes through withTenant().
 *
 * All four rows land in one transaction. A tenant that exists without its
 * entitlements row would be a tenant with no limits, and a tenant with no owner
 * would be a tenant nobody can administer; neither half-state is ever visible.
 */

export interface Entitlements {
  dailyTokenBudget: number;
  maxConcurrentJobs: number;
  maxItemsPerOrder: number;
  maxItemChars: number;
  allowedModels: readonly string[];
}

/**
 * What a tenant gets when nobody says otherwise.
 *
 * PROVISIONAL. These are starting values, not a tuned economy: nothing enforces
 * them yet, and the metering phase (SPEC.md feature 5) owns the real numbers
 * once there is a token ledger to measure against. Demo tenants get tighter
 * ones from the seed script (feature 9). `'default'` is a placeholder logical
 * model name; the gateway phase maps logical names to real ones.
 */
export const DEFAULT_ENTITLEMENTS: Entitlements = {
  dailyTokenBudget: 200_000,
  maxConcurrentJobs: 4,
  maxItemsPerOrder: 100,
  maxItemChars: 4_000,
  allowedModels: ['default'],
};

export interface ProvisionRequest {
  /** URL-safe tenant handle; the CHECK in 001 is the authority on its shape. */
  slug: string;
  name: string;
  ownerEmail: string;
  /** Defaults to the local part of the owner's address. */
  ownerName?: string;
  /** Partial override of DEFAULT_ENTITLEMENTS. */
  entitlements?: Partial<Entitlements>;
}

export interface ProvisionedTenant {
  tenantId: string;
  ownerUserId: string;
  membershipId: string;
  entitlementsId: string;
}

/** Addresses are stored as typed but compared lowercased; normalise once, here. */
export function normalizeEmail(email: string): string {
  return email.trim();
}

export async function provisionTenant(
  engine: Engine,
  request: ProvisionRequest,
): Promise<ProvisionedTenant> {
  const email = normalizeEmail(request.ownerEmail);
  const at = email.indexOf('@');
  if (at < 1) throw new RangeError(`owner email must contain a local part and a domain: ${email}`);
  const ownerName = request.ownerName ?? email.slice(0, at);
  const limits = { ...DEFAULT_ENTITLEMENTS, ...request.entitlements };

  return withAdmin(engine, async (sql) => {
    const [tenant] = await sql.query<{ id: string }>(
      'INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id',
      [request.slug, request.name],
    );
    if (!tenant) throw new Error('tenant insert returned no row');

    const [user] = await sql.query<{ id: string }>(
      `INSERT INTO users (tenant_id, email, display_name)
       VALUES ($1, $2, $3) RETURNING id`,
      [tenant.id, email, ownerName],
    );
    if (!user) throw new Error('owner insert returned no row');

    const [membership] = await sql.query<{ id: string }>(
      `INSERT INTO memberships (tenant_id, user_id, role)
       VALUES ($1, $2, 'owner') RETURNING id`,
      [tenant.id, user.id],
    );
    if (!membership) throw new Error('owner membership insert returned no row');

    const [entitlements] = await sql.query<{ id: string }>(
      `INSERT INTO entitlements (tenant_id, daily_token_budget, max_concurrent_jobs,
                                 max_items_per_order, max_item_chars, allowed_models)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        tenant.id,
        limits.dailyTokenBudget,
        limits.maxConcurrentJobs,
        limits.maxItemsPerOrder,
        limits.maxItemChars,
        [...limits.allowedModels],
      ],
    );
    if (!entitlements) throw new Error('entitlements insert returned no row');

    return {
      tenantId: tenant.id,
      ownerUserId: user.id,
      membershipId: membership.id,
      entitlementsId: entitlements.id,
    };
  });
}
