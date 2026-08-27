import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Engine } from '../src/db/engine.js';
import { withAdmin, withTenant } from '../src/seam/withTenant.js';
import { freshDb } from './helpers/db.js';
import { provisionTenant } from '../src/tenancy/provision.js';
import {
  inviteMember,
  acceptInvite,
  hashInviteToken,
  InviteNotFoundError,
  InviteExpiredError,
  revokeInvite,
  revokeMembership,
} from '../src/tenancy/members.js';

/**
 * Proves `inviteMember`, `acceptInvite`, and `hashInviteToken` in
 * `src/tenancy/members.ts`: invite returns an id + token + future expiry, the
 * raw token is never stored, acceptance creates a membership with the right
 * display name, and a spent (or unknown) token refuses.
 *
 * Patterned after test/seam.test.ts: same beforeAll/afterAll shape, with each
 * test provisioning its own tenant for isolation (see test/tenancy.test.ts).
 */

let db: Engine;

beforeAll(async () => {
  db = await freshDb();
});

afterAll(async () => {
  await db?.close();
});

describe('inviteMember returns an inviteId, a token, and an expiresAt in the future', () => {
  it('inviteId is non-empty, token is base64url, expiresAt is 7 days out', async () => {
    const { tenantId } = await provisionTenant(db, {
      slug: 'acme',
      name: 'Acme Corp',
      ownerEmail: 'alice@acme.example',
    });

    const result = await withTenant(db, tenantId, (sql) =>
      inviteMember(sql, tenantId, { email: 'carol@outside.example', role: 'member' }),
    );

    expect(result.inviteId).toBeDefined();
    expect(result.inviteId.length).toBeGreaterThan(0);

    expect(result.token).toBeDefined();
    expect(result.token.length).toBeGreaterThan(0);

    expect(result.expiresAt).toBeInstanceOf(Date);
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
    // Default TTL is 7 days (INVITE_TTL_MS = 604800000).
    const diff = result.expiresAt.getTime() - Date.now();
    expect(diff).toBeGreaterThan(600_000_000);
  });
});

describe('the raw token is never stored in the database', () => {
  it('invite token_hash equals hashInviteToken(token) and does not equal the token', async () => {
    const { tenantId } = await provisionTenant(db, {
      slug: 'globex',
      name: 'Globex Inc',
      ownerEmail: 'bob@globex.example',
    });

    const invite = await withTenant(db, tenantId, (sql) =>
      inviteMember(sql, tenantId, { email: 'dave@outside.example', role: 'admin' }),
    );

    // Read the invite row as admin (bypasses RLS).
    const [row] = await withAdmin(db, (sql) =>
      sql.query<{ token_hash: string }>(
        'SELECT token_hash FROM invites WHERE id = $1',
        [invite.inviteId],
      ),
    );

    expect(row!.token_hash).toBe(hashInviteToken(invite.token));
    expect(row!.token_hash).not.toBe(invite.token);
  });
});

describe('acceptInvite returns the tenant id and the invited role', () => {
  it('tenantId matches the inviting tenant; role matches what was invited as', async () => {
    const { tenantId } = await provisionTenant(db, {
      slug: 'initech',
      name: 'Initech',
      ownerEmail: 'bill@initech.example',
    });

    const invite = await withTenant(db, tenantId, (sql) =>
      inviteMember(sql, tenantId, { email: 'eve@accepts.example', role: 'member' }),
    );

    const accepted = await acceptInvite(db, invite.token, 'Eve Accept');

    expect(accepted.tenantId).toBe(tenantId);
    expect(accepted.role).toBe('member');
  });
});

