import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Engine } from '../src/db/engine.js';
import { withAdmin, withTenant } from '../src/seam/withTenant.js';
import { freshDb, makeTenant } from './helpers/db.js';
import {
  mintApiToken,
  resolveApiToken,
  revokeApiToken,
  listApiTokens,
  hashApiToken,
  parseBearer,
  TOKEN_PREFIX,
} from '../src/server/auth.js';

/**
 * Proves `mintApiToken`, `resolveApiToken`, `revokeApiToken`,
 * `listApiTokens`, `hashApiToken`, and `parseBearer` in
 * `src/server/auth.ts`.
 *
 * Patterned after test/members.test.ts — same beforeAll/afterAll shape,
 * per-test tenant provisioning for isolation, withAdmin for cross-RLS
 * assertions.
 */

let db: Engine;

beforeAll(async () => {
  db = await freshDb();
});

afterAll(async () => {
  await db?.close();
});

// ─── §G4 — bearer-token seam ────────────────────────────────────────────────

describe('a minted token resolves to the tenant that minted it', () => {
  it('resolveApiToken returns the correct tenantId and tokenId', async () => {
    const { id: tenantId } = await makeTenant(db, 'acme');

    const minted = await withTenant(db, tenantId, (sql) =>
      mintApiToken(sql, tenantId, { name: 'test-key' }),
    );

    expect(minted.tokenId).toBeDefined();
    expect(minted.tokenId.length).toBeGreaterThan(0);
    expect(minted.token.startsWith(TOKEN_PREFIX)).toBe(true);

    const resolved = await resolveApiToken(db, minted.token);

    expect(resolved).not.toBeNull();
    expect(resolved!.tenantId).toBe(tenantId);
    expect(resolved!.tokenId).toBe(minted.tokenId);
  });
});

describe('the raw token is never stored in the database', () => {
  it('token_hash equals hashApiToken(token) and does not contain the raw token', async () => {
    const { id: tenantId } = await makeTenant(db, 'globex');

    const minted = await withTenant(db, tenantId, (sql) =>
      mintApiToken(sql, tenantId, { name: 'secret-key' }),
    );

    const [row] = await withAdmin(db, (sql) =>
      sql.query<{ token_hash: string }>(
        'SELECT token_hash FROM api_tokens WHERE id = $1',
        [minted.tokenId],
      ),
    );

    expect(row!.token_hash).toBe(hashApiToken(minted.token));
    expect(row!.token_hash).not.toContain(minted.token);
  });
});

describe('a revoked token resolves to null', () => {
  it('revoked and made-up tokens are indistinguishable — both return null', async () => {
    const { id: tenantId } = await makeTenant(db, 'umbrella');

    const minted = await withTenant(db, tenantId, (sql) =>
      mintApiToken(sql, tenantId, { name: 'revoke-me' }),
    );

    // First resolve succeeds.
    const before = await resolveApiToken(db, minted.token);
    expect(before).not.toBeNull();

    // Revoke it.
    const revoked = await withTenant(db, tenantId, (sql) =>
      revokeApiToken(sql, minted.tokenId),
    );
    expect(revoked).toBe(true);

    // Now it resolves to null.
    expect(await resolveApiToken(db, minted.token)).toBeNull();

    // A made-up token also resolves to null.
    expect(await resolveApiToken(db, 'wm_nonexistent')).toBeNull();
  });
});

describe('a token with ttlMs: 2000 resolves to null after expiry', () => {
  it('short-TTL token + brief wait → null', async () => {
    const { id: tenantId } = await makeTenant(db, 'wayne');

    const minted = await withTenant(db, tenantId, (sql) =>
      mintApiToken(sql, tenantId, { name: 'short-lived', ttlMs: 2000 }),
    );

    // Immediate resolve should still work.
    expect(await resolveApiToken(db, minted.token)).not.toBeNull();

    // Wait for database-side expiry.
    await new Promise((r) => setTimeout(r, 3000));

    expect(await resolveApiToken(db, minted.token)).toBeNull();
  });
});

describe('listApiTokens shows one tenant only its own tokens', () => {
  it('no field of the summary contains the raw token; tenant-scoped', async () => {
    const { id: tenantA } = await makeTenant(db, 'cyberdyne');
    const { id: tenantB } = await makeTenant(db, 'massive');

    const mintA = await withTenant(db, tenantA, (sql) =>
      mintApiToken(sql, tenantA, { name: 'acme-key' }),
    );
    await withTenant(db, tenantB, (sql) =>
      mintApiToken(sql, tenantB, { name: 'massive-key' }),
    );

    const listA = await withTenant(db, tenantA, listApiTokens);
    expect(listA.length).toBe(1);
    const firstA = listA[0]!;
    expect(firstA.name).toBe('acme-key');

    // No field in the summary is the raw token.
    const raw = mintA.token;
    const dump = JSON.stringify(firstA);
    expect(dump).not.toContain(raw);

    // Tenant B sees its own, not A's.
    const listB = await withTenant(db, tenantB, listApiTokens);
    expect(listB.length).toBe(1);
    const firstB = listB[0]!;
    expect(firstB.name).toBe('massive-key');
  });
});

describe('parseBearer accepts valid Bearer headers and rejects invalid ones', () => {
  it('accepts "Bearer abc" and "bearer abc"; returns null for undefined, empty, Basic, and bare Bearer', () => {
    expect(parseBearer('Bearer abc')).toBe('abc');
    expect(parseBearer('bearer abc')).toBe('abc');
    expect(parseBearer(undefined)).toBeNull();
    expect(parseBearer('')).toBeNull();
    expect(parseBearer('Basic abc')).toBeNull();
    expect(parseBearer('Bearer')).toBeNull();
  });
});
