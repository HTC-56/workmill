import { describe, expect, it } from 'vitest';
import {
  buildConfig,
  ConfigError,
  defaultConfig,
} from '../src/config/config.js';

/**
 * Proves `buildConfig`, `ConfigError` and `defaultConfig` in
 * `src/config/config.ts`: defaults, the merge, and the two secrets the file
 * refuses.
 *
 * No database, no filesystem — every call passes hand-written objects for the
 * parsed file and the environment.
 */

// ---------------------------------------------------------------------------
// §J5-1  Zero config is a working config
// ---------------------------------------------------------------------------

describe('buildConfig — zero config', () => {
  it('returns host, port, gateway, runner, and ops defaults', () => {
    const cfg = buildConfig({}, {});
    expect(cfg.server.host).toBe('127.0.0.1');
    expect(cfg.server.port).toBe(3000);
    expect(cfg.database.url).toBeNull();
    expect(cfg.gateway.baseUrl).toBe('http://localhost:8080/v1');
    expect(cfg.gateway.timeoutMs).toBe(60000);
    expect(cfg.gateway.models).toEqual({});
    expect(cfg.runner.enabled).toBe(true);
    expect(cfg.runner.workerId).toBe('workmill-1');
    expect(cfg.ops.logPath).toBeNull();
    expect(cfg.ops.operatorToken).toBeNull();
  });
});

describe('defaultConfig', () => {
  it('equals buildConfig({}, {})', () => {
    expect(defaultConfig()).toEqual(buildConfig({}, {}));
  });
});

// ---------------------------------------------------------------------------
// §J5-2  A file sets things
// ---------------------------------------------------------------------------

describe('buildConfig — file sets values', () => {
  it('applies server and gateway blocks from the parsed file', () => {
    const raw = {
      server: { host: '0.0.0.0', port: 8080 },
      gateway: { baseUrl: 'http://example.com/v1', timeoutMs: 30000 },
    };
    const cfg = buildConfig(raw, {});
    expect(cfg.server.host).toBe('0.0.0.0');
    expect(cfg.server.port).toBe(8080);
    expect(cfg.gateway.baseUrl).toBe('http://example.com/v1');
    expect(cfg.gateway.timeoutMs).toBe(30000);
  });

  it('carries gateway.models pairs from the file', () => {
    const raw = {
      server: {},
      database: {},
      gateway: {
        baseUrl: 'http://localhost:8080/v1',
        timeoutMs: 60000,
        models: { 'llama': 'meta/llama-3-70b', 'gpt': 'openai/gpt-4' },
      },
      runner: {},
      ops: {},
    };
    const cfg = buildConfig(raw, {});
    expect(cfg.gateway.models).toEqual({
      llama: 'meta/llama-3-70b',
      gpt: 'openai/gpt-4',
    });
  });
});

// ---------------------------------------------------------------------------
// §J5-3  The environment wins
// ---------------------------------------------------------------------------

describe('buildConfig — environment overrides the file', () => {
  it('WORKMILL_PORT overrides server.port from the file', () => {
    const cfg = buildConfig(
      { server: { port: 9090 }, database: {}, gateway: {}, runner: {}, ops: {} },
      { WORKMILL_PORT: '4444' },
    );
    expect(cfg.server.port).toBe(4444);
  });

  it('DATABASE_URL overrides database.url from the file', () => {
    const cfg = buildConfig(
      { server: {}, database: { url: 'postgresql://old' }, gateway: {}, runner: {}, ops: {} },
      { DATABASE_URL: 'postgresql://new' },
    );
    expect(cfg.database.url).toBe('postgresql://new');
  });

  it('GATEWAY_BASE_URL overrides gateway.baseUrl from the file', () => {
    const cfg = buildConfig(
      { server: {}, database: {}, gateway: { baseUrl: 'http://old' }, runner: {}, ops: {} },
      { GATEWAY_BASE_URL: 'http://new:8080/v1' },
    );
    expect(cfg.gateway.baseUrl).toBe('http://new:8080/v1');
  });

  it('an empty-string env value counts as unset', () => {
    const cfg = buildConfig(
      { server: { port: 9090 }, database: {}, gateway: {}, runner: {}, ops: {} },
      { WORKMILL_PORT: '' },
    );
    expect(cfg.server.port).toBe(9090);
  });
});

// ---------------------------------------------------------------------------
// §J5-4  Secrets are file-forbidden and env-allowed
// ---------------------------------------------------------------------------

