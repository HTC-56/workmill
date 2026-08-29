import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Engine } from '../src/db/engine.js';
import { withTenant } from '../src/seam/withTenant.js';
import { freshDb, makeTenant } from './helpers/db.js';
import {
  grantSupportAccess,
  listSupportGrants,
  activeSupportGrant,
  revokeSupportGrant,
  isGrantActive,
  grantRemainingMs,
  DEFAULT_GRANT_TTL_MS,
  GrantRefusedError,
  type SupportGrant,
} from '../src/operator/grants.js';
import {
  recordAudit,
  listAudit,
  clampAuditLimit,
  DEFAULT_AUDIT_LIMIT,
  MAX_AUDIT_LIMIT,
} from '../src/operator/audit.js';

/**
 * Proves `grantSupportAccess`, `listSupportGrants`, `activeSupportGrant`,
 * `revokeSupportGrant`, `isGrantActive`, `grantRemainingMs` in
 * `src/operator/grants.ts`, and `recordAudit`, `listAudit`, `clampAuditLimit`
 * in `src/operator/audit.ts`.
 *
 * Patterned after test/auth.test.ts — same beforeAll/afterAll shape,
 * per-test tenant provisioning for isolation, withTenant for tenant-scoped
 * assertions. No HTTP server.
 */

let db: Engine;

beforeAll(async () => {
  db = await freshDb();
});

afterAll(async () => {
  await db?.close();
});

// ─── §I4 — grants: rows, helpers, validation ────────────────────────────────

describe('a grant made with a real reason comes back with all fields set', () => {
  it('reason, grantedBy, expiresAt > createdAt, revokedAt null', async () => {
    const { id: tenantId } = await makeTenant(db, 'grant-reason');

    const grant = await withTenant(db, tenantId, (sql) =>
      grantSupportAccess(sql, {
        reason: 'debugging a login loop',
        grantedBy: 'support-agent',
        ttlMs: DEFAULT_GRANT_TTL_MS,
      }),
    );

    expect(grant.reason).toBe('debugging a login loop');
    expect(grant.grantedBy).toBe('support-agent');
    expect(grant.revokedAt).toBeNull();
    expect(grant.expiresAt.getTime()).toBeGreaterThan(grant.createdAt.getTime());
    expect(grant.id).toBeDefined();
    expect(grant.id.length).toBeGreaterThan(0);
  });
});

describe('isGrantActive and grantRemainingMs agree with the row', () => {
  it('fresh grant is active; past-revoked and future-revoked grants are not', () => {
    const now = Date.now();

    // Fresh grant: active, remaining > 0.
    const fresh: SupportGrant = {
      id: '00000000-0000-4000-8000-000000000001',
      reason: 'debugging a login loop',
      grantedBy: 'agent',
      createdAt: new Date(now - 1000),
      expiresAt: new Date(now + DEFAULT_GRANT_TTL_MS),
      revokedAt: null,
    };
    expect(isGrantActive(fresh, now)).toBe(true);
    expect(grantRemainingMs(fresh, now)).toBe(DEFAULT_GRANT_TTL_MS);

    // Expired grant: inactive, remaining 0.
    const expired: SupportGrant = {
      ...fresh,
      expiresAt: new Date(now - 1000),
    };
    expect(isGrantActive(expired, now)).toBe(false);
    expect(grantRemainingMs(expired, now)).toBe(0);

    // Revoked grant (expires in future): inactive, remaining 0.
    const revoked: SupportGrant = {
      ...fresh,
      revokedAt: new Date(now - 500),
    };
    expect(isGrantActive(revoked, now)).toBe(false);
    expect(grantRemainingMs(revoked, now)).toBe(0);

    // Revoked grant (expires in past): also inactive.
    const revokedExpired: SupportGrant = {
      ...expired,
      revokedAt: new Date(now - 500),
    };
    expect(isGrantActive(revokedExpired, now)).toBe(false);
    expect(grantRemainingMs(revokedExpired, now)).toBe(0);
  });
});

describe('reason too short and ttl out of range throw GrantRefusedError', () => {
  it('reason < 8 chars → reason-too-short; ttlMs: 5 → ttl-out-of-range', async () => {
    const { id: tenantId } = await makeTenant(db, 'grant-validate');

    // Short reason.
    await expect(
      withTenant(db, tenantId, (sql) =>
        grantSupportAccess(sql, {
          reason: 'short',
          grantedBy: 'agent',
        }),
      ),
    ).rejects.toThrow(GrantRefusedError);

    // Verify nothing was written.
    const grantsAfterShort = await withTenant(db, tenantId, listSupportGrants);
    expect(grantsAfterShort.length).toBe(0);

    // TTL too small.
    await expect(
      withTenant(db, tenantId, (sql) =>
        grantSupportAccess(sql, {
          reason: 'adequate reason text',
          grantedBy: 'agent',
          ttlMs: 5,
        }),
      ),
    ).rejects.toThrow(GrantRefusedError);

    const grantsAfterTtl = await withTenant(db, tenantId, listSupportGrants);
    expect(grantsAfterTtl.length).toBe(0);
  });
});

