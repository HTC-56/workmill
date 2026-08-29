import { DemoExistsError, formatManifest, seedDemo } from '../demo/seed.js';
import { runCommand, say } from './support.js';

/**
 * Provision the demo (SPEC.md feature 9): two tenants with tight budgets, the
 * three example workflows each, and one bearer token each, printed once.
 */
await runCommand('seeding the demo', async ({ engine }) => {
  try {
    const manifest = await seedDemo(engine);
    for (const line of formatManifest(manifest)) say(line);
  } catch (error) {
    if (error instanceof DemoExistsError) {
      throw new Error(`${error.message} (pnpm reset:demo)`);
    }
    throw error;
  }
});
