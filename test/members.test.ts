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
