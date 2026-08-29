import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Engine, Session } from '../db/engine.js';
import type { GatewayConfig } from '../gateway/client.js';
import { withTenant } from '../seam/withTenant.js';
import { requireOperator } from './guards.js';
import { provisionTenant, type Entitlements } from '../tenancy/provision.js';
import {
  EntitlementValueError,
  listTenantRows,
  setTenantState,
  tenantExists,
  updateEntitlements,
  TENANT_STATES,
  type EntitlementPatch,
  type TenantState,
} from '../operator/tenants.js';
import {
  activeSupportGrant,
  grantRemainingMs,
  grantSupportAccess,
  GrantRefusedError,
  isGrantActive,
  listSupportGrants,
  revokeSupportGrant,
  type SupportGrant,
} from '../operator/grants.js';
import { AUDIT_ACTIONS, clampAuditLimit, listAudit, recordAudit } from '../operator/audit.js';
import { collectFleet } from '../operator/fleet.js';

/**
 * The operator JSON API (SPEC.md feature 7), behind the operator bearer.
 *
 * Two rules run through every route here, and they are the difference between
 * an operator console and a back door.
 *
 * ONE: the operator bearer is a different credential from any tenant's, and it
 * belongs to no tenant. `requireOperator` refuses with 503 when no operator
 * token is configured — a missing secret means "off", never "unguarded" — and
 * with 401 otherwise. A tenant's own token reaches nothing in this file.
 *
 * TWO: an operator names a tenant, and then the WRITE runs under that tenant's
 * pinned session. Reading the fleet is cross-tenant and admits it (withAdmin,
 * behind this bearer); changing one tenant's limits is not, so it goes through
 * `withTenant` and the policy is what permits the row. The console cannot
 * edit two tenants in one statement even by miscomputing an id.
 *
 * EVERY WRITE LEAVES A RECEIPT. The audit entry is appended in the SAME
 * transaction as the change it describes, so there is no window in which a
 * tenant's limits moved and the trail does not say who moved them.
 */

/** Rejects a path parameter before it reaches the database as a uuid cast. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The shape sql/001's CHECK allows for a tenant handle. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

/** What the console calls itself in the trail when nobody says otherwise. */
export const DEFAULT_ACTOR = 'operator';

export interface OperatorApiOptions {
  engine: Engine;
  /** Null disables every route in this file with a 503. */
  operatorToken: string | null;
  /** Null means no gateway is configured; the fleet panel reports that. */
  gateway?: GatewayConfig | null;
}

/** Postgres' unique-violation SQLSTATE, however the driver hands it over. */
function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  if (code === '23505') return true;
  return /duplicate key value/i.test(error instanceof Error ? error.message : String(error));
}

function asRecord(body: unknown): Record<string, unknown> | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  return body as Record<string, unknown>;
}

/** A grant as the console reads it: the row plus the countdown, precomputed. */
function toGrantPayload(grant: SupportGrant, now: number): Record<string, unknown> {
  return {
    id: grant.id,
    reason: grant.reason,
    grantedBy: grant.grantedBy,
    createdAt: grant.createdAt,
    expiresAt: grant.expiresAt,
    revokedAt: grant.revokedAt,
    active: isGrantActive(grant, now),
    remainingMs: grantRemainingMs(grant, now),
  };
}

/** Read a provision body without trusting any of it. Returns a message on failure. */
function readProvisionBody(
  body: unknown,
): { slug: string; name: string; ownerEmail: string; entitlements?: Partial<Entitlements> } | string {
  const record = asRecord(body);
  if (!record) return 'body must be a JSON object';
  const slug = record['slug'];
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    return 'slug must be 3..40 lowercase characters, digits or hyphens';
  }
  const name = record['name'];
  if (typeof name !== 'string' || name.trim().length < 1 || name.length > 200) {
    return 'name must be 1..200 characters';
  }
  const ownerEmail = record['ownerEmail'];
  if (typeof ownerEmail !== 'string' || ownerEmail.indexOf('@') < 1) {
    return 'ownerEmail must contain a local part and a domain';
  }
  const entitlements = record['entitlements'];
  if (entitlements !== undefined && asRecord(entitlements) === null) {
    return 'entitlements must be a JSON object when present';
  }
  // Spread rather than assign undefined: `exactOptionalPropertyTypes` treats an
  // absent key and a key holding undefined as different things, and so does
  // `provisionTenant`'s spread of DEFAULT_ENTITLEMENTS.
  return {
    slug,
    name,
    ownerEmail,
    ...(entitlements === undefined ? {} : { entitlements: entitlements as Partial<Entitlements> }),
  };
}

