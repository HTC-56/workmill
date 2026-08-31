import type { Session } from '../db/engine.js';

/**
 * The audit trail (SPEC.md feature 7): "append-only audit trail **the tenant
 * itself can read** (RLS-scoped)".
 *
 * The emphasis is the spec's own, and it is the whole design. An operator log
 * that only the operator can read is a claim about what happened; a row the
 * tenant can fetch with its own bearer is a receipt. So `audit_log` is ordinary
 * tenant data under ordinary policies, every function here takes a `Session`
 * from `withTenant()`, and the tenant API serves the same rows the operator
 * console does.
 *
 * WHAT MAY GO IN `detail`: ids, counts, limits, states — the shape of a change.
 * Never item text, never a token, never an email body. This table is quoted
 * back in support conversations and read by the tenant, so it is the one place
 * in the repo where "what would be embarrassing to show the customer" is a
 * design constraint rather than a joke.
 *
 * Append-only is enforced by construction: nothing here updates or deletes, and
 * no route reaches a verb that could. sql/008 records why it is not enforced by
 * a grant.
 */

/** The vocabulary the console writes. A new action is a code change, not a migration. */
export const AUDIT_ACTIONS = {
  tenantProvisioned: 'tenant.provisioned',
  tenantStateChanged: 'tenant.state-changed',
  entitlementsUpdated: 'entitlements.updated',
  supportGranted: 'support.granted',
  supportRevoked: 'support.revoked',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/** One entry, as both the console and the tenant read it. */
export interface AuditEntry {
  id: string;
  at: Date;
  actor: string;
  action: string;
  detail: Record<string, unknown>;
  grantId: string | null;
}

/** How many entries a panel asks for when the request does not say. */
export const DEFAULT_AUDIT_LIMIT = 50;

/** The most any one read returns, whatever was asked for. */
export const MAX_AUDIT_LIMIT = 500;

export interface AuditRequest {
  /** Who did it, self-declared: 'operator' for a console action. 1..80 chars. */
  actor: string;
  action: AuditAction | string;
  /** Ids, counts and states only — see the note above. Defaults to `{}`. */
  detail?: Record<string, unknown>;
  grantId?: string | null;
}

/** jsonb arrives parsed from both drivers today; a string is still valid JSON. */
function parseDetail(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return value as Record<string, unknown>;
}

/**
 * Append one entry for the current tenant. Returns its id.
 *
 * The tenant is not a parameter — it is `app_tenant_id()`, read from the GUC
 * `withTenant()` pinned. The row therefore lands in the tenant the seam opened
 * and nowhere else, and the policy's WITH CHECK half agrees with it by
 * construction rather than by the caller passing the same id twice.
 *
 * Every parameter that lands inside a jsonb cast is cast explicitly — an
 * untyped `$n` there is `unknown` to the planner and the statement is refused
 * (DECISIONS.md, recorded during Phase E).
 */
export async function recordAudit(sql: Session, request: AuditRequest): Promise<string> {
  const actor = request.actor.trim();
  if (actor.length < 1 || actor.length > 80) {
    throw new RangeError(`audit actor must be 1..80 characters, got ${actor.length}`);
  }
  const action = request.action.trim();
  if (action.length < 3 || action.length > 60) {
    throw new RangeError(`audit action must be 3..60 characters, got ${action.length}`);
  }
  const [row] = await sql.query<{ id: string }>(
    `INSERT INTO audit_log (tenant_id, actor, action, detail, grant_id)
     VALUES (app_tenant_id(), $1, $2, $3::jsonb, $4::uuid) RETURNING id`,
    // detail passes raw, not JSON.stringify: postgres.js encodes a
    // pre-stringified value as a jsonb *string* on real Postgres.
    [actor, action, request.detail ?? {}, request.grantId ?? null],
  );
  if (!row) throw new Error('audit insert returned no row');
  return row.id;
}

/** Clamp a caller-supplied row count the way the dashboard's panels do. */
export function clampAuditLimit(value: unknown, fallback = DEFAULT_AUDIT_LIMIT): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), MAX_AUDIT_LIMIT);
}

/** The current tenant's trail, newest first. */
export async function listAudit(
  sql: Session,
  limit: number = DEFAULT_AUDIT_LIMIT,
): Promise<AuditEntry[]> {
  const rows = await sql.query<{
    id: string;
    at: Date;
    actor: string;
    action: string;
    detail: unknown;
    grant_id: string | null;
  }>(
    `SELECT id, at, actor, action, detail, grant_id
       FROM audit_log ORDER BY at DESC, id DESC LIMIT $1`,
    [clampAuditLimit(limit)],
  );
  return rows.map((row) => ({
    id: row.id,
    at: new Date(row.at),
    actor: row.actor,
    action: row.action,
    detail: parseDetail(row.detail),
    grantId: row.grant_id,
  }));
}
