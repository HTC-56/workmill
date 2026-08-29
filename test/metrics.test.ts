import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Engine } from '../src/db/engine.js';
import { enqueueOrder } from '../src/queue/enqueue.js';
import {
  JOB_STATES,
  ORDER_STATES,
  renderMetrics,
  escapeLabelValue,
  collectMetrics,
  type MetricsSnapshot,
} from '../src/ops/metrics.js';
import { withAdmin, withTenant } from '../src/seam/withTenant.js';
import { freshDb, makeTenant } from './helpers/db.js';

/**
 * The metrics surface: renderMetrics, escapeLabelValue, and collectMetrics.
 * §G7 of TASK_PHASE_G.md.
 *
 * renderMetrics is pure — no database needed. collectMetrics queries a
 * migrated database cross-tenant as admin.
 */

let db: Engine;

beforeAll(async () => {
  db = await freshDb();
});

afterAll(async () => {
  await db?.close();
});

// ---------------------------------------------------------------------------
// 1. renderMetrics emits # HELP, # TYPE, samples for every metric, ends with newline
// ---------------------------------------------------------------------------

describe('renderMetrics — structure', () => {
  it('emits # HELP and # TYPE before every metric body', () => {
    const snap = {
      uptimeSeconds: 42,
      tenants: 3,
      jobsByState: Object.fromEntries(JOB_STATES.map((s) => [s, 0])),
      ordersByState: Object.fromEntries(ORDER_STATES.map((s) => [s, 0])),
      ordersBlocked: 0,
      jobsCompletedLastHour: 12,
      tokensToday: 5000,
      eventSubscribers: 2,
    };

    const body = renderMetrics(snap);

    // Every metric name should have HELP and TYPE.
    const metricNames = [
      'workmill_up',
      'workmill_uptime_seconds',
      'workmill_tenants',
      'workmill_jobs',
      'workmill_work_orders',
      'workmill_work_orders_blocked',
      'workmill_jobs_completed_last_hour',
      'workmill_tokens_today',
      'workmill_event_subscribers',
    ];
    for (const name of metricNames) {
      const helpIndex = body.indexOf(`# HELP ${name}`);
      const typeIndex = body.indexOf(`# TYPE ${name}`);
      expect(helpIndex).toBeGreaterThan(-1);
      expect(typeIndex).toBeGreaterThan(-1);
      // HELP comes before TYPE.
      expect(helpIndex).toBeLessThan(typeIndex);
    }

    // Body ends with a newline.
    expect(body.endsWith('\n')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Zero series are still printed — every JOB_STATES state appears
// ---------------------------------------------------------------------------

describe('renderMetrics — zero series', () => {
  it('every state in JOB_STATES appears as a workmill_jobs sample even when count is 0', () => {
    const snap = {
      uptimeSeconds: 0,
      tenants: 0,
      jobsByState: Object.fromEntries(JOB_STATES.map((s) => [s, 0])),
      ordersByState: Object.fromEntries(ORDER_STATES.map((s) => [s, 0])),
      ordersBlocked: 0,
      jobsCompletedLastHour: 0,
      tokensToday: 0,
      eventSubscribers: 0,
    };

    const body = renderMetrics(snap);

    for (const state of JOB_STATES) {
      expect(body).toContain(`state="${state}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. workmill_up is always 1; non-finite counts render as 0
// ---------------------------------------------------------------------------

describe('renderMetrics — up and non-finite', () => {
  it('workmill_up is always 1', () => {
    const snap = {
      uptimeSeconds: 0,
      tenants: 0,
      jobsByState: Object.fromEntries(JOB_STATES.map((s) => [s, 0])),
      ordersByState: Object.fromEntries(ORDER_STATES.map((s) => [s, 0])),
      ordersBlocked: 0,
      jobsCompletedLastHour: 0,
      tokensToday: 0,
      eventSubscribers: 0,
    };

    const body = renderMetrics(snap);
    expect(body).toContain('workmill_up 1');
  });

  it('non-finite count renders as 0', () => {
    const snap = {
      uptimeSeconds: NaN,
      tenants: Infinity,
      jobsByState: Object.fromEntries(JOB_STATES.map((s) => [s, NaN])),
      ordersByState: Object.fromEntries(ORDER_STATES.map((s) => [s, Infinity])),
      ordersBlocked: -Infinity,
      jobsCompletedLastHour: NaN,
      tokensToday: NaN,
      eventSubscribers: Infinity,
    } as MetricsSnapshot;

    const body = renderMetrics(snap);
    // No NaN or Inf should appear in the rendered text.
    expect(body).not.toContain('NaN');
    expect(body).not.toContain('Infinity');
    expect(body).not.toContain('inf');
    expect(body).not.toContain('inf');
  });
});

// ---------------------------------------------------------------------------
// 4. No metric carries a tenant label
// ---------------------------------------------------------------------------

describe('renderMetrics — no tenant labels', () => {
  it('rendered body contains neither tenant_id= nor any UUID', () => {
    const fakeTenantId = '12345678-1234-1234-1234-123456789abc';
    const snap = {
      uptimeSeconds: 0,
      tenants: 1,
      jobsByState: Object.fromEntries(JOB_STATES.map((s) => [s, 0])),
      ordersByState: Object.fromEntries(ORDER_STATES.map((s) => [s, 0])),
      ordersBlocked: 0,
      jobsCompletedLastHour: 0,
      tokensToday: 0,
      eventSubscribers: 0,
    };

    const body = renderMetrics(snap);
    expect(body).not.toContain('tenant_id=');
    expect(body).not.toContain(fakeTenantId);
  });
});

// ---------------------------------------------------------------------------
// 5. escapeLabelValue — backslash, double quote, newline
// ---------------------------------------------------------------------------

describe('escapeLabelValue', () => {
  it('escapes backslash, double quote, and newline', () => {
    expect(escapeLabelValue('a\\b')).toBe('a\\\\b');
    expect(escapeLabelValue('a"b')).toBe('a\\"b');
    expect(escapeLabelValue('a\nb')).toBe('a\\nb');
  });

  it('escapes all three together', () => {
    // backslash + double-quote + newline
    const input = '\\"\n';
    expect(escapeLabelValue(input)).toBe('\\\\\\"\\n');
  });
});

// ---------------------------------------------------------------------------
// 6. collectMetrics against a migrated database with two tenants and one
//    enqueued order
// ---------------------------------------------------------------------------

describe('collectMetrics — against a migrated database', () => {
  it('reports tenants: 2 and correct pending jobs for one enqueued order', async () => {
    const [tenantA] = await Promise.all([
      makeTenant(db, 'metrics-a'),
      makeTenant(db, 'metrics-b'),
    ]);

    // Create a workflow and version for tenant A so enqueueOrder works.
    const versionId = await withAdmin(db, async (sql) => {
      const [workflow] = await sql.query<{ id: string }>(
        "INSERT INTO workflows (tenant_id, slug, name) VALUES ($1, 'metrics-fixture', 'Metrics fixture') RETURNING id",
        [tenantA.id],
      );
      const [version] = await sql.query<{ id: string }>(
        `INSERT INTO workflow_versions
           (tenant_id, workflow_id, version, prompt_template, output_schema, model)
         VALUES ($1, $2, 1, '{{input}}', '{"type":"object"}'::jsonb, 'default')
         RETURNING id`,
        [tenantA.id, workflow!.id],
      );
      return version!.id;
    });

    // Enqueue one order (two jobs) for tenant A.
    await withTenant(db, tenantA.id, (sql) =>
      enqueueOrder(
        sql,
        tenantA.id,
        ['item one', 'item two'],
        { workflowVersionId: versionId },
      ),
    );

    const snapshot = await collectMetrics(db, {
      uptimeSeconds: 123,
      eventSubscribers: 3,
    });

    expect(snapshot.tenants).toBe(2);
    expect(snapshot.uptimeSeconds).toBe(123);
    expect(snapshot.eventSubscribers).toBe(3);

    // Both jobs should be pending.
    expect(snapshot.jobsByState.pending).toBe(2);
    // Other states are zero.
    for (const state of JOB_STATES) {
      if (state !== 'pending') {
        expect(snapshot.jobsByState[state]).toBe(0);
      }
    }

    // One open order.
    expect(snapshot.ordersByState.open).toBe(1);
    for (const state of ORDER_STATES) {
      if (state !== 'open') {
        expect(snapshot.ordersByState[state]).toBe(0);
      }
    }

    expect(snapshot.ordersBlocked).toBe(0);
    expect(snapshot.jobsCompletedLastHour).toBe(0);
    expect(snapshot.tokensToday).toBe(0);
  });
});
