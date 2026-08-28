import { AsyncLocalStorage } from 'node:async_hooks';
import { PGlite } from '@electric-sql/pglite';
import type { Engine, Row, Session } from './engine.js';

/**
 * PGlite: real Postgres in-process, zero setup. It is the default dev/test
 * engine so `pnpm test` is green on a clean box with no database installed.
 *
 * It serves one connection, so transactions are serialised behind a promise
 * chain rather than overlapped. Nesting is not supported and is a programming
 * error, not a runtime condition to recover from.
 */
export async function openPglite(): Promise<Engine> {
  const db = new PGlite();
  await db.waitReady;

  let queue: Promise<unknown> = Promise.resolve();
  /**
   * True only inside a transaction callback's own async context. That is the
   * difference between the two things a naive `inTransaction` boolean conflates:
   * a call made FROM INSIDE another transaction (nesting — a programming error
   * that would queue behind its own parent and hang), and a call made from
   * somewhere else while one happens to be open (ordinary concurrency, which the
   * queue below serialises). The job runner's heartbeat is the second kind, and
   * a boolean would reject it at random depending on timing.
   */
  const openTransaction = new AsyncLocalStorage<true>();

  const session: Session = {
    async query<T = Row>(text: string, params: readonly unknown[] = []): Promise<T[]> {
      const result = await db.query<T>(text, params as unknown[]);
      return result.rows;
    },
    async exec(text: string): Promise<void> {
      await db.exec(text);
    },
  };

  return {
    kind: 'pglite',
    supportsConcurrentSessions: false,
    transaction<T>(fn: (sql: Session) => Promise<T>): Promise<T> {
      // Checked synchronously: a nested call queued behind its own parent would
      // wait forever instead of failing, and that deadlock is a maddening thing
      // to debug. Nesting is a programming error — say so immediately.
      if (openTransaction.getStore() === true) {
        return Promise.reject(
          new Error('pglite: nested transaction — withTenant/withAdmin do not nest'),
        );
      }
      const run = queue.then(() =>
        openTransaction.run(true, async () => {
          await db.exec('BEGIN');
          try {
            const value = await fn(session);
            await db.exec('COMMIT');
            return value;
          } catch (err) {
            await db.exec('ROLLBACK').catch(() => undefined);
            throw err;
          }
        }),
      );
      // Keep the chain alive after a rejection so later callers still run.
      queue = run.catch(() => undefined);
      return run;
    },
    async close(): Promise<void> {
      await queue.catch(() => undefined);
      await db.close();
    },
  };
}
