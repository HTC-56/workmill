import type { Engine } from './db/engine.js';
import { openEngine } from './db/open.js';
import { migrate } from './db/migrate.js';
import { createApp, type WorkmillApp } from './server/app.js';
import { fileOpsLog, nullOpsLog, type OpsLog } from './ops/opslog.js';
import { startRunnerLoop, type RunnerLoop } from './runner/schedule.js';
import type { WorkmillConfig } from './config/config.js';

/**
 * The process (ROADMAP row #9, and the reservation "nothing schedules the
 * runner or serves the process outside tests").
 *
 * Nine phases built libraries and proved them against tests that construct
 * their own engine, their own server and their own runner. This file is the
 * first place all three are assembled the way a deployment assembles them, and
 * it is deliberately the thinnest file that can do it: open, migrate, serve,
 * tick, stop. Every decision it could make has already been made in
 * `src/config/config.ts`; every mechanism it could implement already exists.
 *
 * `startWorkmill` returns a handle instead of blocking, and takes an optional
 * engine, so the whole assembly is reachable from a test without a signal
 * handler or a real port. The bottom of this file — the part that reads the
 * environment and installs signal handlers — belongs to `src/bin/workmill.ts`,
 * because a module that starts a server when it is imported is a module that
 * cannot be tested.
 *
 * Shutdown order is the one thing here worth getting right, and it is the
 * reverse of startup: stop the runner FIRST and await the sweep already in
 * flight, then stop accepting requests, then close the engine. Closing the
 * database under a running job would turn a clean stop into a lease timeout and
 * a retry, which is a bad way to teach an operator that restarts are safe.
 */

export interface WorkmillProcess {
  readonly config: WorkmillConfig;
  readonly engine: Engine;
  readonly app: WorkmillApp;
  /** Where it is actually listening, port resolved — `http://127.0.0.1:3000`. */
  readonly url: string;
  /** Null when `runner.enabled` is false: something else ticks the queue. */
  readonly runner: RunnerLoop | null;
  stop(): Promise<void>;
}

export interface StartOptions {
  /** Supply an engine to skip opening one — how tests reach this file. */
  readonly engine?: Engine;
  /** True when this function opened the engine and must therefore close it. */
  readonly ownsEngine?: boolean;
  /** Where startup progress goes. Defaults to stderr; pass a sink in tests. */
  readonly log?: (line: string) => void;
}

export async function startWorkmill(
  config: WorkmillConfig,
  options: StartOptions = {},
): Promise<WorkmillProcess> {
  const log = options.log ?? ((line: string): void => void process.stderr.write(`${line}\n`));

  // '' rather than undefined: `openEngine`'s default argument re-reads
  // DATABASE_URL, and the config has already decided what the database is.
  const engine = options.engine ?? (await openEngine(config.database.url ?? ''));
  const ownsEngine = options.ownsEngine ?? options.engine === undefined;

  const opsLog: OpsLog =
    config.ops.logPath === null
      ? nullOpsLog()
      : fileOpsLog(config.ops.logPath, (error) => log(`ops log write failed: ${String(error)}`));

  try {
    const applied = await migrate(engine);
    log(`engine ${engine.kind}; migrations applied: ${applied.length}`);
    if (config.database.url === null) {
      // Serving on PGlite is a fine way to look at the two pages, and useless
      // for anything else: the database lives in this process and dies with it.
      log('PGlite in-process: nothing written here survives a restart');
    }

    const app = createApp({
      engine,
      opsLog,
      operatorToken: config.ops.operatorToken,
      gateway: config.gateway,
    });

    await app.fastify.listen({ host: config.server.host, port: config.server.port });
    const address = app.fastify.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('server did not bind a TCP port');
    }
    const url = `http://${config.server.host}:${address.port}`;
    log(`listening on ${url}`);
    if (config.ops.operatorToken === null) {
      log('no WORKMILL_OPERATOR_TOKEN set: /metrics and the operator console are disabled');
    }

    // The bus is shared, so transitions the runner makes reach `/events`
    // subscribers. Publishing is reporting: the runner behaves the same without.
    const runner = config.runner.enabled
      ? startRunnerLoop(engine, config.gateway, {
          workerId: config.runner.workerId,
          intervalMs: config.runner.intervalMs,
          batchSize: config.runner.batchSize,
          leaseMs: config.runner.leaseMs,
          events: app.bus,
          onError: (tenantId, error) => log(`runner tick failed for ${tenantId}: ${String(error)}`),
        })
      : null;
    log(
      runner === null
        ? 'runner disabled; something else must tick the queue'
        : `runner ticking every ${config.runner.intervalMs}ms as ${config.runner.workerId}`,
    );

    let stopped = false;
    const stop = async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      if (runner !== null) await runner.stop();
      await app.fastify.close();
      await opsLog.close();
      if (ownsEngine) await engine.close();
    };

    return { config, engine, app, url, runner, stop };
  } catch (error) {
    // A failure between opening the engine and returning the handle leaves
    // nobody holding the connection; close what this function opened.
    await opsLog.close().catch(() => undefined);
    if (ownsEngine) await engine.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Stop cleanly on SIGTERM and SIGINT — the two signals systemd and a terminal
 * send. Returns a function that removes the handlers again, so a test that
 * calls this does not leave them behind.
 */
export function installShutdownHandlers(
  proc: WorkmillProcess,
  log: (line: string) => void = (line) => void process.stderr.write(`${line}\n`),
): () => void {
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];
  const onSignal = (signal: NodeJS.Signals): void => {
    log(`${signal}: stopping`);
    void proc
      .stop()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        log(`shutdown failed: ${String(error)}`);
        process.exit(1);
      });
  };
  for (const signal of signals) process.once(signal, onSignal);
  return (): void => {
    for (const signal of signals) process.removeListener(signal, onSignal);
  };
}
