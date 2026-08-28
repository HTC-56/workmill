/**
 * The one door to a model (SPEC.md feature 4).
 *
 * workmill never talks to a model server: it speaks the OpenAI-compatible
 * contract to ONE configured base URL — a local-ai-gateway instance in the
 * reference deployment — and that base URL is the only outbound HTTP in
 * `src/`. Everything a tenant can influence (the prompt, the item text) travels
 * as data in the request body; nothing a tenant writes can change where the
 * request goes.
 *
 * Two things this file deliberately does NOT do. It does not decide whether a
 * tenant may use a model — that is entitlement enforcement, and it belongs to
 * the metering phase. And it does not know what a workflow is: it takes
 * messages and returns text plus token usage. Schema validation and the bounded
 * re-ask live one layer up, in `complete.ts`.
 *
 * Transport failure throws; a model that answers badly does not. That line is
 * what makes "invalid-after-retries is a first-class failure state, not an
 * exception" implementable above.
 */

/** Where an unconfigured install looks for its gateway. */
export const DEFAULT_BASE_URL = 'http://localhost:8080/v1';

/** A model call that has not answered in this long is not going to. */
export const DEFAULT_TIMEOUT_MS = 60_000;

export interface GatewayConfig {
  /** OpenAI-compatible root, no trailing slash; `/chat/completions` is appended. */
  readonly baseUrl: string;
  /** Sent as `Authorization: Bearer …`. Most local gateways need no key. */
  readonly apiKey?: string;
  readonly timeoutMs: number;
  /**
   * Logical name → the name the gateway knows. Workflows store logical names so
   * that swapping the model behind `'default'` is a config edit, not a data
   * migration. A name with no mapping is passed through unchanged.
   */
  readonly models: Readonly<Record<string, string>>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  /** A logical model name; `resolveModel` turns it into the wire name. */
  model: string;
  messages: readonly ChatMessage[];
  temperature?: number;
  maxOutputTokens?: number;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface CompletionResponse {
  /** The assistant message text, verbatim. */
  content: string;
  usage: TokenUsage;
  /** The model name the gateway reported running, which may differ from ours. */
  model: string;
  finishReason: string;
  latencyMs: number;
}

/** Base class for every failure of the gateway hop. */
export class GatewayError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GatewayError';
  }
}

/** The gateway did not answer within `timeoutMs`. */
export class GatewayTimeoutError extends GatewayError {
  constructor(public readonly timeoutMs: number) {
    super(`gateway did not answer within ${timeoutMs}ms`);
    this.name = 'GatewayTimeoutError';
  }
}

/** The gateway answered with a non-2xx status. */
export class GatewayHttpError extends GatewayError {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`gateway returned HTTP ${status}: ${body.slice(0, 200)}`);
    this.name = 'GatewayHttpError';
  }
}

/** The gateway answered 2xx with something that is not a chat completion. */
export class GatewayProtocolError extends GatewayError {
  constructor(problem: string) {
    super(`gateway response was not a chat completion: ${problem}`);
    this.name = 'GatewayProtocolError';
  }
}

/** Thrown at config load; a bad base URL must fail loudly, not at first call. */
export class GatewayConfigError extends Error {
  constructor(problem: string) {
    super(`invalid gateway configuration: ${problem}`);
    this.name = 'GatewayConfigError';
  }
}

