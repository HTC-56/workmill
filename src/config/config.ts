import { readFile } from 'node:fs/promises';
import { DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS, type GatewayConfig } from '../gateway/client.js';
import { DEFAULT_BATCH_SIZE, DEFAULT_LEASE_MS } from '../runner/run.js';
import { DEFAULT_TICK_INTERVAL_MS } from '../runner/schedule.js';
import { parseYaml } from './yaml.js';

/**
 * The one configuration a deployment writes (SPEC.md feature 9).
 *
 * Two rules make this file worth reading:
 *
 * 1. **Every field has a working default.** A clean clone with no config file
 *    and no environment starts against PGlite and a gateway on localhost. The
 *    quickstart's ten minutes are spent on the product, not on YAML.
 * 2. **Secrets are environment-only.** `gateway.apiKey` and `ops.operatorToken`
 *    are REFUSED in the file, with a message saying where they belong. A config
 *    file gets copied into a paste, checked into a repo, and read by a backup;
 *    an environment variable does none of those by accident. Making the file
 *    refuse them is cheaper than remembering not to write them there.
 *
 * The environment wins over the file, always, because that is the direction
 * that lets one unit file serve several instances.
 */

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
}

export interface DatabaseConfig {
  /** Null means PGlite in-process — the zero-setup engine (SPEC.md "Engines"). */
  readonly url: string | null;
}

export interface RunnerScheduleConfig {
  /** False leaves the queue to an external ticker (a systemd timer, a test). */
  readonly enabled: boolean;
  /** Recorded on each claimed job, so an operator can see who took the work. */
  readonly workerId: string;
  readonly intervalMs: number;
  readonly batchSize: number;
  readonly leaseMs: number;
}

export interface OpsConfig {
  /** Where the JSONL ops ledger lands. Null discards it. */
  readonly logPath: string | null;
  /** The static operator bearer. Null disables every operator route. */
  readonly operatorToken: string | null;
}

export interface WorkmillConfig {
  readonly server: ServerConfig;
  readonly database: DatabaseConfig;
  readonly gateway: GatewayConfig;
  readonly runner: RunnerScheduleConfig;
  readonly ops: OpsConfig;
}

/** Thrown for anything the file says that the config cannot mean. */
export class ConfigError extends Error {
  constructor(
    readonly path: string,
    problem: string,
  ) {
    super(`config ${path}: ${problem}`);
    this.name = 'ConfigError';
  }
}

/** Where `loadConfig` looks when nobody names a file. */
export const DEFAULT_CONFIG_PATH = 'workmill.yaml';

/** The environment variable that overrides where the config file lives. */
export const CONFIG_PATH_ENV = 'WORKMILL_CONFIG';

/** Minimum length for the operator bearer; matches `src/server/auth.ts`. */
export const MIN_OPERATOR_TOKEN_LENGTH = 16;

export const DEFAULT_SERVER_PORT = 3000;

/**
 * Loopback by default. A deployment that wants to be reachable says so; a
 * developer who forgets has not accidentally published their queue.
 */
export const DEFAULT_SERVER_HOST = '127.0.0.1';

/** Aliased, not redefined: the scheduler owns this number. */
export const DEFAULT_RUNNER_INTERVAL_MS = DEFAULT_TICK_INTERVAL_MS;

/** Keys accepted under each section. Anything else is a typo worth refusing. */
const SECTIONS: Readonly<Record<string, readonly string[]>> = {
  server: ['host', 'port'],
  database: ['url'],
  gateway: ['baseUrl', 'timeoutMs', 'models'],
  runner: ['enabled', 'workerId', 'intervalMs', 'batchSize', 'leaseMs'],
  ops: ['logPath'],
};

/** Fields the file may never carry, and where each one belongs instead. */
const SECRET_KEYS: Readonly<Record<string, string>> = {
  'gateway.apiKey': 'GATEWAY_API_KEY',
  'ops.operatorToken': 'WORKMILL_OPERATOR_TOKEN',
};

function section(raw: Record<string, unknown>, name: string): Record<string, unknown> {
  const value = raw[name];
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError(name, 'must be a block of settings');
  }
  const known = SECTIONS[name] as readonly string[];
  for (const key of Object.keys(value)) {
    const dotted = `${name}.${key}`;
    if (dotted in SECRET_KEYS) {
      throw new ConfigError(dotted, `is a secret; set ${SECRET_KEYS[dotted]} in the environment`);
    }
    if (!known.includes(key)) {
      throw new ConfigError(dotted, `unknown setting; expected one of ${known.join(', ')}`);
    }
  }
  return value as Record<string, unknown>;
}

function asString(raw: unknown, path: string, fallback: string): string {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ConfigError(path, 'must be a non-empty string');
  }
  return raw.trim();
}

function asOptionalString(raw: unknown, path: string, fallback: string | null): string | null {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ConfigError(path, 'must be a non-empty string');
  }
  return raw.trim();
}

function asPositiveInt(raw: unknown, path: string, fallback: number): number {
  if (raw === undefined || raw === null) return fallback;
  const value = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new ConfigError(path, 'must be a whole number of at least 1');
  }
  return value;
}

function asBoolean(raw: unknown, path: string, fallback: boolean): boolean {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new ConfigError(path, 'must be true or false');
}

function asModelMap(raw: unknown, path: string): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(path, 'must be a block of logical-name: wire-name pairs');
  }
  const out: Record<string, string> = {};
  for (const [logical, wire] of Object.entries(raw)) {
    if (typeof wire !== 'string' || wire.trim() === '') {
      throw new ConfigError(`${path}.${logical}`, 'must be a non-empty string');
    }
    out[logical] = wire.trim();
  }
  return out;
}

