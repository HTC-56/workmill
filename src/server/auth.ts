import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Engine, Session } from '../db/engine.js';
import { withAdmin } from '../seam/withTenant.js';

/**
 * The auth seam (SPEC.md feature 8 and the non-goal that fences it).
 *
 * v1 refuses SSO, OAuth and password reset outright; what remains is an opaque
 * bearer token, minted by a helper and by test fixtures. There are exactly two
 * kinds, and they do not overlap:
 *
 *   * a TENANT token — a row in `api_tokens`, resolving to one tenant (and
 *     optionally one user). This is what the dashboard and the tenant API use.
 *   * the OPERATOR token — one static string from config, guarding the operator
 *     API. It belongs to no tenant on purpose: an operator route that could be
 *     reached with a tenant's own token would be a privilege escalation.
 *
 * Tokens are stored as sha256 hex and never in the clear, exactly as
 * `invites.token_hash` is (sql/003). The raw string exists only in the return
 * value of `mintApiToken`; there is no read path that can produce it again.
 */

/** Distinguishes a workmill token at a glance in a log or a shell history. */
export const TOKEN_PREFIX = 'wm_';

/** The environment variable the operator bearer is read from. */
export const OPERATOR_TOKEN_ENV = 'WORKMILL_OPERATOR_TOKEN';

/** The stored form of a token: sha256 hex, matching the CHECK in sql/007. */
export function hashApiToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** A fresh opaque token: 32 random bytes, url-safe, prefixed. */
export function generateApiToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/**
 * Pull the credential out of an `Authorization` header.
 *
 * Returns null for anything that is not exactly one `Bearer <token>` — a
 * missing header, another scheme, or an empty credential. The scheme match is
 * case-insensitive because RFC 7235 says it is; the token itself is not.
 */
