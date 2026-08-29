import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Engine, Session } from '../db/engine.js';
import { withTenant } from '../seam/withTenant.js';
import { requireTenant } from './guards.js';
import {
  clampPageSize,
  getOrderDetail,
  listDeadLetter,
  listOrders,
  listWorkflowCards,
} from '../dashboard/queries.js';
import { enqueueOrder } from '../queue/enqueue.js';
import { cancelOrder, requeueJob } from '../queue/lifecycle.js';
import { getWorkflow, WorkflowNotFoundError } from '../workflows/store.js';
import { budgetStatus, EntitlementRefusedError, readLimits } from '../metering/limits.js';
import { usageByDay } from '../metering/ledger.js';

/**
 * The tenant JSON API the dashboard is made of (SPEC.md feature 6).
 *
 * Every route here is one panel of `GET /`. The page holds no server-rendered
 * state — it is a static document that fetches these, which is what makes it a
 * single self-contained file with no build step. It also makes the API the real
 * product surface: everything the page can do, `curl` with a bearer can do.
 *
 * THE TENANT IS NEVER A PARAMETER. It comes from the bearer, through
 * `requireTenant`, into `withTenant` — so a route cannot read another tenant's
 * order by being asked nicely, and an id belonging to someone else is a 404
 * rather than a 403. There is no `?tenant=` anywhere in this file, and there
 * must never be one: the day a tenant id becomes a request parameter is the day
 * the isolation proof stops covering the HTTP surface.
 *
 * Writes are the three verbs SPEC.md feature 6 names — submit, cancel, requeue
 * — and each is the existing library function under a bearer. No route here
 * re-implements a rule: item caps, the model check and the budget all refuse
 * inside `enqueueOrder` and the claim query, exactly as they do for the runner.
 */

/** How many days of usage the meter shows. */
export const USAGE_DAYS = 14;

/** Rejects a path parameter before it reaches the database as a uuid cast. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TenantApiOptions {
  engine: Engine;
}

interface TenantRow {
  id: string;
  slug: string;
  name: string;
}

/** The submitted body, once it has been proven to be the shape we accept. */
interface SubmitBody {
  workflowId: string;
  items: string[];
}

/**
 * Read a submit body without trusting any of it.
 *
 * Returns a message rather than throwing, so the caller answers 400 with the
 * field that was wrong. Item LENGTH and COUNT are deliberately not checked
 * here: those are entitlements, they are enforced by `enqueueOrder` and by the
 * triggers underneath it, and a second copy of the numbers in this file would
 * be a copy that drifts.
 */
function readSubmitBody(body: unknown): SubmitBody | string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return 'body must be a JSON object';
  }
  const record = body as Record<string, unknown>;
  const workflowId = record['workflowId'];
  if (typeof workflowId !== 'string' || !UUID_RE.test(workflowId)) {
    return 'workflowId must be a uuid';
  }
  const items = record['items'];
  if (!Array.isArray(items) || items.length === 0) {
    return 'items must be a non-empty array of strings';
  }
  if (!items.every((item): item is string => typeof item === 'string' && item.length > 0)) {
    return 'every item must be a non-empty string';
  }
  return { workflowId, items };
}

/** Answer the two refusals a submit can produce, or re-throw anything else. */
async function sendSubmitFailure(error: unknown, reply: FastifyReply): Promise<FastifyReply> {
  if (error instanceof WorkflowNotFoundError) {
    return reply.code(404).send({ error: 'no-such-workflow' });
  }
  if (error instanceof EntitlementRefusedError) {
    // 422, not 400: the request was well formed and the tenant's own limits
    // refused it. The reason is machine-readable so the page can say which one.
    return reply.code(422).send({
      error: 'entitlement-refused',
      reason: error.reason,
      message: error.message,
    });
  }
  throw error;
}

