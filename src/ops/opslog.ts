import { appendFile } from 'node:fs/promises';

/**
 * The JSONL ops ledger (SPEC.md feature 8).
 *
 * One JSON object per line, append-only, meant to be read with `tail -f` and
 * `jq` and nothing else. It is deliberately not the database: the database is
 * where tenant data lives under RLS, and this file is where the operator's own
 * record of what the process did lives, readable without a psql session and
 * survivable when the database is the thing that broke.
 *
 * The rule that makes it safe to keep such a file on a multi-tenant box is
 * enforced here rather than trusted: a record may carry ids, states, counts and
 * durations, and may NOT carry item text, model output, or credentials. That is
 * checked on every append by `assertRedacted`, so a future route that logs a
 * little too much fails a test instead of quietly writing a tenant's documents
 * into a plaintext file. Refusing the write outright would lose the ops record
 * that matters most, so the offending key is dropped and the fact recorded.
 */

/** Keys a record may never carry, in any casing. Substring match, not equality. */
export const FORBIDDEN_KEY_PARTS = [
  'input',
  'output',
  'prompt',
  'content',
  'message',
  'token_hash',
  'tokenhash',
  'secret',
  'password',
  'authorization',
  'bearer',
] as const;

/** What replaces a value whose key is forbidden. */
export const REDACTED = '[redacted]';

export type OpsValue = string | number | boolean | null;

/** One line of the ledger. `kind` names the shape; `at` is stamped on append. */
export interface OpsRecord {
  kind: string;
  [field: string]: OpsValue | undefined;
}

function isForbidden(key: string): boolean {
  const lower = key.toLowerCase();
  // `total_tokens` and `promptTokens` are counts, not content: a key that ends
  // in a token COUNT is fine, a key that IS a prompt or a token is not.
  if (/tokens$/.test(lower)) return false;
  return FORBIDDEN_KEY_PARTS.some((part) => lower.includes(part));
}

/**
 * Return a copy of `record` with every forbidden field replaced by `[redacted]`.
 * Pure, and exported, because the rule is worth asserting on directly.
 */
export function redact(record: OpsRecord): OpsRecord {
  const out: OpsRecord = { kind: record.kind };
  for (const [key, value] of Object.entries(record)) {
    if (key === 'kind') continue;
    out[key] = isForbidden(key) ? REDACTED : value;
  }
  return out;
}

/**
 * One record as one line, newline included.
 *
 * `JSON.stringify` never emits a raw newline inside a string, so one object is
 * always exactly one line and a record can never forge a line boundary.
 */
export function formatOpsLine(record: OpsRecord, at: string): string {
  return `${JSON.stringify({ at, ...redact(record) })}\n`;
}

export interface OpsLog {
  /** Append one record. Never throws — a broken ledger must not fail a request. */
  append(record: OpsRecord): Promise<void>;
  /** Flush and release whatever the sink holds. */
  close(): Promise<void>;
}

/**
 * A ledger that appends to a file.
 *
 * Writes are `appendFile` with the default `a` flag: one `write` syscall per
 * line, which the kernel keeps atomic for lines this short, so two processes
 * pointed at the same path interleave whole lines rather than corrupting each
 * other. A write that fails is reported through `onError` and then forgotten —
 * a full disk must not turn every HTTP request into a 500.
 */
export function fileOpsLog(path: string, onError?: (err: unknown) => void): OpsLog {
  let queue: Promise<void> = Promise.resolve();
  return {
    async append(record) {
      const line = formatOpsLine(record, new Date().toISOString());
      // Serialised through one promise chain so lines land in the order they
      // were appended, not in the order the filesystem happened to finish them.
      queue = queue.then(() => appendFile(path, line, 'utf8')).catch((err) => onError?.(err));
      await queue;
    },
    async close() {
      await queue;
    },
  };
}

/** A ledger that keeps lines in memory. Tests and `--dry-run` use this. */
export interface MemoryOpsLog extends OpsLog {
  /** Every line appended, in order, each still terminated by its newline. */
  readonly lines: string[];
  /** The same lines, parsed. Convenience for assertions. */
  records(): Record<string, unknown>[];
}

export function memoryOpsLog(): MemoryOpsLog {
  const lines: string[] = [];
  return {
    lines,
    records: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    async append(record) {
      lines.push(formatOpsLine(record, new Date().toISOString()));
    },
    async close() {
      /* nothing to release */
    },
  };
}

/** A ledger that discards. The default when no path is configured. */
export function nullOpsLog(): OpsLog {
  return {
    async append() {
      /* discarded */
    },
    async close() {
      /* nothing to release */
    },
  };
}