export function parseBearer(header: string | undefined): string | null {
  if (typeof header !== 'string') return null;
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * Constant-time string comparison for secrets.
 *
 * `timingSafeEqual` throws when the buffers differ in length, which would leak
 * the length of the expected token through an exception. Both sides are hashed
 * to a fixed 32 bytes first, so the comparison is always the same shape.
 */
export function secretsMatch(a: string, b: string): boolean {
  const left = createHash('sha256').update(a, 'utf8').digest();
  const right = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(left, right);
}

export interface MintRequest {
  /** What a human calls it: "laptop", "ci", "demo seed". 1..80 characters. */
  name: string;
  /** Optional: the user this token acts as. Must belong to the same tenant. */
  userId?: string;
  /** Optional lifetime in milliseconds; omitted means the token never expires. */
  ttlMs?: number;
}

export interface MintedToken {
  tokenId: string;
  /** Returned once, at mint time. Only its hash is stored. */
  token: string;
  expiresAt: Date | null;
}

/**
 * Mint a token for the current tenant.
 *
 * Takes a `Session` from `withTenant()`, like every other tenant-data function
 * in this repo, so the policy's WITH CHECK half decides which tenant the row can
 * belong to — the caller cannot mint a token into someone else's tenant even by
 * passing the wrong id, because it never passes an id at all.
 *
 * Expiry is computed by the database rather than by this process, so the clock
 * that stamps the row is the clock that later judges it.
 */
export async function mintApiToken(
  sql: Session,
  tenantId: string,
  request: MintRequest,
): Promise<MintedToken> {
  const name = request.name.trim();
  if (name.length < 1 || name.length > 80) {
    throw new RangeError(`token name must be 1..80 characters, got ${name.length}`);
  }
  if (request.ttlMs !== undefined && (!Number.isInteger(request.ttlMs) || request.ttlMs < 1)) {
    throw new RangeError(`token ttl must be a positive whole number of ms, got ${request.ttlMs}`);
  }

  const token = generateApiToken();
  const [row] = await sql.query<{ id: string; expires_at: Date | null }>(
    `INSERT INTO api_tokens (tenant_id, user_id, name, token_hash, expires_at)
     VALUES ($1, $2, $3, $4,
             CASE WHEN $5::bigint IS NULL THEN NULL
                  ELSE now() + make_interval(secs => $5::bigint / 1000.0) END)
     RETURNING id, expires_at`,
    [tenantId, request.userId ?? null, name, hashApiToken(token), request.ttlMs ?? null],
  );
  if (!row) throw new Error('api token insert returned no row');

  return {
    tokenId: row.id,
    token,
    expiresAt: row.expires_at === null ? null : new Date(row.expires_at),
  };
}

/** Who a valid bearer turned out to be. Ids only — never the token. */
export interface TokenIdentity {
  tenantId: string;
  userId: string | null;
  tokenId: string;
}

/**
 * Resolve a raw bearer to its tenant, or null if it is not a live token.
 *
 * This is the one withAdmin() call on a tenant-reachable path in the whole repo,
 * and it is unavoidable: the lookup key is a digest, the answer is which tenant
 * to pin, and no tenant is pinned yet. It is kept as narrow as an admin query
 * can be — one probe of a unique index, returning three ids and nothing else.
 * Every caller pins the tenant it returns and does the actual work under
 * withTenant().
 *
 * Revoked and expired tokens resolve to null, not to an error: a request with a
 * dead token and a request with a made-up token must be indistinguishable from
 * outside, or the 401 becomes an oracle for which tokens once existed.
 *
 * `last_used_at` is stamped in the same statement, so the read that authorises a
 * request is also the write that records it — there is no window where a token
 * was accepted but not marked used.
 */
export async function resolveApiToken(
  engine: Engine,
  rawToken: string,
): Promise<TokenIdentity | null> {
  if (rawToken.length === 0) return null;
  const rows = await withAdmin(engine, (sql) =>
    sql.query<{ id: string; tenant_id: string; user_id: string | null }>(
      `UPDATE api_tokens
          SET last_used_at = now()
        WHERE token_hash = $1
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > now())
        RETURNING id, tenant_id, user_id`,
      [hashApiToken(rawToken)],
    ),
  );
  const row = rows[0];
  if (!row) return null;
  return { tenantId: row.tenant_id, userId: row.user_id, tokenId: row.id };
}

/** Revoke one of the current tenant's tokens. False if it was not theirs. */
export async function revokeApiToken(sql: Session, tokenId: string): Promise<boolean> {
  const rows = await sql.query<{ id: string }>(
    `UPDATE api_tokens SET revoked_at = now()
      WHERE id = $1 AND revoked_at IS NULL
      RETURNING id`,
    [tokenId],
  );
  return rows.length > 0;
}

/** One of the current tenant's tokens, as the console lists them. */
export interface ApiTokenSummary {
  id: string;
  name: string;
  userId: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

/** The current tenant's tokens, newest first. Never includes a token value. */
export async function listApiTokens(sql: Session): Promise<ApiTokenSummary[]> {
  const rows = await sql.query<{
    id: string;
    name: string;
    user_id: string | null;
    created_at: Date;
    expires_at: Date | null;
    last_used_at: Date | null;
    revoked_at: Date | null;
  }>(
    `SELECT id, name, user_id, created_at, expires_at, last_used_at, revoked_at
       FROM api_tokens ORDER BY created_at DESC, id`,
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    userId: row.user_id,
    createdAt: new Date(row.created_at),
    expiresAt: row.expires_at === null ? null : new Date(row.expires_at),
    lastUsedAt: row.last_used_at === null ? null : new Date(row.last_used_at),
    revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at),
  }));
}

/**
 * The operator bearer, read from the environment.
 *
 * Absent or blank means the operator API is DISABLED — every operator route
 * refuses. That is the safe default for a box that has not been configured:
 * a missing secret must never mean "no check", which is how static-token guards
 * usually fail open. A configured token must be long enough to be worth having.
 */
export const MIN_OPERATOR_TOKEN_LENGTH = 16;

export function loadOperatorToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[OPERATOR_TOKEN_ENV]?.trim();
  if (!raw) return null;
  if (raw.length < MIN_OPERATOR_TOKEN_LENGTH) {
    throw new Error(
      `${OPERATOR_TOKEN_ENV} must be at least ${MIN_OPERATOR_TOKEN_LENGTH} characters`,
    );
  }
  return raw;
}

/**
 * Does this `Authorization` header carry the operator bearer?
 *
 * False whenever the operator token is not configured, regardless of what was
 * sent — see `loadOperatorToken`.
 */
export function isOperator(header: string | undefined, operatorToken: string | null): boolean {
  if (!operatorToken) return false;
  const presented = parseBearer(header);
  if (presented === null) return false;
  return secretsMatch(presented, operatorToken);
}
