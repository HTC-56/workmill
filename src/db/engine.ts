/**
 * The one database abstraction in the repo.
 *
 * Both engines are real Postgres — PGlite is Postgres compiled to WASM — so
 * there is no dialect layer here and no query is ever rewritten per engine.
 * The only difference the rest of the code may observe is
 * `supportsConcurrentSessions`: PGlite is a single connection, so cases that
 * need two live transactions at once are Postgres-only. That is a pre-registered
 * limitation (DECISIONS.md), skipped loudly, never silently.
 */

export type Row = Record<string, unknown>;

/** A session bound to one connection inside one transaction. */
export interface Session {
  /** Parameterised query. Placeholders are `$1`, `$2`, … on both engines. */
  query<T = Row>(text: string, params?: readonly unknown[]): Promise<T[]>;
  /** Multi-statement script with no parameters. DDL and fixtures only. */
  exec(text: string): Promise<void>;
}

export interface Engine {
  readonly kind: 'pglite' | 'postgres';
  /** False on PGlite: one connection, so no two transactions can overlap. */
  readonly supportsConcurrentSessions: boolean;
  /**
   * Run `fn` inside a transaction on a session with full bootstrap privileges.
   * Migrations, operator provisioning, and test fixtures only — never a
   * tenant-reachable path. Tenant work goes through withTenant().
   */
  transaction<T>(fn: (sql: Session) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Thrown when a caller asks for concurrency the engine cannot provide. */
export class ConcurrencyUnsupportedError extends Error {
  constructor(what: string) {
    super(`${what} needs two concurrent sessions; this engine has one`);
    this.name = 'ConcurrencyUnsupportedError';
  }
}
