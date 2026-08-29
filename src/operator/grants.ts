import type { Session } from '../db/engine.js';

/**
 * Support-access grants (SPEC.md feature 7): "support-access grants with
 * required reason + TTL countdown".
 *
 * A grant is a row, not a flag, because the spec asks for two things a boolean
 * cannot carry: a reason someone typed, and an end. sql/008 makes both
 * structural — the reason has a length floor and `expires_at` is NOT NULL and
 * must be later than `created_at` — so a grant with no justification or no end
 * cannot be written even by a caller that skipped this module.
 *
 * WHAT A GRANT DOES NOT DO, stated plainly so nobody assumes otherwise: it does
 * not change what any query can reach. There is no "support may now read tenant
 * data" switch in v1 — operator routes already run with the operator bearer,
 * and tenant data is reached by pinning a tenant id. What a grant provides is
 * the RECORD: a reason, a window, and an entry in a trail the tenant reads.
 * Making a grant a precondition of operator reads is real work with a real
 * design (which reads? for how long? what happens mid-request?), and inventing
 * that here would be scope this phase has no mandate for. It is a reservation.
 *
 * `isGrantActive` and `grantRemainingMs` are pure, so the console's countdown
 * and the API's "is one live" agree by construction and both are testable
 * without a database.
 */

/** A grant nobody sized: one hour. */
export const DEFAULT_GRANT_TTL_MS = 60 * 60 * 1000;

/** The longest window a single grant may open. A day is already generous. */
export const MAX_GRANT_TTL_MS = 24 * 60 * 60 * 1000;

/** The shortest one worth writing down. */
export const MIN_GRANT_TTL_MS = 60 * 1000;

/** Matches the CHECK in sql/008: "because" is not a reason. */
export const MIN_REASON_CHARS = 8;
export const MAX_REASON_CHARS = 500;

/** Why a grant was refused. The reason is what tests and the API match on. */
export type GrantRefusalReason = 'reason-too-short' | 'reason-too-long' | 'ttl-out-of-range';

/** A grant request the rules do not permit. Thrown before any write. */
export class GrantRefusedError extends Error {
  constructor(
    public readonly reason: GrantRefusalReason,
    message: string,
  ) {
    super(message);
    this.name = 'GrantRefusedError';
  }
}

export interface SupportGrant {
  id: string;
  reason: string;
  grantedBy: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface GrantRequest {
  /** Required, at least MIN_REASON_CHARS after trimming. */
  reason: string;
  /** The operator's self-declared label. 1..80 characters. */
  grantedBy: string;
  /** Defaults to DEFAULT_GRANT_TTL_MS; clamped nowhere, refused when out of range. */
  ttlMs?: number;
}

/**
 * Is this grant live right now?
 *
 * Pure, and deliberately so: the console counts down against the same predicate
 * the API answers with, so a grant cannot look live in one place and dead in
 * the other. A revoked grant is dead however much time was left.
 */
export function isGrantActive(grant: SupportGrant, now: number = Date.now()): boolean {
  if (grant.revokedAt !== null) return false;
  return grant.expiresAt.getTime() > now;
}

/** Milliseconds left on a grant; zero once it is revoked or expired. */
export function grantRemainingMs(grant: SupportGrant, now: number = Date.now()): number {
  if (!isGrantActive(grant, now)) return 0;
  return grant.expiresAt.getTime() - now;
}

function toGrant(row: {
  id: string;
  reason: string;
  granted_by: string;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}): SupportGrant {
  return {
    id: row.id,
    reason: row.reason,
    grantedBy: row.granted_by,
    createdAt: new Date(row.created_at),
    expiresAt: new Date(row.expires_at),
    revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at),
  };
}

const GRANT_COLUMNS = 'id, reason, granted_by, created_at, expires_at, revoked_at';