export function registerOperatorApi(
  fastify: FastifyInstance,
  options: OperatorApiOptions,
): void {
  const { engine } = options;
  const operatorToken = options.operatorToken;
  const gateway = options.gateway ?? null;

  /**
   * Guard, resolve the tenant in the path, and run `fn` with it pinned.
   *
   * The existence check is a separate admin read on purpose: without it an
   * unknown tenant id would open a session that sees nothing and every write
   * would answer "changed 0 rows", which is indistinguishable from a no-op edit.
   * A 404 says the right thing.
   */
  const onTenant = async <T>(
    request: FastifyRequest<{ Params: { tenantId: string } }>,
    reply: FastifyReply,
    fn: (sql: Session, tenantId: string) => Promise<T>,
  ): Promise<T | FastifyReply> => {
    if (!(await requireOperator(operatorToken, request, reply))) return reply;
    const { tenantId } = request.params;
    if (!UUID_RE.test(tenantId) || !(await tenantExists(engine, tenantId))) {
      return reply.code(404).send({ error: 'no-such-tenant' });
    }
    return withTenant(engine, tenantId, (sql) => fn(sql, tenantId));
  };

  /** The tenant table: state, entitlements and the triage counts. */
  fastify.get('/api/operator/tenants', async (request, reply) => {
    if (!(await requireOperator(operatorToken, request, reply))) return reply;
    return reply.code(200).send({ tenants: await listTenantRows(engine) });
  });

  /**
   * The provision form. 201 with the new ids.
   *
   * A duplicate slug is 409 rather than 500: two operators racing to create the
   * same demo tenant is an ordinary thing to do, and the unique index is the
   * right place for that to be decided.
   */
  fastify.post<{ Body: unknown }>('/api/operator/tenants', async (request, reply) => {
    if (!(await requireOperator(operatorToken, request, reply))) return reply;
    const parsed = readProvisionBody(request.body);
    if (typeof parsed === 'string') {
      return reply.code(400).send({ error: 'bad-request', message: parsed });
    }
    let provisioned;
    try {
      provisioned = await provisionTenant(engine, parsed);
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({ error: 'slug-taken', slug: parsed.slug });
      }
      throw error;
    }
    // The trail starts with the tenant. Written under the new tenant's own
    // session, so it is a row that tenant can read on its first login.
    await withTenant(engine, provisioned.tenantId, (sql) =>
      recordAudit(sql, {
        actor: DEFAULT_ACTOR,
        action: AUDIT_ACTIONS.tenantProvisioned,
        detail: { slug: parsed.slug, name: parsed.name },
      }),
    );
    return reply.code(201).send({
      tenantId: provisioned.tenantId,
      ownerUserId: provisioned.ownerUserId,
      slug: parsed.slug,
    });
  });

  /** Change some of one tenant's limits. The trail records the patch. */
  fastify.post<{ Params: { tenantId: string }; Body: unknown }>(
    '/api/operator/tenants/:tenantId/entitlements',
    async (request, reply) =>
      onTenant(request, reply, async (sql) => {
        const patch = asRecord(request.body);
        if (!patch) return reply.code(400).send({ error: 'bad-request', message: 'body must be a JSON object' });
        let limits;
        try {
          limits = await updateEntitlements(sql, patch as EntitlementPatch);
        } catch (error) {
          if (error instanceof EntitlementValueError) {
            return reply
              .code(400)
              .send({ error: 'bad-entitlement', field: error.field, message: error.message });
          }
          throw error;
        }
        // Null means the tenant has no entitlements row — the fail-open seam,
        // reported rather than papered over with an invented row.
        if (!limits) return reply.code(409).send({ error: 'no-entitlements-row' });
        await recordAudit(sql, {
          actor: DEFAULT_ACTOR,
          action: AUDIT_ACTIONS.entitlementsUpdated,
          detail: { patch, limits },
        });
        return reply.code(200).send({ limits });
      }),
  );

  /** Suspend or resume one tenant. A label in v1 — see src/operator/tenants.ts. */
  fastify.post<{ Params: { tenantId: string }; Body: unknown }>(
    '/api/operator/tenants/:tenantId/state',
    async (request, reply) =>
      onTenant(request, reply, async (sql) => {
        const record = asRecord(request.body);
        const state = record?.['state'];
        if (typeof state !== 'string' || !TENANT_STATES.includes(state as TenantState)) {
          return reply
            .code(400)
            .send({ error: 'bad-request', message: `state must be one of ${TENANT_STATES.join(', ')}` });
        }
        const changed = await setTenantState(sql, state as TenantState);
        if (changed) {
          await recordAudit(sql, {
            actor: DEFAULT_ACTOR,
            action: AUDIT_ACTIONS.tenantStateChanged,
            detail: { state },
          });
        }
        return reply.code(200).send({ state, changed });
      }),
  );

  /** This tenant's grants, newest expiry first, with the countdown precomputed. */
  fastify.get<{ Params: { tenantId: string } }>(
    '/api/operator/tenants/:tenantId/grants',
    async (request, reply) =>
      onTenant(request, reply, async (sql) => {
        const now = Date.now();
        const grants = await listSupportGrants(sql);
        const active = await activeSupportGrant(sql);
        return reply.code(200).send({
          grants: grants.map((grant) => toGrantPayload(grant, now)),
          active: active ? toGrantPayload(active, now) : null,
        });
      }),
  );

  /**
   * Open a support window. 201 with the grant.
   *
   * A missing or short reason is 422, not 400: the body was well formed and the
   * RULE refused it, which is the same distinction `POST /api/orders` draws
   * between a malformed submit and an entitlement refusal.
   */
  fastify.post<{ Params: { tenantId: string }; Body: unknown }>(
    '/api/operator/tenants/:tenantId/grants',
    async (request, reply) =>
      onTenant(request, reply, async (sql) => {
        const record = asRecord(request.body);
        if (!record) return reply.code(400).send({ error: 'bad-request', message: 'body must be a JSON object' });
        const reason = record['reason'];
        const grantedBy = record['grantedBy'] ?? DEFAULT_ACTOR;
        const ttlMs = record['ttlMs'];
        if (typeof reason !== 'string' || typeof grantedBy !== 'string') {
          return reply
            .code(400)
            .send({ error: 'bad-request', message: 'reason and grantedBy must be strings' });
        }
        if (ttlMs !== undefined && typeof ttlMs !== 'number') {
          return reply.code(400).send({ error: 'bad-request', message: 'ttlMs must be a number' });
        }
        let grant;
        try {
          grant = await grantSupportAccess(sql, {
            reason,
            grantedBy,
            ...(ttlMs === undefined ? {} : { ttlMs }),
          });
        } catch (error) {
          if (error instanceof GrantRefusedError) {
            return reply
              .code(422)
              .send({ error: 'grant-refused', reason: error.reason, message: error.message });
          }
          throw error;
        }
        await recordAudit(sql, {
          actor: grant.grantedBy,
          action: AUDIT_ACTIONS.supportGranted,
          detail: { reason: grant.reason, expiresAt: grant.expiresAt },
          grantId: grant.id,
        });
        return reply.code(201).send(toGrantPayload(grant, Date.now()));
      }),
  );

  /** Close a window early. 404 when it is not this tenant's or already revoked. */
  fastify.post<{ Params: { tenantId: string; grantId: string } }>(
    '/api/operator/tenants/:tenantId/grants/:grantId/revoke',
    async (request, reply) =>
      onTenant(request, reply, async (sql) => {
        const { grantId } = request.params;
        const revoked = UUID_RE.test(grantId) ? await revokeSupportGrant(sql, grantId) : false;
        if (!revoked) return reply.code(404).send({ error: 'no-such-grant' });
        await recordAudit(sql, {
          actor: DEFAULT_ACTOR,
          action: AUDIT_ACTIONS.supportRevoked,
          detail: {},
          grantId,
        });
        return reply.code(200).send({ revoked: true, grantId });
      }),
  );

  /** One tenant's trail, as the operator sees it. The tenant reads /api/audit. */
  fastify.get<{ Params: { tenantId: string }; Querystring: { limit?: string } }>(
    '/api/operator/tenants/:tenantId/audit',
    async (request, reply) =>
      onTenant(request, reply, async (sql) => ({
        entries: await listAudit(sql, clampAuditLimit(request.query.limit)),
      })),
  );

  /** Gateway health, queue depth, jobs per hour. Cross-tenant by definition. */
  fastify.get('/api/operator/fleet', async (request, reply) => {
    if (!(await requireOperator(operatorToken, request, reply))) return reply;
    return reply.code(200).send(await collectFleet(engine, { gateway }));
  });
}
