import { resetDemo } from '../demo/reset.js';
import { formatManifest } from '../demo/seed.js';
import { runCommand, say } from './support.js';

/**
 * Restore the demo to seed state. `deploy/workmill-reset.timer` runs this.
 *
 * Every token it prints is new, because the old tenants and everything hanging
 * off them are gone. A visitor holding a bearer from before the reset finds it
 * stops working, which is the intended property of a public demo that resets on
 * a timer rather than a bug in it.
 */
await runCommand('resetting the demo', async ({ engine }) => {
  const { cleared, manifest } = await resetDemo(engine);
  say(
    cleared.tenantsRemoved === 0
      ? 'nothing to clear; seeding a fresh demo'
      : `cleared ${cleared.tenantsRemoved} demo tenant(s): ${cleared.slugs.join(', ')}`,
  );
  say('');
  for (const line of formatManifest(manifest)) say(line);
});