function parseModelMap(raw: string | undefined): Record<string, string> {
  if (raw === undefined || raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new GatewayConfigError('GATEWAY_MODELS is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new GatewayConfigError('GATEWAY_MODELS must be a JSON object');
  }
  const map: Record<string, string> = {};
  for (const [logical, wire] of Object.entries(parsed)) {
    if (typeof wire !== 'string') {
      throw new GatewayConfigError(`GATEWAY_MODELS.${logical} must be a string`);
    }
    map[logical] = wire;
  }
  return map;
}

/**
 * Build a config from the environment. Every field has a working default, so a
 * clean clone runs against a gateway on localhost with no configuration at all.
 */
export function loadGatewayConfig(
  env: Record<string, string | undefined> = process.env,
): GatewayConfig {
  const baseUrl = (env['GATEWAY_BASE_URL'] ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new GatewayConfigError(`GATEWAY_BASE_URL is not a URL: ${baseUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new GatewayConfigError(`GATEWAY_BASE_URL must be http or https: ${baseUrl}`);
  }

  const rawTimeout = env['GATEWAY_TIMEOUT_MS'];
  const timeoutMs = rawTimeout === undefined ? DEFAULT_TIMEOUT_MS : Number(rawTimeout);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new GatewayConfigError('GATEWAY_TIMEOUT_MS must be a positive integer');
  }

  const apiKey = env['GATEWAY_API_KEY'];
  return {
    baseUrl,
    timeoutMs,
    models: parseModelMap(env['GATEWAY_MODELS']),
    ...(apiKey !== undefined && apiKey !== '' ? { apiKey } : {}),
  };
}

/**
 * Logical name → wire name. Unmapped names pass through unchanged, and the
 * lookup is never applied twice: a mapping cannot chain into another mapping.
 */
export function resolveModel(config: GatewayConfig, logical: string): string {
  return config.models[logical] ?? logical;
}

function readUsage(raw: unknown): TokenUsage {
  // A gateway that omits `usage` costs us the paper trail for that call, not
  // the call. Zeros are recorded and the run continues.
  const usage = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const promptTokens = Number(usage['prompt_tokens'] ?? 0);
  const completionTokens = Number(usage['completion_tokens'] ?? 0);
  const totalRaw = usage['total_tokens'];
  const totalTokens =
    totalRaw === undefined ? promptTokens + completionTokens : Number(totalRaw);
  return {
    promptTokens: Number.isFinite(promptTokens) ? promptTokens : 0,
    completionTokens: Number.isFinite(completionTokens) ? completionTokens : 0,
    totalTokens: Number.isFinite(totalTokens) ? totalTokens : 0,
  };
}

/** Sum token usage across the attempts of one item — the per-job total. */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

/** A usage total with nothing in it — the starting point for `addUsage`. */
export const ZERO_USAGE: TokenUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
};

/**
 * One OpenAI-compatible chat completion against the configured gateway.
 *
 * Throws `GatewayTimeoutError`, `GatewayHttpError` or `GatewayProtocolError`;
 * returns the assistant text and the token usage for everything else. It does
 * not retry — retry policy belongs to the job runner, which is the layer that
 * knows about leases and attempts.
 */
export async function chatCompletion(
  config: GatewayConfig,
  request: CompletionRequest,
): Promise<CompletionResponse> {
  const body: Record<string, unknown> = {
    model: resolveModel(config, request.model),
    messages: request.messages,
    stream: false,
  };
  if (request.temperature !== undefined) body['temperature'] = request.temperature;
  if (request.maxOutputTokens !== undefined) body['max_tokens'] = request.maxOutputTokens;

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.apiKey !== undefined) headers['authorization'] = `Bearer ${config.apiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const startedAt = Date.now();

  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) throw new GatewayTimeoutError(config.timeoutMs);
    throw new GatewayError(`gateway request failed: ${String(error)}`, { cause: error });
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  if (!response.ok) throw new GatewayHttpError(response.status, text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GatewayProtocolError('body was not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new GatewayProtocolError('body was not a JSON object');
  }

  const payload = parsed as Record<string, unknown>;
  const choices = payload['choices'];
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new GatewayProtocolError('no choices in the response');
  }
  const choice = choices[0] as Record<string, unknown> | undefined;
  const message = choice?.['message'] as Record<string, unknown> | undefined;
  const content = message?.['content'];
  if (typeof content !== 'string') {
    throw new GatewayProtocolError('first choice has no message content');
  }

  const reportedModel = payload['model'];
  const finishReason = choice?.['finish_reason'];
  return {
    content,
    usage: readUsage(payload['usage']),
    model: typeof reportedModel === 'string' ? reportedModel : request.model,
    finishReason: typeof finishReason === 'string' ? finishReason : 'unknown',
    latencyMs: Date.now() - startedAt,
  };
}