function asHttpUrl(raw: unknown, path: string, fallback: string): string {
  const text = asString(raw, path, fallback).replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ConfigError(path, `is not a URL: ${text}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(path, `must be http or https: ${text}`);
  }
  return text;
}

function parseModelMapEnv(raw: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError('gateway.models', 'GATEWAY_MODELS is not valid JSON');
  }
  return asModelMap(parsed, 'gateway.models');
}

export type Env = Readonly<Record<string, string | undefined>>;

function envText(env: Env, name: string): string | undefined {
  const raw = env[name];
  return raw === undefined || raw.trim() === '' ? undefined : raw.trim();
}

/**
 * Turn a parsed file plus an environment into the config, with no filesystem
 * and no clock in sight. This is the whole of the merge policy, so it is the
 * half worth testing directly.
 */
export function buildConfig(raw: Record<string, unknown>, env: Env = {}): WorkmillConfig {
  for (const key of Object.keys(raw)) {
    if (!(key in SECTIONS)) {
      throw new ConfigError(key, `unknown section; expected one of ${Object.keys(SECTIONS).join(', ')}`);
    }
  }

  const server = section(raw, 'server');
  const database = section(raw, 'database');
  const gateway = section(raw, 'gateway');
  const runner = section(raw, 'runner');
  const ops = section(raw, 'ops');

  const operatorToken = envText(env, 'WORKMILL_OPERATOR_TOKEN') ?? null;
  if (operatorToken !== null && operatorToken.length < MIN_OPERATOR_TOKEN_LENGTH) {
    throw new ConfigError(
      'ops.operatorToken',
      `WORKMILL_OPERATOR_TOKEN must be at least ${MIN_OPERATOR_TOKEN_LENGTH} characters`,
    );
  }
  const apiKey = envText(env, 'GATEWAY_API_KEY');
  const modelsEnv = envText(env, 'GATEWAY_MODELS');

  return {
    server: {
      host: asString(envText(env, 'WORKMILL_HOST') ?? server['host'], 'server.host', DEFAULT_SERVER_HOST),
      port: asPositiveInt(
        envText(env, 'WORKMILL_PORT') ?? server['port'],
        'server.port',
        DEFAULT_SERVER_PORT,
      ),
    },
    database: {
      url: asOptionalString(envText(env, 'DATABASE_URL') ?? database['url'], 'database.url', null),
    },
    gateway: {
      baseUrl: asHttpUrl(
        envText(env, 'GATEWAY_BASE_URL') ?? gateway['baseUrl'],
        'gateway.baseUrl',
        DEFAULT_BASE_URL,
      ),
      timeoutMs: asPositiveInt(
        envText(env, 'GATEWAY_TIMEOUT_MS') ?? gateway['timeoutMs'],
        'gateway.timeoutMs',
        DEFAULT_TIMEOUT_MS,
      ),
      models: modelsEnv === undefined ? asModelMap(gateway['models'], 'gateway.models') : parseModelMapEnv(modelsEnv),
      ...(apiKey !== undefined ? { apiKey } : {}),
    },
    runner: {
      enabled: asBoolean(
        envText(env, 'WORKMILL_RUNNER_ENABLED') ?? runner['enabled'],
        'runner.enabled',
        true,
      ),
      workerId: asString(
        envText(env, 'WORKMILL_WORKER_ID') ?? runner['workerId'],
        'runner.workerId',
        'workmill-1',
      ),
      intervalMs: asPositiveInt(
        envText(env, 'WORKMILL_RUNNER_INTERVAL_MS') ?? runner['intervalMs'],
        'runner.intervalMs',
        DEFAULT_RUNNER_INTERVAL_MS,
      ),
      batchSize: asPositiveInt(runner['batchSize'], 'runner.batchSize', DEFAULT_BATCH_SIZE),
      leaseMs: asPositiveInt(runner['leaseMs'], 'runner.leaseMs', DEFAULT_LEASE_MS),
    },
    ops: {
      logPath: asOptionalString(envText(env, 'WORKMILL_OPS_LOG') ?? ops['logPath'], 'ops.logPath', null),
      operatorToken,
    },
  };
}

/** The config with nothing configured: what a clean clone runs on. */
export function defaultConfig(): WorkmillConfig {
  return buildConfig({}, {});
}

export interface LoadConfigOptions {
  /** Explicit path. Falls back to `$WORKMILL_CONFIG`, then `./workmill.yaml`. */
  readonly path?: string;
  readonly env?: Env;
}

/**
 * Read the config file if there is one, then merge the environment over it.
 *
 * A missing file is not an error when nobody asked for a particular one — that
 * is the zero-config path. A missing file that WAS asked for is an error, since
 * silently ignoring `--config` is how a deployment ends up running on defaults
 * nobody chose.
 */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<WorkmillConfig> {
  const env = options.env ?? process.env;
  const explicit = options.path ?? envText(env, CONFIG_PATH_ENV);
  const path = explicit ?? DEFAULT_CONFIG_PATH;

  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' && explicit === undefined) return buildConfig({}, env);
    if (code === 'ENOENT') throw new ConfigError(path, 'no such file');
    throw error;
  }
  return buildConfig(parseYaml(source), env);
}

/** The gateway half, for the runner and the console's fleet probe. */
export function gatewayFromConfig(config: WorkmillConfig): GatewayConfig {
  return config.gateway;
}