describe('buildConfig — secrets are file-forbidden', () => {
  it('gateway.apiKey in the file throws ConfigError naming GATEWAY_API_KEY', () => {
    const raw = {
      server: {},
      database: {},
      gateway: { apiKey: 'secret123' },
      runner: {},
      ops: {},
    };
    expect(() => buildConfig(raw, {})).toThrow(ConfigError);
    try {
      buildConfig(raw, {});
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      if (err instanceof ConfigError) {
        expect(err.message).toContain('GATEWAY_API_KEY');
      }
    }
  });

  it('ops.operatorToken in the file throws ConfigError naming WORKMILL_OPERATOR_TOKEN', () => {
    const raw = {
      server: {},
      database: {},
      gateway: {},
      runner: {},
      ops: { operatorToken: 'token1234567890ab' },
    };
    expect(() => buildConfig(raw, {})).toThrow(ConfigError);
    try {
      buildConfig(raw, {});
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      if (err instanceof ConfigError) {
        expect(err.message).toContain('WORKMILL_OPERATOR_TOKEN');
      }
    }
  });
});

describe('buildConfig — secrets are env-allowed', () => {
  it('GATEWAY_API_KEY lands on gateway.apiKey from the environment', () => {
    const raw = { server: {}, database: {}, gateway: {}, runner: {}, ops: {} };
    const cfg = buildConfig(raw, { GATEWAY_API_KEY: 'env-api-key' });
    expect(cfg.gateway.apiKey).toBe('env-api-key');
  });

  it('WORKMILL_OPERATOR_TOKEN lands on ops.operatorToken from the environment', () => {
    const raw = { server: {}, database: {}, gateway: {}, runner: {}, ops: {} };
    const cfg = buildConfig(raw, { WORKMILL_OPERATOR_TOKEN: 'a'.repeat(16) });
    expect(cfg.ops.operatorToken).toBe('a'.repeat(16));
  });

  it('WORKMILL_OPERATOR_TOKEN shorter than 16 characters throws', () => {
    const raw = { server: {}, database: {}, gateway: {}, runner: {}, ops: {} };
    expect(() => buildConfig(raw, { WORKMILL_OPERATOR_TOKEN: 'short' })).toThrow(ConfigError);
    try {
      buildConfig(raw, { WORKMILL_OPERATOR_TOKEN: 'short' });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      if (err instanceof ConfigError) {
        expect(err.path).toBe('ops.operatorToken');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// §J5-5  Typos are refused
// ---------------------------------------------------------------------------

describe('buildConfig — unknown top-level section', () => {
  it('throws ConfigError carrying the offending section name', () => {
    const raw = {
      server: {},
      database: {},
      gateway: {},
      runner: {},
      ops: {},
      flimflam: { foo: 'bar' },
    } as Record<string, unknown>;
    expect(() => buildConfig(raw, {})).toThrow(ConfigError);
    try {
      buildConfig(raw, {});
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      if (err instanceof ConfigError) {
        expect(err.path).toBe('flimflam');
      }
    }
  });
});

describe('buildConfig — unknown key inside a known section', () => {
  it('throws ConfigError carrying the dotted path', () => {
    const raw = {
      server: { host: '0.0.0.0', bloop: 'x' },
      database: {},
      gateway: {},
      runner: {},
      ops: {},
    };
    expect(() => buildConfig(raw, {})).toThrow(ConfigError);
    try {
      buildConfig(raw, {});
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      if (err instanceof ConfigError) {
        expect(err.path).toBe('server.bloop');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// §J5-6  Values are checked
// ---------------------------------------------------------------------------

describe('buildConfig — values are validated', () => {
  it('server.port of 0 throws ConfigError', () => {
    const raw = {
      server: { port: 0 },
      database: {},
      gateway: {},
      runner: {},
      ops: {},
    };
    expect(() => buildConfig(raw, {})).toThrow(ConfigError);
    try {
      buildConfig(raw, {});
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      if (err instanceof ConfigError) {
        expect(err.path).toBe('server.port');
      }
    }
  });

  it('gateway.baseUrl of ftp://x throws ConfigError', () => {
    const raw = {
      server: {},
      database: {},
      gateway: { baseUrl: 'ftp://x' },
      runner: {},
      ops: {},
    };
    expect(() => buildConfig(raw, {})).toThrow(ConfigError);
  });

  it('runner.enabled of "maybe" throws ConfigError', () => {
    const raw = {
      server: {},
      database: {},
      gateway: {},
      runner: { enabled: 'maybe' },
      ops: {},
    };
    expect(() => buildConfig(raw, {})).toThrow(ConfigError);
    try {
      buildConfig(raw, {});
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      if (err instanceof ConfigError) {
        expect(err.path).toBe('runner.enabled');
      }
    }
  });

  it('a trailing slash on baseUrl is stripped', () => {
    const raw = {
      server: {},
      database: {},
      gateway: { baseUrl: 'http://localhost:8080/v1/' },
      runner: {},
      ops: {},
    };
    const cfg = buildConfig(raw, {});
    expect(cfg.gateway.baseUrl).toBe('http://localhost:8080/v1');
  });
});