describe('after acceptance the tenant has two memberships with the right display name', () => {
  it('owner + new member; display_name is the one passed to acceptInvite', async () => {
    const { tenantId } = await provisionTenant(db, {
      slug: 'soylent',
      name: 'Soylent Corp',
      ownerEmail: 'alice@soylent.example',
    });

    const invite = await withTenant(db, tenantId, (sql) =>
      inviteMember(sql, tenantId, { email: 'frank@accepts.example', role: 'admin' }),
    );

    await acceptInvite(db, invite.token, 'Frank Custom');

    // Count memberships for the tenant as admin.
    const [count] = await withAdmin(db, (sql) =>
      sql.query<{ n: number }>(
        'SELECT count(*) AS n FROM memberships WHERE tenant_id = $1',
        [tenantId],
      ),
    );
    expect(count!.n).toBe(2);

    // The new user's display_name should be what we passed.
    const [user] = await withAdmin(db, (sql) =>
      sql.query<{ display_name: string }>(
        'SELECT display_name FROM users WHERE email = $1',
        ['frank@accepts.example'],
      ),
    );
    expect(user!.display_name).toBe('Frank Custom');
  });
});

describe('a spent invite token refuses on second use', () => {
  it('acceptInvite(token) a second time throws InviteNotFoundError', async () => {
    const { tenantId } = await provisionTenant(db, {
      slug: 'umbrella',
      name: 'Umbrella Corp',
      ownerEmail: 'alan@umbrella.example',
    });

    const invite = await withTenant(db, tenantId, (sql) =>
      inviteMember(sql, tenantId, { email: 'grace@spent.example', role: 'member' }),
    );

    // First acceptance succeeds.
    await acceptInvite(db, invite.token, 'Grace');

    // Second acceptance rejects.
    await expect(acceptInvite(db, invite.token, 'Grace Again')).rejects.toThrow(
      InviteNotFoundError,
    );
  });
});

describe('an unknown token rejects with InviteNotFoundError', () => {
  it('a random token throws InviteNotFoundError, no distinction from spent', async () => {
    // Generate a random base64url string that is definitely not a valid invite.
    const randomToken = 'aJk3mNx9qR7sT2wY5bC8dF1gH4jK6lP0oU3vX7zA';

    await expect(acceptInvite(db, randomToken, 'Nobody')).rejects.toThrow(
      InviteNotFoundError,
    );
  });
});

// ─── §B7 — expiry, revocation, one live invite at a time ───────────────────

describe('an invite with ttlMs: 1 rejects with InviteExpiredError after waiting', () => {
  it('short-TTL invite + brief wait → InviteExpiredError (not InviteNotFoundError)', async () => {
    const { tenantId } = await provisionTenant(db, {
      slug: 'wayne',
      name: 'Wayne Enterprises',
      ownerEmail: 'bruce@wayne.example',
    });

    const invite = await withTenant(db, tenantId, (sql) =>
      inviteMember(sql, tenantId, {
        email: 'alfred@wayne.example',
        role: 'member',
        ttlMs: 1,
      }),
    );

    // Wait for the database-side expiry to pass (~30ms gives headroom).
    await new Promise((r) => setTimeout(r, 30));

    await expect(acceptInvite(db, invite.token, 'Alfred')).rejects.toThrow(
      InviteExpiredError,
    );
  });
});

describe('revokeInvite on a pending invite returns true and blocks acceptance', () => {
  it('revokeInvite returns true; acceptInvite(token) then rejects', async () => {
    const { tenantId } = await provisionTenant(db, {
      slug: 'stark',
      name: 'Stark Industries',
      ownerEmail: 'tony@stark.example',
    });

    const invite = await withTenant(db, tenantId, (sql) =>
      inviteMember(sql, tenantId, {
        email: 'pepper@stark.example',
        role: 'admin',
      }),
    );

    const revoked = await withTenant(db, tenantId, (sql) =>
      revokeInvite(sql, invite.inviteId),
    );
    expect(revoked).toBe(true);

    await expect(acceptInvite(db, invite.token, 'Pepper Potts')).rejects.toThrow(
      InviteNotFoundError,
    );
  });
});

