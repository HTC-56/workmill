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
  let inTransaction = false;

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
      if (inTransaction) {
        return Promise.reject(
          new Error('pglite: nested transaction — withTenant/withAdmin do not nest'),
        );
      }
      const run = queue.then(async () => {
        inTransaction = true;
        await db.exec('BEGIN');
        try {
          const value = await fn(session);
          await db.exec('COMMIT');
          return value;
        } catch (err) {
          await db.exec('ROLLBACK').catch(() => undefined);
          throw err;
        } finally {
          inTransaction = false;
        }
      });
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
