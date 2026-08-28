import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { runCompletion, MAX_REASKS, type CompleteResult } from '../src/gateway/complete.js';
import {
  GatewayHttpError,
  type GatewayConfig,
} from '../src/gateway/client.js';
import { startStubGateway } from './helpers/stub-gateway.js';

/**
 * Proves `runCompletion` from `src/gateway/complete.ts` — bounded re-ask,
 * summed usage, and transport-error propagation.
 *
 * Pattern file: `test/gateway.test.ts` for stub setup/teardown style.
 */

function isSuccess(r: CompleteResult): r is Extract<CompleteResult, { ok: true }> {
  return r.ok === true;
}

let stub: Awaited<ReturnType<typeof startStubGateway>>;

beforeAll(async () => {
  stub = await startStubGateway();
});

beforeEach(() => {
  stub.requests.length = 0;
  stub.setDefault({ kind: 'content', content: '{}' });
});

afterAll(async () => {
  await stub.close();
});

// ── helpers ──────────────────────────────────────────────────────────────────

const SCHEMA = {
  type: 'object',
  properties: {
    label: { type: 'string', enum: ['spam', 'ham'] },
  },
  required: ['label'],
} as Record<string, unknown>;

function config(): GatewayConfig {
  return { baseUrl: stub.baseUrl, timeoutMs: 60_000, models: {} };
}

function completeArgs(extra?: Partial<Parameters<typeof runCompletion>[1]>) {
  return {
    promptTemplate: 'Classify this: {{input}}',
    input: 'eggs',
    outputSchema: SCHEMA,
    model: 'gpt-4',
    ...extra,
  };
}

// ── 1. first reply matches → ok, attempts 1 ──────────────────────────────────

describe('a matching first reply returns ok with attempts 1', () => {
  it('value is deep-equal to the object the stub sent', async () => {
    const expected = { label: 'ham' };
    stub.queue({ kind: 'content', content: JSON.stringify(expected) });
    const result = await runCompletion(config(), completeArgs());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.attempts).toBe(1);
    expect(result.value).toEqual(expected);
  });

  it('usage.totalTokens equals that one response total', async () => {
    const expected = { label: 'spam' };
    stub.queue({
      kind: 'content',
      content: JSON.stringify(expected),
      promptTokens: 10,
      completionTokens: 20,
    });
    const result = await runCompletion(config(), completeArgs());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.usage.totalTokens).toBe(30);
  });
});

// ── 2. invalid then valid → ok, attempts 2, summed usage ─────────────────────

describe('an invalid first reply followed by a valid one returns ok with summed usage', () => {
  it('attempts is 2 and usage is the sum across both calls', async () => {
    const bad = { label: 'eggs' }; // not in enum
    const good = { label: 'ham' };
    stub.queue(
      { kind: 'content', content: JSON.stringify(bad), promptTokens: 8, completionTokens: 12 },
      { kind: 'content', content: JSON.stringify(good), promptTokens: 10, completionTokens: 15 },
    );
    const result = await runCompletion(config(), completeArgs());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.attempts).toBe(2);
    expect(result.usage.totalTokens).toBe(8 + 12 + 10 + 15);
  });
});

// ── 3. three schema-invalid replies → bounded, errors ────────────────────────

describe('three schema-invalid replies return ok: false with reason schema-invalid', () => {
  it('attempts is 3, errors is non-empty, and stub.requests has length 3', async () => {
    const bad = { label: 'eggs' }; // not in enum
    stub.queue(
      { kind: 'content', content: JSON.stringify(bad) },
      { kind: 'content', content: JSON.stringify(bad) },
      { kind: 'content', content: JSON.stringify(bad) },
    );
    const result = await runCompletion(config(), completeArgs());
    expect(result.ok).toBe(false);
    if (isSuccess(result)) throw new Error('unreachable');
    expect(result.reason).toBe('schema-invalid');
    expect(result.attempts).toBe(3);
    expect(Array.isArray(result.errors)).toBe(true);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(stub.requests.length).toBe(3);
  });
});

// ── 4. non-parseable replies → unparseable ───────────────────────────────────

describe('replies that are not parseable return ok: false with reason unparseable', () => {
  it('three non-JSON content replies return unparseable after 3 attempts', async () => {
    stub.queue(
      { kind: 'contentRaw', content: 'not json at all', promptTokens: 10, completionTokens: 5 },
      { kind: 'contentRaw', content: 'still not json', promptTokens: 12, completionTokens: 6 },
      { kind: 'contentRaw', content: 'nope', promptTokens: 14, completionTokens: 7 },
    );
    const result = await runCompletion(config(), completeArgs());
    expect(result.ok).toBe(false);
    if (isSuccess(result)) throw new Error('unreachable');
    expect(result.reason).toBe('unparseable');
    expect(result.attempts).toBe(3);
  });
});

// ── 5. re-ask carries context ────────────────────────────────────────────────

describe('the re-ask carries context about the schema problem', () => {
  it('the second request has more messages than the first', async () => {
    const bad = { label: 'eggs' };
    const good = { label: 'ham' };
    stub.queue(
      { kind: 'content', content: JSON.stringify(bad) },
      { kind: 'content', content: JSON.stringify(good) },
    );
    await runCompletion(config(), completeArgs());
    expect(stub.requests[0]!.messages.length).toBeLessThan(
      stub.requests[1]!.messages.length,
    );
  });

  it('the last message of the second request mentions the schema problem', async () => {
    const bad = { label: 'eggs' };
    const good = { label: 'ham' };
    stub.queue(
      { kind: 'content', content: JSON.stringify(bad) },
      { kind: 'content', content: JSON.stringify(good) },
    );
    await runCompletion(config(), completeArgs());
    const lastMsg = stub.requests[1]!.messages.at(-1)!.content;
    expect(lastMsg).toMatch(/attempt 1/i);
    expect(lastMsg).toMatch(/problem|fail|issue|return/i);
  });
});

// ── 6. 5xx transport failure rejects with GatewayHttpError ───────────────────

describe('a 500 status rejects with GatewayHttpError', () => {
  it('runCompletion does not swallow transport errors', async () => {
    stub.queue({ kind: 'status', status: 500, body: 'internal server error' });
    await expect(
      runCompletion(config(), completeArgs()),
    ).rejects.toThrow(GatewayHttpError);
  });
});

// ── 7. MAX_REASKS constant ───────────────────────────────────────────────────

describe('MAX_REASKS is bounded at 2', () => {
  it('MAX_REASKS equals 2 so at most 3 attempts are made', () => {
    expect(MAX_REASKS).toBe(2);
  });
});
