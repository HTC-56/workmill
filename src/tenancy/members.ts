import { createHash, randomBytes } from 'node:crypto';
import type { Engine, Session } from '../db/engine.js';
import { withAdmin } from '../seam/withTenant.js';

/**
 * Invites and memberships — how a person gets a seat in a tenant, and how they
 * lose it.
 *
 * Two of these functions take a `Session` and one takes an `Engine`, and the
 * split is the whole security story of this file:
 *
 *   * `inviteMember` and `revokeMembership` are things a tenant does to itself.
 *     They take a Session, so they run inside withTenant() and RLS scopes them.
 *   * `acceptInvite` takes an Engine because it runs BEFORE anyone knows which
 *     tenant is involved — the token is the only thing the caller has. It looks
 *     the invite up as admin, and the token's hash is the whole authorisation.
 *     That is why the raw token is 32 random bytes and never stored.
 */

/** The three membership roles, matching the CHECK constraint in sql/003. */
export const ROLES = ['owner', 'admin', 'member'] as const;
export type Role = (typeof ROLES)[number];

/** How long a fresh invite stands. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class InviteNotFoundError extends Error {
  constructor() {
    // Deliberately says nothing about which part was wrong: a probe must not be
    // able to tell "no such invite" from "that one is spent".
    super('no usable invite for that token');
    this.name = 'InviteNotFoundError';
  }
}

export class InviteExpiredError extends Error {
  constructor() {
    super('that invite has expired');
    this.name = 'InviteExpiredError';
  }
}

/** The stored form of a token: sha256 hex, matching the CHECK in sql/003. */
export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface CreatedInvite {
  inviteId: string;
  /** Shown to the inviter once. Only its hash is stored. */
  token: string;
  expiresAt: Date;
}

export interface InviteRequest {
  email: string;
  role: Role;
  ttlMs?: number;
}

export async function inviteMember(
  sql: Session,
  tenantId: string,
  request: InviteRequest,
): Promise<CreatedInvite> {
  const ttlMs = request.ttlMs ?? INVITE_TTL_MS;
  if (!Number.isInteger(ttlMs) || ttlMs < 1) {
    throw new RangeError(`invite ttl must be a positive whole number of ms, got ${ttlMs}`);
  }
  if (!ROLES.includes(request.role)) {
    throw new RangeError(`role must be one of ${ROLES.join(', ')}, got ${String(request.role)}`);
  }

  const token = randomBytes(32).toString('base64url');
  // Expiry is computed by the database, not by this process: the row's clock
  // and the clock that later reads it are then the same clock.
  const [row] = await sql.query<{ id: string; expires_at: Date }>(
    `INSERT INTO invites (tenant_id, email, role, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5::double precision / 1000))
     RETURNING id, expires_at`,
    [tenantId, request.email.trim(), request.role, hashInviteToken(token), ttlMs],
  );
  if (!row) throw new Error('invite insert returned no row');

  return { inviteId: row.id, token, expiresAt: new Date(row.expires_at) };
}

export interface AcceptedInvite {
  tenantId: string;
  userId: string;
  membershipId: string;
  role: Role;
}

/**
 * Redeem a token: find the invite, create-or-find the user, grant the seat, and
 * spend the invite — all in one admin transaction, so a token can never be half
 * redeemed. `displayName` is what the person calls themselves; it is only used
 * when their user row does not exist yet.
 */
export async function acceptInvite(
  engine: Engine,
  token: string,
  displayName?: string,
): Promise<AcceptedInvite> {
  const tokenHash = hashInviteToken(token);

  return withAdmin(engine, async (sql) => {
    const [invite] = await sql.query<{
      id: string;
      tenant_id: string;
      email: string;
      role: Role;
      expired: boolean;
    }>(
      `SELECT id, tenant_id, email, role, (expires_at <= now()) AS expired
         FROM invites
        WHERE token_hash = $1 AND state = 'pending'`,
      [tokenHash],
    );
    if (!invite) throw new InviteNotFoundError();
    if (invite.expired) throw new InviteExpiredError();

    // Create-or-find against the case-insensitive index. The no-op SET is how a
    // conflicting row is returned rather than skipped: DO NOTHING returns none.
    const [user] = await sql.query<{ id: string }>(
      `INSERT INTO users (tenant_id, email, display_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, lower(email)) DO UPDATE SET email = users.email
       RETURNING id`,
      [invite.tenant_id, invite.email, displayName ?? invite.email.split('@')[0]],
    );
    if (!user) throw new Error('user upsert returned no row');

    // Re-accepting into a seat someone already holds moves the role rather than
    // failing: the invite is the newer statement of intent.
    const [membership] = await sql.query<{ id: string }>(
      `INSERT INTO memberships (tenant_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role
       RETURNING id`,
      [invite.tenant_id, user.id, invite.role],
    );
    if (!membership) throw new Error('membership upsert returned no row');

    await sql.query(
      `UPDATE invites
          SET state = 'accepted', accepted_at = now(), accepted_user_id = $2
        WHERE id = $1`,
      [invite.id, user.id],
    );

    return {
      tenantId: invite.tenant_id,
      userId: user.id,
      membershipId: membership.id,
      role: invite.role,
    };
  });
}

/**
 * Withdraw an invite that has not been redeemed. Returns false when there was
 * nothing pending to withdraw — including when the invite belongs to another
 * tenant, which RLS makes indistinguishable from absent. That is the point.
 */
export async function revokeInvite(sql: Session, inviteId: string): Promise<boolean> {
  const rows = await sql.query<{ id: string }>(
    `UPDATE invites SET state = 'revoked' WHERE id = $1 AND state = 'pending' RETURNING id`,
    [inviteId],
  );
  return rows.length === 1;
}

/**
 * Take away a seat. The user row survives on purpose: rows that reference the
 * person who did the work must not be orphaned by a revocation.
 */
export async function revokeMembership(sql: Session, userId: string): Promise<boolean> {
  const rows = await sql.query<{ id: string }>(
    'DELETE FROM memberships WHERE user_id = $1 RETURNING id',
    [userId],
  );
  return rows.length === 1;
}
