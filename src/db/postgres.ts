import postgres from 'postgres';
import type { Engine, Row, Session } from './engine.js';

/**
 * A real Postgres server, selected by DATABASE_URL. This is the authoritative
 * engine: the CI job that runs the suite against a Postgres service container
 * is the one whose result counts.
 */
export async function openPostgres(url: string, poolSize = 8): Promise<Engine> {
  const sql = postgres(url, {
    max: poolSize,
    // Timestamps come back as Date objects on both engines; leave the rest of
    // the type map alone so PGlite and postgres.js agree on shapes.
    onnotice: () => undefined,
    prepare: false,
    types: {
      // int8 (count(*), sums): PGlite parses to a JS number, postgres.js
      // defaults to a string. Parse to Number so the engines agree — every
      // tally here is far below 2^53.
      int8ToNumber: {
        to: 0,
        from: [20],
        serialize: (value: unknown) => String(value),
        parse: (value: string) => Number(value),
      },
    },
  });

  return {
    kind: 'postgres',
    supportsConcurrentSessions: true,
    async transaction<T>(fn: (session: Session) => Promise<T>): Promise<T> {
      return sql.begin(async (tx) => {
        const session: Session = {
          async query<R = Row>(text: string, params: readonly unknown[] = []): Promise<R[]> {
            const rows = await tx.unsafe(text, params as never[]);
            return rows as unknown as R[];
          },
          async exec(text: string): Promise<void> {
            await tx.unsafe(text).simple();
          },
        };
        return fn(session);
      }) as Promise<T>;
    },
    async close(): Promise<void> {
      await sql.end({ timeout: 5 });
    },
  };
}