/**
 * Open a support window on the current tenant.
 *
 * The expiry is computed by the database rather than by this process, the way
 * `mintApiToken` computes a token's, so the clock that stamps the row is the
 * clock that later judges it. A caller and a server that disagree about the
 * time would otherwise disagree about whether a grant is live.
 */
export async function grantSupportAccess(
  sql: Session,
  request: GrantRequest,
): Promise<SupportGrant> {
  const reason = request.reason.trim();
  if (reason.length < MIN_REASON_CHARS) {
    throw new GrantRefusedError(
      'reason-too-short',
      `a support grant needs a reason of at least ${MIN_REASON_CHARS} characters`,
    );
  }
  if (reason.length > MAX_REASON_CHARS) {
    throw new GrantRefusedError(
      'reason-too-long',
      `a support grant reason may be at most ${MAX_REASON_CHARS} characters`,
    );
  }
  const grantedBy = request.grantedBy.trim();
  if (grantedBy.length < 1 || grantedBy.length > 80) {
    throw new RangeError(`granted_by must be 1..80 characters, got ${grantedBy.length}`);
  }
  const ttlMs = request.ttlMs ?? DEFAULT_GRANT_TTL_MS;
  if (!Number.isInteger(ttlMs) || ttlMs < MIN_GRANT_TTL_MS || ttlMs > MAX_GRANT_TTL_MS) {
    throw new GrantRefusedError(
      'ttl-out-of-range',
      `support grant ttlMs must be ${MIN_GRANT_TTL_MS}..${MAX_GRANT_TTL_MS}, got ${ttlMs}`,
    );
  }

  // The tenant is `app_tenant_id()`, read from the GUC `withTenant()` pinned,
  // never a parameter: the row lands in the tenant the seam opened and the
  // policy's WITH CHECK half agrees with it by construction.
  const [row] = await sql.query<Parameters<typeof toGrant>[0]>(
    `INSERT INTO support_grants (tenant_id, reason, granted_by, expires_at)
     VALUES (app_tenant_id(), $1, $2, now() + make_interval(secs => $3::bigint / 1000.0))
     RETURNING ${GRANT_COLUMNS}`,
    [reason, grantedBy, ttlMs],
  );
  if (!row) throw new Error('support grant insert returned no row');
  return toGrant(row);
}

/** The current tenant's grants, newest expiry first. */
export async function listSupportGrants(sql: Session, limit = 50): Promise<SupportGrant[]> {
  const rows = await sql.query<Parameters<typeof toGrant>[0]>(
    `SELECT ${GRANT_COLUMNS} FROM support_grants
      ORDER BY expires_at DESC, id LIMIT $1`,
    [Math.max(1, Math.min(Math.floor(limit), 500))],
  );
  return rows.map(toGrant);
}

/**
 * The live grant, if there is one — the console's countdown reads this.
 *
 * `now()` is the database's, matching how the row was stamped. Two grants can
 * overlap; the one that ends latest is the one that matters.
 */
export async function activeSupportGrant(sql: Session): Promise<SupportGrant | null> {
  const [row] = await sql.query<Parameters<typeof toGrant>[0]>(
    `SELECT ${GRANT_COLUMNS} FROM support_grants
      WHERE revoked_at IS NULL AND expires_at > now()
      ORDER BY expires_at DESC LIMIT 1`,
  );
  return row ? toGrant(row) : null;
}

/**
 * Close a window early. False when the grant is not this tenant's, does not
 * exist, or was already revoked — the three are one answer, because under RLS
 * the first two are indistinguishable and the third changed nothing.
 *
 * An expired-but-unrevoked grant CAN still be revoked, and that is deliberate:
 * revoking is a statement about intent, and the trail is better for recording
 * that someone closed a window even a moment after it shut on its own.
 */
export async function revokeSupportGrant(sql: Session, grantId: string): Promise<boolean> {
  const rows = await sql.query<{ id: string }>(
    `UPDATE support_grants SET revoked_at = now()
      WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
    [grantId],
  );
  return rows.length > 0;
}