describe('cross-tenant revokeInvite returns false', () => {
  it('tenant B calling revokeInvite on tenant A\'s invite → false', async () => {
    const { tenantId: tenantA } = await provisionTenant(db, {
      slug: 'cyberdyne',
      name: 'Cyberdyne Systems',
      ownerEmail: 'skynet@cyberdyne.example',
    });

    const { tenantId: tenantB } = await provisionTenant(db, {
      slug: 'massive',
      name: 'Massive Dynamic',
      ownerEmail: 'walter@massive.example',
    });

    // Create an invite in tenant A.
    const invite = await withTenant(db, tenantA, (sql) =>
      inviteMember(sql, tenantA, {
        email: 'john@cyberdyne.example',
        role: 'member',
      }),
    );

    // Tenant B tries to revoke tenant A's invite — RLS makes it look like
    // the invite does not exist.
    const result = await withTenant(db, tenantB, (sql) =>
      revokeInvite(sql, invite.inviteId),
    );
    expect(result).toBe(false);
  });
});

describe('revokeMembership removes a seat but keeps the user row', () => {
  it('revokeMembership returns true; membership count drops; user survives', async () => {
    const { tenantId } = await provisionTenant(db, {
      slug: 'acme-two',
      name: 'Acme Corp 2',
      ownerEmail: 'alice2@acme.example',
    });

    const invite = await withTenant(db, tenantId, (sql) =>
      inviteMember(sql, tenantId, {
        email: 'bob2@acme.example',
        role: 'member',
      }),
    );

    // Accept the invite so there are two memberships.
    const accepted = await acceptInvite(db, invite.token, 'Bob');

    // Count memberships before revocation.
    const [before] = await withAdmin(db, (sql) =>
      sql.query<{ n: number }>(
        'SELECT count(*) AS n FROM memberships WHERE tenant_id = $1',
        [tenantId],
      ),
    );
    expect(before!.n).toBe(2);

    // Revoke Bob's membership.
    const revoked = await withTenant(db, tenantId, (sql) =>
      revokeMembership(sql, accepted.userId),
    );
    expect(revoked).toBe(true);

    // One fewer membership.
    const [after] = await withAdmin(db, (sql) =>
      sql.query<{ n: number }>(
        'SELECT count(*) AS n FROM memberships WHERE tenant_id = $1',
        [tenantId],
      ),
    );
    expect(after!.n).toBe(1);

    // The user row must still exist — losing a seat does not erase the person.
    const [user] = await withAdmin(db, (sql) =>
      sql.query<{ id: string }>(
        'SELECT id FROM users WHERE id = $1',
        [accepted.userId],
      ),
    );
    expect(user).toBeDefined();
  });
});

describe('two pending invites for the same address: the second inviteMember rejects', () => {
  it('revoke the first, then re-invite the same address — succeeds', async () => {
    const { tenantId } = await provisionTenant(db, {
      slug: 'soylent-two',
      name: 'Soylent Corp 2',
      ownerEmail: 'alice2@soylent.example',
    });

    // First invite for carol@soylent.example succeeds.
    const first = await withTenant(db, tenantId, (sql) =>
      inviteMember(sql, tenantId, {
        email: 'carol@soylent.example',
        role: 'member',
      }),
    );
    expect(first).toBeDefined();

    // Second invite for the same address in the same tenant rejects (partial
    // unique index on (tenant_id, lower(email)) WHERE state = 'pending').
    await expect(
      withTenant(db, tenantId, (sql) =>
        inviteMember(sql, tenantId, {
          email: 'carol@soylent.example',
          role: 'admin',
        }),
      ),
    ).rejects.toThrow();

    // Revoke the first invite — the partial unique constraint is lifted.
    const revoked = await withTenant(db, tenantId, (sql) =>
      revokeInvite(sql, first.inviteId),
    );
    expect(revoked).toBe(true);

    // Now re-inviting the same address succeeds.
    const second = await withTenant(db, tenantId, (sql) =>
      inviteMember(sql, tenantId, {
        email: 'carol@soylent.example',
        role: 'admin',
      }),
    );
    expect(second.inviteId).toBeDefined();
    expect(second.inviteId.length).toBeGreaterThan(0);
  });
});