describe('revokeSupportGrant returns true once then false', () => {
  it('first revoke → true; second → false; activeSupportGrant → null', async () => {
    const { id: tenantId } = await makeTenant(db, 'grant-revoke');

    const grant = await withTenant(db, tenantId, (sql) =>
      grantSupportAccess(sql, {
        reason: 'revoke testing sequence',
        grantedBy: 'agent',
      }),
    );

    expect(await withTenant(db, tenantId, (sql) => revokeSupportGrant(sql, grant.id))).toBe(
      true,
    );
    expect(await withTenant(db, tenantId, (sql) => revokeSupportGrant(sql, grant.id))).toBe(
      false,
    );
    expect(await withTenant(db, tenantId, activeSupportGrant)).toBeNull();
  });
});

describe('grants are tenant-scoped', () => {
  it("tenant B sees [] and can't revoke tenant A's grant", async () => {
    const { id: tenantA } = await makeTenant(db, 'grant-scope-a');
    const { id: tenantB } = await makeTenant(db, 'grant-scope-b');

    const grantA = await withTenant(db, tenantA, (sql) =>
      grantSupportAccess(sql, {
        reason: 'scoped testing across tenants',
        grantedBy: 'agent',
      }),
    );

    // Tenant A sees its grant.
    const listA = await withTenant(db, tenantA, listSupportGrants);
    expect(listA.length).toBe(1);
    expect(listA[0]!.id).toBe(grantA.id);

    // Tenant B sees nothing.
    const listB = await withTenant(db, tenantB, listSupportGrants);
    expect(listB.length).toBe(0);

    // Tenant B cannot revoke A's grant.
    expect(await withTenant(db, tenantB, (sql) => revokeSupportGrant(sql, grantA.id))).toBe(
      false,
    );
  });
});

// ─── §I4 — audit trail ─────────────────────────────────────────────────────

describe('recordAudit then listAudit returns the entry with typed fields', () => {
  it('detail is an object; at is a Date; grantId null for non-grant entries', async () => {
    const { id: tenantA } = await makeTenant(db, 'audit-scope-a');
    const { id: tenantB } = await makeTenant(db, 'audit-scope-b');

    const auditId = await withTenant(db, tenantA, (sql) =>
      recordAudit(sql, {
        actor: 'operator',
        action: 'support.granted',
        detail: { ttlMs: 3600000 },
      }),
    );

    const entries = await withTenant(db, tenantA, listAudit);
    expect(entries.length).toBe(1);
    const entry = entries[0]!;
    expect(entry.id).toBe(auditId);
    expect(entry.actor).toBe('operator');
    expect(entry.action).toBe('support.granted');
    expect(entry.detail).toBeInstanceOf(Object);
    expect(entry.detail.ttlMs).toBe(3600000);
    expect(entry.at).toBeInstanceOf(Date);
    expect(entry.grantId).toBeNull();

    // Tenant B does not see the audit entry.
    const entriesB = await withTenant(db, tenantB, listAudit);
    expect(entriesB.length).toBe(0);
  });

  it('grantId carries the id when the entry references a grant', async () => {
    const { id: tenantId } = await makeTenant(db, 'audit-grant-ref');

    const grant = await withTenant(db, tenantId, (sql) =>
      grantSupportAccess(sql, {
        reason: 'linking audit to a grant',
        grantedBy: 'agent',
      }),
    );

    await withTenant(db, tenantId, (sql) =>
      recordAudit(sql, {
        actor: 'operator',
        action: 'support.revoked',
        detail: { reason: 'testing' },
        grantId: grant.id,
      }),
    );

    const entries = await withTenant(db, tenantId, listAudit);
    expect(entries.length).toBe(1);
    expect(entries[0]!.grantId).toBe(grant.id);
  });
});

describe('clampAuditLimit is pure and clamps correctly', () => {
  it("'abc' → 50; 0 → 50; 9999 → 500; '7' → 7", () => {
    expect(clampAuditLimit('abc')).toBe(DEFAULT_AUDIT_LIMIT);
    expect(clampAuditLimit(0)).toBe(DEFAULT_AUDIT_LIMIT);
    expect(clampAuditLimit(9999)).toBe(MAX_AUDIT_LIMIT);
    expect(clampAuditLimit('7')).toBe(7);
  });
});
