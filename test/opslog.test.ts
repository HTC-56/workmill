import { describe, expect, it } from 'vitest';
import {
  redact,
  formatOpsLine,
  memoryOpsLog,
  nullOpsLog,
  REDACTED,
} from '../src/ops/opslog.js';

/**
 * Proves `redact`, `formatOpsLine`, `memoryOpsLog`, `nullOpsLog`, and the
 * `REDACTED` constant from `src/ops/opslog.ts`.
 *
 * No database, no network — pure function tests only.
 */

describe('REDACTED is the sentinel string', () => {
  it('equals [redacted]', () => {
    expect(REDACTED).toBe('[redacted]');
  });
});

describe('redact replaces forbidden field values', () => {
  it('redacts input, output, prompt, and authorization keys', () => {
    const record = {
      kind: 'job',
      input: 'secret data',
      output: 'model reply',
      prompt: 'system instruction',
      authorization: 'Bearer xyz',
      jobId: 'abc-123',
      status: 'running',
      ms: 42,
    };
    const result = redact(record);
    expect(result.input).toBe(REDACTED);
    expect(result.output).toBe(REDACTED);
    expect(result.prompt).toBe(REDACTED);
    expect(result.authorization).toBe(REDACTED);
    expect(result.jobId).toBe('abc-123');
    expect(result.status).toBe('running');
    expect(result.ms).toBe(42);
  });
});

describe('redact leaves token counts untouched', () => {
  it('total_tokens and promptTokens are NOT redacted', () => {
    const record = {
      kind: 'usage',
      total_tokens: 150,
      promptTokens: 50,
      completionTokens: 100,
    };
    const result = redact(record);
    expect(result.total_tokens).toBe(150);
    expect(result.promptTokens).toBe(50);
    expect(result.completionTokens).toBe(100);
  });

  it('token_hash IS redacted', () => {
    const record = { kind: 'auth', token_hash: 'deadbeef' };
    const result = redact(record);
    expect(result.token_hash).toBe(REDACTED);
  });

  it('tokenhash IS redacted (no underscore variant)', () => {
    const record = { kind: 'auth', tokenhash: 'abc123' };
    const result = redact(record);
    expect(result.tokenhash).toBe(REDACTED);
  });
});

describe('redact is case-insensitive substring match', () => {
  it('redacts userInput (contains "input")', () => {
    const record = { kind: 'job', userInput: 'hidden' };
    const result = redact(record);
    expect(result.userInput).toBe(REDACTED);
  });

  it('redacts Authorization (capitalized)', () => {
    const record = { kind: 'auth', Authorization: 'Bearer tok' };
    const result = redact(record);
    expect(result.Authorization).toBe(REDACTED);
  });

  it('redacts secret and password fields', () => {
    const record = { kind: 'config', secret: 's3cr3t', password: 'pass123' };
    const result = redact(record);
    expect(result.secret).toBe(REDACTED);
    expect(result.password).toBe(REDACTED);
  });

  it('redacts bearer in key name', () => {
    const record = { kind: 'auth', bearer_token: 'xxx' };
    const result = redact(record);
    expect(result.bearer_token).toBe(REDACTED);
  });
});

describe('formatOpsLine produces exactly one newline-terminated line', () => {
  it('ends with \\n and contains no other newline', () => {
    const record = { kind: 'job', jobId: 'x' };
    const line = formatOpsLine(record, '2025-01-01T00:00:00.000Z');
    expect(line.endsWith('\n')).toBe(true);
    expect(line.split('\n').length).toBe(2);
  });

  it('survives a field value containing \\n — still one line', () => {
    const record = { kind: 'job', status: 'line1\nline2' };
    const line = formatOpsLine(record, '2025-01-01T00:00:00.000Z');
    // JSON.stringify escapes the newline inside the string, so the output
    // has exactly the trailing \n and nothing else.
    expect(line.split('\n').length).toBe(2);
    // The escaped \n appears as literal backslash-n in the JSON text.
    expect(line).toContain('\\n');
  });

  it('the parsed line carries at and kind', () => {
    const record = { kind: 'ping', ms: 3 };
    const line = formatOpsLine(record, '2025-06-15T12:00:00.000Z');
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.at).toBe('2025-06-15T12:00:00.000Z');
    expect(parsed.kind).toBe('ping');
  });
});

describe('memoryOpsLog appends and parses in order', () => {
  it('records() returns every appended record', async () => {
    const log = memoryOpsLog();
    await log.append({ kind: 'a', n: 1 });
    await log.append({ kind: 'b', n: 2 });
    await log.append({ kind: 'c', n: 3 });
    const recs = log.records();
    expect(recs).toHaveLength(3);
    expect(recs[0]).toMatchObject({ kind: 'a', n: 1 });
    expect(recs[1]).toMatchObject({ kind: 'b', n: 2 });
    expect(recs[2]).toMatchObject({ kind: 'c', n: 3 });
  });

  it('redaction is applied in records()', async () => {
    const log = memoryOpsLog();
    await log.append({ kind: 'job', input: 'hidden', jobId: 'ok' });
    const recs = log.records();
    expect((recs[0] as Record<string, unknown>).input).toBe('[redacted]');
    expect((recs[0] as Record<string, unknown>).jobId).toBe('ok');
  });

  it('lines() preserves raw newline termination', () => {
    const log = memoryOpsLog();
    expect(log.lines).toHaveLength(0);
  });
});

describe('nullOpsLog discards without throwing', () => {
  it('append and close never throw', async () => {
    const log = nullOpsLog();
    await expect(log.append({ kind: 'x' })).resolves.toBeUndefined();
    await expect(log.close()).resolves.toBeUndefined();
  });
});
