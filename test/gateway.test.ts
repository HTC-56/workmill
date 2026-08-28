import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  chatCompletion,
  loadGatewayConfig,
  resolveModel,
  GatewayHttpError,
  GatewayProtocolError,
  GatewayTimeoutError,
  GatewayConfigError,
  DEFAULT_BASE_URL,
} from '../src/gateway/client.js';
import { startStubGateway } from './helpers/stub-gateway.js';

/**
 * Proves `src/gateway/client.ts` against the in-process stub — usage,
 * timeout, 5xx, malformed body, model map, and config validation.
 *
 * Pattern file: `test/render.test.ts` for style.
 */

let stub: Awaited<ReturnType<typeof startStubGateway>>;

beforeAll(async () => {
  stub = await startStubGateway();
});

beforeEach(() => {
  // Each test gets a clean slate so stub.requests[0] is the current call.
  stub.requests.length = 0;
});

afterAll(async () => {
  await stub.close();
});

// ── 1. content behaviour returns text + usage ──────────────────────────────

describe('chatCompletion returns content and usage for a happy-path response', () => {
  it('content lands as the response text', async () => {
    stub.queue({ kind: 'content', content: 'hello model' });
    const config = { baseUrl: stub.baseUrl, timeoutMs: 60_000, models: {} };
    const result = await chatCompletion(config, {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.content).toBe('hello model');
  });

  it('usage reads back { promptTokens, completionTokens, totalTokens } matching the behaviour', async () => {
    stub.queue({ kind: 'content', content: '{}', promptTokens: 12, completionTokens: 34 });
    const config = { baseUrl: stub.baseUrl, timeoutMs: 60_000, models: {} };
    const result = await chatCompletion(config, {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(result.usage).toEqual({ promptTokens: 12, completionTokens: 34, totalTokens: 46 });
  });

  it('totalTokens is the sum of promptTokens + completionTokens', async () => {
    stub.queue({ kind: 'content', content: '{}', promptTokens: 5, completionTokens: 7 });
    const config = { baseUrl: stub.baseUrl, timeoutMs: 60_000, models: {} };
    const result = await chatCompletion(config, { model: 'gpt-4', messages: [] });
    expect(result.usage.totalTokens).toBe(5 + 7);
  });
});

// ── 2. what went out is what was asked for ─────────────────────────────────

describe('the recorded request mirrors the caller parameters', () => {
  beforeEach(() => {
    // Default response for tests in this block that don't queue one.
    stub.setDefault({ kind: 'content', content: '{}' });
  });

  it('temperature is forwarded', async () => {
    stub.queue({ kind: 'content', content: '{}' });
    const config = { baseUrl: stub.baseUrl, timeoutMs: 60_000, models: {} };
    await chatCompletion(config, {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.7,
    });
    expect(stub.requests[0]!.temperature).toBe(0.7);
  });

  it('maxOutputTokens is forwarded as maxTokens on the wire', async () => {
    stub.queue({ kind: 'content', content: '{}' });
    const config = { baseUrl: stub.baseUrl, timeoutMs: 60_000, models: {} };
    await chatCompletion(config, {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hi' }],
      maxOutputTokens: 128,
    });
    expect(stub.requests[0]!.maxTokens).toBe(128);
  });
});

// ── 3. 5xx status rejects with GatewayHttpError ────────────────────────────

describe('a 503 status rejects with GatewayHttpError', () => {
  it('the error status is 503', async () => {
    stub.queue({ kind: 'status', status: 503, body: 'service unavailable' });
    const config = { baseUrl: stub.baseUrl, timeoutMs: 60_000, models: {} };
    try {
      await chatCompletion(config, { model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GatewayHttpError);
      expect((err as GatewayHttpError).status).toBe(503);
    }
  });
});

// ── 4. malformed / not-a-completion reject with GatewayProtocolError ───────

describe('malformed responses reject with GatewayProtocolError', () => {
  it('{ kind: "malformed" } throws GatewayProtocolError', async () => {
    stub.queue({ kind: 'malformed' });
    const config = { baseUrl: stub.baseUrl, timeoutMs: 60_000, models: {} };
    await expect(
      chatCompletion(config, { model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(GatewayProtocolError);
  });

  it('{ kind: "not-a-completion" } throws GatewayProtocolError', async () => {
    stub.queue({ kind: 'not-a-completion' });
    const config = { baseUrl: stub.baseUrl, timeoutMs: 60_000, models: {} };
    await expect(
      chatCompletion(config, { model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(GatewayProtocolError);
  });
});

// ── 5. delay beyond timeoutMs rejects with GatewayTimeoutError ─────────────

describe('a slow stub rejects with GatewayTimeoutError', () => {
  it('{ kind: "delay" } past timeoutMs throws GatewayTimeoutError', async () => {
    stub.queue({ kind: 'delay', ms: 500 });
    const config = { baseUrl: stub.baseUrl, timeoutMs: 60, models: {} };
    await expect(
      chatCompletion(config, { model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(GatewayTimeoutError);
  });
});

// ── 6. apiKey header ───────────────────────────────────────────────────────

describe('apiKey sets the authorization header', () => {
  beforeEach(() => {
    stub.setDefault({ kind: 'content', content: '{}' });
  });

  it('a config with apiKey produces Bearer <key>', async () => {
    stub.queue({ kind: 'content', content: '{}' });
    const config = { baseUrl: stub.baseUrl, timeoutMs: 60_000, models: {}, apiKey: 'sk-test-key' };
    await chatCompletion(config, { model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] });
    expect(stub.requests[0]!.authorization).toBe('Bearer sk-test-key');
  });

  it('a config without apiKey leaves authorization undefined', async () => {
    const config = { baseUrl: stub.baseUrl, timeoutMs: 60_000, models: {} };
    await chatCompletion(config, { model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] });
    expect(stub.requests[0]!.authorization).toBeUndefined();
  });
});

// ── 7. loadGatewayConfig, resolveModel, and config validation ──────────────

describe('loadGatewayConfig defaults and validation', () => {
  it('defaults baseUrl to http://localhost:8080/v1', () => {
    const config = loadGatewayConfig({});
    expect(config.baseUrl).toBe(DEFAULT_BASE_URL);
  });

  it('strips a trailing slash from GATEWAY_BASE_URL', () => {
    const config = loadGatewayConfig({ GATEWAY_BASE_URL: 'http://localhost:8080/v1/' });
    expect(config.baseUrl).toBe('http://localhost:8080/v1');
  });

  it('resolveModel maps a logical name to the wire name', () => {
    const config = loadGatewayConfig({ GATEWAY_MODELS: '{"default":"real-name"}' });
    expect(resolveModel(config, 'default')).toBe('real-name');
  });

  it('resolveModel returns unmapped names unchanged', () => {
    const config = loadGatewayConfig({ GATEWAY_MODELS: '{"default":"real-name"}' });
    expect(resolveModel(config, 'unknown-model')).toBe('unknown-model');
  });

  it('a non-http URL throws GatewayConfigError', () => {
    expect(() => loadGatewayConfig({ GATEWAY_BASE_URL: 'ftp://bad/url' })).toThrow(GatewayConfigError);
  });

  it('an unparseable GATEWAY_MODELS throws GatewayConfigError', () => {
    expect(() =>
      loadGatewayConfig({ GATEWAY_BASE_URL: 'http://localhost:8080/v1', GATEWAY_MODELS: '{bad' }),
    ).toThrow(GatewayConfigError);
  });
});