export function registerTenantApi(fastify: FastifyInstance, options: TenantApiOptions): void {
  const { engine } = options;

  /**
   * Run `fn` as the bearer's tenant, or answer 401. Every route below is this
   * one line plus a query — the guard and the seam are never optional and never
   * spelled out twice.
   */
  const asTenant = async <T>(
    request: Parameters<typeof requireTenant>[1],
    reply: FastifyReply,
    fn: (sql: Session, tenantId: string) => Promise<T>,
  ): Promise<T | FastifyReply> => {
    const identity = await requireTenant(engine, request, reply);
    if (!identity) return reply;
    return withTenant(engine, identity.tenantId, (sql) => fn(sql, identity.tenantId));
  };

  /** Who this bearer is, what it may spend, and where it stands today. */
  fastify.get('/api/me', async (request, reply) =>
    asTenant(request, reply, async (sql, tenantId) => {
      const [tenant] = await sql.query<TenantRow>('SELECT id, slug, name FROM tenants');
      return {
        tenantId,
        slug: tenant?.slug ?? null,
        name: tenant?.name ?? null,
        limits: await readLimits(sql),
        budget: await budgetStatus(sql),
      };
    }),
  );

  /** The workflow list and the submit form's options, in one payload. */
  fastify.get('/api/workflows', async (request, reply) =>
    asTenant(request, reply, async (sql) => ({ workflows: await listWorkflowCards(sql) })),
  );

  fastify.get<{ Querystring: { limit?: string } }>('/api/orders', async (request, reply) =>
    asTenant(request, reply, async (sql) => ({
      orders: await listOrders(sql, clampPageSize(request.query.limit)),
    })),
  );

  /**
   * Submit a work order against a workflow's CURRENT version.
   *
   * The pin is resolved here rather than accepted from the caller: a page that
   * sent a version id would pin whatever it had loaded, so an edit made while
   * the tab was open would run under the old definition without anyone saying
   * so. Asking for the workflow and pinning what it is right now is the rule
   * SPEC.md feature 2 states.
   */
  fastify.post<{ Body: unknown }>('/api/orders', async (request, reply) => {
    const parsed = readSubmitBody(request.body);
    if (typeof parsed === 'string') {
      return reply.code(400).send({ error: 'bad-request', message: parsed });
    }
    return asTenant(request, reply, async (sql, tenantId) => {
      try {
        const { version } = await getWorkflow(sql, parsed.workflowId);
        const enqueued = await enqueueOrder(sql, tenantId, parsed.items, {
          workflowVersionId: version.id,
        });
        return reply.code(201).send({
          orderId: enqueued.orderId,
          itemCount: enqueued.jobIds.length,
          workflowVersionId: version.id,
          version: version.version,
        });
      } catch (error) {
        return sendSubmitFailure(error, reply);
      }
    });
  });

  fastify.get<{ Params: { orderId: string } }>('/api/orders/:orderId', async (request, reply) =>
    asTenant(request, reply, async (sql) => {
      const { orderId } = request.params;
      const detail = UUID_RE.test(orderId) ? await getOrderDetail(sql, orderId) : null;
      // A malformed id, another tenant's order and one that never existed are
      // the same answer, for the same reason the 401 does not distinguish.
      if (!detail) return reply.code(404).send({ error: 'no-such-order' });
      return detail;
    }),
  );

  /**
   * The validated results of one order as a download.
   *
   * Only items that produced a schema-valid object are included, and the file
   * says how many were left out — a results export that silently dropped the
   * failures would be a file whose row count lies about the order.
   */
  fastify.get<{ Params: { orderId: string } }>(
    '/api/orders/:orderId/results.json',
    async (request, reply) =>
      asTenant(request, reply, async (sql) => {
        const { orderId } = request.params;
        const detail = UUID_RE.test(orderId) ? await getOrderDetail(sql, orderId) : null;
        if (!detail) return reply.code(404).send({ error: 'no-such-order' });
        const validated = detail.items.filter((item) => item.ok === true);
        return reply
          .header(
            'content-disposition',
            `attachment; filename="workmill-order-${detail.order.orderId}.json"`,
          )
          .send({
            orderId: detail.order.orderId,
            workflow: detail.order.workflowSlug,
            version: detail.order.version,
            model: detail.order.model,
            itemCount: detail.order.itemCount,
            validatedCount: validated.length,
            results: validated.map((item) => ({ idx: item.idx, output: item.output })),
          });
      }),
  );

  /** Cancel: pending items flip, running items are asked. */
  fastify.post<{ Params: { orderId: string } }>(
    '/api/orders/:orderId/cancel',
    async (request, reply) =>
      asTenant(request, reply, async (sql) => {
        const { orderId } = request.params;
        if (!UUID_RE.test(orderId)) return reply.code(404).send({ error: 'no-such-order' });
        const result = await cancelOrder(sql, orderId);
        return reply.code(200).send(result);
      }),
  );

  fastify.get<{ Querystring: { limit?: string } }>('/api/dead', async (request, reply) =>
    asTenant(request, reply, async (sql) => ({
      jobs: await listDeadLetter(sql, clampPageSize(request.query.limit)),
    })),
  );

  /** Requeue one dead item. False when it is not dead — nothing was moved. */
  fastify.post<{ Params: { jobId: string } }>('/api/jobs/:jobId/requeue', async (request, reply) =>
    asTenant(request, reply, async (sql) => {
      const { jobId } = request.params;
      const requeued = UUID_RE.test(jobId) ? await requeueJob(sql, jobId) : false;
      if (!requeued) return reply.code(404).send({ error: 'not-requeued' });
      return reply.code(200).send({ requeued: true, jobId });
    }),
  );

  /** The usage meter: today against the budget, plus the recent daily totals. */
  fastify.get('/api/usage', async (request, reply) =>
    asTenant(request, reply, async (sql) => ({
      budget: await budgetStatus(sql),
      byDay: await usageByDay(sql, USAGE_DAYS),
    })),
  );
}
