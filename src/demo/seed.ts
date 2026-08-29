import type { Engine } from '../db/engine.js';
import { withAdmin, withTenant } from '../seam/withTenant.js';
import { provisionTenant, type Entitlements } from '../tenancy/provision.js';
import { seedExampleWorkflows } from '../workflows/examples.js';
import { mintApiToken } from '../server/auth.js';

/**
 * Demo mode (SPEC.md feature 9): two tenants, tight budgets, the three example
 * workflows, and one bearer token each.
 *
 * The safety story here is the point, and it is deliberately boring: a demo
 * tenant is an ORDINARY tenant. It gets no special case, no separate code path
 * and no bypass — it is bounded by the same entitlements every tenant is
 * bounded by, just with smaller numbers in them. If a public demo can be abused
 * into spending the box's whole day of tokens, that is a bug in the entitlement
 * system and it would be a bug for paying tenants too. Demo mode is a
 * configuration of the product, never a fork of it.
 *
 * A NAMED CALL, recorded here rather than assumed: the two demo tenants get
 * DIFFERENT budgets, and the second one's is absurdly small on purpose. The
 * README quickstart has to show a budget exhaustion refused mid-order inside
 * ten minutes, and the honest way to show that is a tenant whose budget a
 * five-item order really does exhaust — not a rigged flag, not a stubbed
 * counter. `demo-acme` is the tenant you play with; `demo-globex` is the tenant
 * that runs out, because watching a real refusal is the demo.
 */

/** Every demo tenant's slug starts with this. `clearDemo` will touch no other. */
export const DEMO_SLUG_PREFIX = 'demo-';

/** What a demo token is called in `api_tokens`, so an operator can spot it. */
export const DEMO_TOKEN_NAME = 'demo seed';

export interface DemoTenantSpec {
  readonly slug: string;
  readonly name: string;
  readonly ownerEmail: string;
  readonly entitlements: Partial<Entitlements>;
  /** One line for the seed script's output — why this tenant exists. */
  readonly note: string;
}

export const DEMO_TENANTS: readonly DemoTenantSpec[] = [
  {
    slug: 'demo-acme',
    name: 'Acme (demo)',
    ownerEmail: 'owner@acme.example',
    entitlements: {
      dailyTokenBudget: 20_000,
      maxConcurrentJobs: 2,
      maxItemsPerOrder: 10,
      maxItemChars: 800,
      allowedModels: ['default'],
    },
    note: 'the roomy one — run orders here',
  },
  {
    slug: 'demo-globex',
    name: 'Globex (demo)',
    ownerEmail: 'owner@globex.example',
    entitlements: {
      dailyTokenBudget: 600,
      maxConcurrentJobs: 1,
      maxItemsPerOrder: 10,
      maxItemChars: 800,
      allowedModels: ['default'],
    },
    note: 'the tight one — a five-item order exhausts this budget on purpose',
  },
];

export interface DemoWorkflowHandle {
  readonly slug: string;
  readonly workflowId: string;
}

export interface DemoTenantHandle {
  readonly slug: string;
  readonly name: string;
  readonly tenantId: string;
  readonly ownerUserId: string;
  /** Returned once, at mint time — only its hash is stored. */
  readonly token: string;
  readonly workflows: readonly DemoWorkflowHandle[];
  readonly note: string;
}

export interface DemoManifest {
  readonly tenants: readonly DemoTenantHandle[];
}

/**
 * The manifest as a person reads it, one block per tenant, ending with the
 * bearer — the CLI helper the dashboard and console reservations both pointed
 * at ("no page mints a token; the CLI helper belongs with the demo seed
 * script"). The token is printed once and stored only as a hash, so this output
 * is the only copy; the demo gets no softer a rule than any other tenant.
 */
export function formatManifest(manifest: DemoManifest): string[] {
  const lines: string[] = [];
  for (const tenant of manifest.tenants) {
    lines.push(`${tenant.slug} — ${tenant.name}`);
    lines.push(`  ${tenant.note}`);
    lines.push(`  tenant id: ${tenant.tenantId}`);
    lines.push(`  workflows: ${tenant.workflows.map((w) => w.slug).join(', ')}`);
    lines.push(`  bearer:    ${tenant.token}`);
    lines.push('');
  }
  lines.push('Paste a bearer into the dashboard at GET / to use that tenant.');
  return lines;
}

/** Thrown when a demo tenant is already there: reset is the verb, not seed. */
export class DemoExistsError extends Error {
  constructor(readonly slug: string) {
    super(`demo tenant ${slug} already exists; reset the demo instead of seeding it again`);
    this.name = 'DemoExistsError';
  }
}

export interface SeedDemoOptions {
  /** Overridable so a test can seed one tenant instead of the pair. */
  readonly specs?: readonly DemoTenantSpec[];
  readonly tokenName?: string;
}

/** The demo tenants that exist right now, by slug. Admin read: cross-tenant. */
export async function listDemoTenants(
  engine: Engine,
  specs: readonly DemoTenantSpec[] = DEMO_TENANTS,
): Promise<{ slug: string; id: string }[]> {
  return withAdmin(engine, async (sql) => {
    const rows = await sql.query<{ id: string; slug: string }>(
      'SELECT id, slug FROM tenants WHERE slug = ANY($1) ORDER BY slug',
      [specs.map((spec) => spec.slug)],
    );
    return rows.map((row) => ({ slug: row.slug, id: row.id }));
  });
}

/**
 * Provision the demo tenants, seed their workflows, and mint one token each.
 *
 * Refuses rather than duplicating: a demo tenant that already exists means the
 * caller wanted `resetDemo`. Each tenant is independent, so a refusal on the
 * second leaves the first alone — the manifest says what really happened.
 */
export async function seedDemo(
  engine: Engine,
  options: SeedDemoOptions = {},
): Promise<DemoManifest> {
  const specs = options.specs ?? DEMO_TENANTS;
  const tokenName = options.tokenName ?? DEMO_TOKEN_NAME;

  const existing = new Set((await listDemoTenants(engine, specs)).map((row) => row.slug));
  for (const spec of specs) {
    if (existing.has(spec.slug)) throw new DemoExistsError(spec.slug);
  }

  const tenants: DemoTenantHandle[] = [];
  for (const spec of specs) {
    const provisioned = await provisionTenant(engine, {
      slug: spec.slug,
      name: spec.name,
      ownerEmail: spec.ownerEmail,
      entitlements: spec.entitlements,
    });

    // Workflows and the token are tenant data, so they go through the seam like
    // everything else. Provisioning is the one admin step, and it stays one.
    const seeded = await withTenant(engine, provisioned.tenantId, async (sql) => {
      const workflows = await seedExampleWorkflows(sql);
      const minted = await mintApiToken(sql, provisioned.tenantId, {
        name: tokenName,
        userId: provisioned.ownerUserId,
      });
      return { workflows, token: minted.token };
    });

    tenants.push({
      slug: spec.slug,
      name: spec.name,
      tenantId: provisioned.tenantId,
      ownerUserId: provisioned.ownerUserId,
      token: seeded.token,
      workflows: seeded.workflows,
      note: spec.note,
    });
  }

  return { tenants };
}
