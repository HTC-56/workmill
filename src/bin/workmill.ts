import { loadConfig } from '../config/config.js';
import { installShutdownHandlers, startWorkmill } from '../main.js';

/**
 * The server process. `ExecStart` in `deploy/workmill.service` points here.
 *
 * It reads the config, starts everything, installs the two signal handlers, and
 * then does nothing at all — the open listener is what keeps the process alive.
 * Every timer in the repo is `unref`'d precisely so that closing the server is
 * enough to let node exit.
 */
try {
  const config = await loadConfig();
  const proc = await startWorkmill(config);
  installShutdownHandlers(proc);
} catch (error) {
  process.stderr.write(`workmill failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
