import { withTenant } from '../seam/withTenant.js';
import { mintApiToken } from '../server/auth.js';
import { fail, runCommand, say, tenantIdBySlug } from './support.js';

/**
 * `mint-token <tenant-slug> [name]` — the CLI helper SPEC.md's non-goals
 * promised ("opaque bearer session tokens minted by a CLI helper and test
 * fixtures. Auth is a seam, not the product").
 *
 * Both pages hold their bearer in `localStorage` and neither can mint one,
 * deliberately: a page that could mint its own credential would be an auth
 * system, and this repo has decided not to build one. This is the whole of the
 * other half — a person with shell access on the box types a slug and gets a
 * token, once.
 */
const [slug, name] = process.argv.slice(2);
if (slug === undefined) fail('usage: mint-token <tenant-slug> [token-name]');

await runCommand('minting a token', async ({ engine }) => {
  const tenantId = await tenantIdBySlug(engine, slug);
  if (tenantId === null) throw new Error(`no tenant with slug "${slug}"`);

  const minted = await withTenant(engine, tenantId, (sql) =>
    mintApiToken(sql, tenantId, { name: name ?? 'cli' }),
  );
  say(minted.token);
});
