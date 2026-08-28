/**
 * Bounded re-ask: turning a workflow definition plus one item into a validated
 * result (SPEC.md feature 4).
 *
 * `runCompletion` sends the model up to three attempts (one initial + two
 * re-asks). A bad answer is a returned result, never a throw — the job runner
 * is the layer that decides whether to retry a 5xx or give up.
 *
 * This file imports `renderPrompt` from `../workflows/render.js` to build the
 * user message, `chatCompletion`, `addUsage`, `ZERO_USAGE` and the types from
 * `./client.js`, and `parseJsonObject`, `validateAgainstSchema` and
 * `JsonParseError` from `./schema.js`.
 */

import { renderPrompt } from '../workflows/render.js';
import {
  type GatewayConfig,
  type TokenUsage,
  addUsage,
  ZERO_USAGE,
  chatCompletion,
} from './client.js';
import {
  parseJsonObject,
  validateAgainstSchema,
  JsonParseError,
} from './schema.js';

/**
 * Maximum number of re-ask rounds after the first attempt.
 *
 * SPEC.md bounds the re-ask at two, so one call makes at most three attempts.
 */
export const MAX_REASKS = 2;

/**
 * Parameters passed to `runCompletion`.
 */
export interface CompleteRequest {
  /** Workflow prompt template — `{{input}}` is substituted by `renderPrompt`. */
  promptTemplate: string;
  /** The item text fed into the template. */
  input: string;
  /** JSON Schema the model's output must match. */
  outputSchema: Record<string, unknown>;
  /** Logical model name, looked up in the config's model map. */
  model: string;
  /** Optional temperature forwarded to the gateway. */
  temperature?: number;
  /** Optional max output tokens forwarded to the gateway. */
  maxOutputTokens?: number;
}

/**
 * Discriminated union: the model produced a valid result, or it didn't.
 *
 * On success (`ok: true`) the caller gets the parsed object, the raw text,
 * how many attempts were needed, the summed usage, and the model name.
 *
 * On failure (`ok: false`) the caller gets the reason (`'unparseable'` or
 * `'schema-invalid'`), the errors, plus the same metadata.
 */
export type CompleteResult =
  | {
      ok: true;
      value: Record<string, unknown>;
      raw: string;
      attempts: number;
      usage: TokenUsage;
      model: string;
    }
  | {
      ok: false;
      reason: 'unparseable' | 'schema-invalid';
      errors: string[];
      raw: string;
      attempts: number;
      usage: TokenUsage;
      model: string;
    };

/**
 * Build the system message that instructs the model to return JSON matching
 * the provided schema.
 */
function systemMessage(schema: Record<string, unknown>): string {
  return (
    'Respond with a JSON object that matches this schema. ' +
    'Return ONLY valid JSON — no prose, no markdown fences, no explanation.\n\n' +
    JSON.stringify(schema, null, 2)
  );
}

/**
 * Build the user message for a re-ask, naming the problems found in the
 * previous attempt so the model can fix them.
 */
function reaskUserMessage(problems: string[], attemptNumber: number): string {
  return (
    `Attempt ${attemptNumber} failed validation. ` +
    `Problems: ${problems.join('; ')}. ` +
    'Return a JSON object that fixes all of these issues.'
  );
}

/**
 * Run a completion: send a workflow definition plus one item to the model,
 * with bounded re-ask.
 *
 * The first attempt sends two messages: a system message telling the model to
 * answer with JSON matching the schema (with the schema itself included as JSON
 * text); then a user message holding `renderPrompt(promptTemplate, input)`.
 *
 * Each subsequent attempt appends the model's raw reply as an `assistant`
 * message and a new `user` message naming the problems, then tries again.
 * The conversation grows; it is not rebuilt from scratch.
 *
 * A `GatewayError` from `chatCompletion` is not caught — it propagates.
 * Retrying a 5xx is the job runner's business, not this function's.
 */
export async function runCompletion(
  config: GatewayConfig,
  request: CompleteRequest,
): Promise<CompleteResult> {
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> =
    [
      { role: 'system', content: systemMessage(request.outputSchema) },
      { role: 'user', content: renderPrompt(request.promptTemplate, request.input) },
    ];

  let totalUsage: TokenUsage = ZERO_USAGE;
  let attempts = 0;
  let lastRaw = '';
  let lastModel = request.model;

  for (let round = 0; round <= MAX_REASKS; round++) {
    attempts++;
    const response = await chatCompletion(config, {
      model: request.model,
      messages,
      ...(request.temperature !== undefined && { temperature: request.temperature }),
      ...(request.maxOutputTokens !== undefined && { maxOutputTokens: request.maxOutputTokens }),
    });

    totalUsage = addUsage(totalUsage, response.usage);
    lastRaw = response.content;
    lastModel = response.model;

    // Try to parse JSON
    let parsed: Record<string, unknown>;
    try {
      parsed = parseJsonObject(response.content);
    } catch (err) {
      // Not JSON at all — unparseable
      if (round === MAX_REASKS) {
        return {
          ok: false,
          reason: 'unparseable',
          errors: err instanceof JsonParseError ? [err.message] : ['parse error'],
          raw: lastRaw,
          attempts,
          usage: totalUsage,
          model: lastModel,
        };
      }
      // Re-ask: append raw reply as assistant, then a user message with the problem
      messages.push({ role: 'assistant', content: response.content });
      messages.push({
        role: 'user',
        content: reaskUserMessage(['output was not valid JSON'], round + 1),
      });
      continue;
    }

    // Validate against schema
    const validationResult = validateAgainstSchema(request.outputSchema, parsed);
    if (validationResult.valid) {
      return {
        ok: true,
        value: parsed,
        raw: lastRaw,
        attempts,
        usage: totalUsage,
        model: lastModel,
      };
    }

    // Schema invalid — try again if rounds remain
    if (round === MAX_REASKS) {
      return {
        ok: false,
        reason: 'schema-invalid',
        errors: validationResult.errors,
        raw: lastRaw,
        attempts,
        usage: totalUsage,
        model: lastModel,
      };
    }

    // Re-ask: append raw reply as assistant, then a user message with the problems
    messages.push({ role: 'assistant', content: response.content });
    messages.push({
      role: 'user',
      content: reaskUserMessage(validationResult.errors, round + 1),
    });
  }

  // Should never reach here, but TypeScript wants a return
  throw new Error('runCompletion: unreachable');
}
