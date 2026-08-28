/**
 * Validating a model's output against a workflow's stored JSON Schema
 * (SPEC.md feature 4), plus the parse step that gets there.
 *
 * A deliberately small validator, not a JSON Schema implementation. Workflows
 * store a schema as tenant data, so the validator has to be something a reader
 * can hold in their head: the keywords below and nothing else. Unsupported
 * keywords are IGNORED rather than refused — a schema is a contract the tenant
 * writes, and failing a run because the validator met `minLength` would be a
 * worse outcome than not checking that one bound.
 *
 * Supported: `type` (object, array, string, number, integer, boolean, null, or
 * an array of those), `properties`, `required`, `additionalProperties` (boolean
 * form only), `items`, `enum`.
 *
 * Nothing here compiles, evaluates or executes anything: the validator walks
 * plain data, and `parseJsonObject` uses `JSON.parse`. That is the
 * no-arbitrary-code-execution non-goal holding at the last hop before a model's
 * text becomes a stored result.
 */

export interface ValidationOk {
  valid: true;
}

export interface ValidationFailure {
  valid: false;
  /** Human-readable, one per problem, each naming the path it was found at. */
  errors: string[];
}

export type ValidationResult = ValidationOk | ValidationFailure;

/** Thrown when a model's text does not yield a JSON object. */
export class JsonParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsonParseError';
  }
}

/** The JSON type names this validator understands. */
const TYPE_NAMES = [
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
  'null',
] as const;

type TypeName = (typeof TYPE_NAMES)[number];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The JSON type of a value, using the same names a schema uses. */
function typeOf(value: unknown): TypeName {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'boolean':
      return 'boolean';
    case 'number':
      return Number.isInteger(value) ? 'integer' : 'number';
    default:
      return 'object';
  }
}

function matchesType(expected: TypeName, value: unknown): boolean {
  // An integer is a number; a number with a fraction is not an integer.
  if (expected === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (expected === 'integer') return typeof value === 'number' && Number.isInteger(value);
  return typeOf(value) === expected;
}

/** JSON-Pointer-ish path for error messages; the root reads `(root)`. */
function label(path: string): string {
  return path === '' ? '(root)' : path;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function check(
  schema: unknown,
  value: unknown,
  path: string,
  errors: string[],
): void {
  // A non-object schema (or `true`) constrains nothing.
  if (!isPlainObject(schema)) return;

  const declared = schema['type'];
  const expected: string[] = Array.isArray(declared)
    ? declared.filter((t): t is string => typeof t === 'string')
    : typeof declared === 'string'
      ? [declared]
      : [];
  const known = expected.filter((t): t is TypeName =>
    (TYPE_NAMES as readonly string[]).includes(t),
  );

  if (known.length > 0 && !known.some((t) => matchesType(t, value))) {
    errors.push(
      `${label(path)}: expected ${known.join(' or ')}, got ${typeOf(value)}`,
    );
    // The value is the wrong shape; deeper checks would only add noise.
    return;
  }

  const allowed = schema['enum'];
  if (Array.isArray(allowed) && !allowed.some((option) => sameJson(option, value))) {
    errors.push(
      `${label(path)}: ${JSON.stringify(value)} is not one of ${JSON.stringify(allowed)}`,
    );
  }

  if (isPlainObject(value)) {
    const required = schema['required'];
    if (Array.isArray(required)) {
      for (const key of required) {
        if (typeof key === 'string' && !Object.hasOwn(value, key)) {
          errors.push(`${label(path)}: missing required property "${key}"`);
        }
      }
    }

    const properties = schema['properties'];
    const declaredKeys = isPlainObject(properties) ? Object.keys(properties) : [];
    if (isPlainObject(properties)) {
      for (const [key, subSchema] of Object.entries(properties)) {
        if (Object.hasOwn(value, key)) {
          check(subSchema, value[key], `${path}/${key}`, errors);
        }
      }
    }

    // Only the boolean form is supported; a schema-valued
    // `additionalProperties` is treated as "anything goes".
    if (schema['additionalProperties'] === false) {
      for (const key of Object.keys(value)) {
        if (!declaredKeys.includes(key)) {
          errors.push(`${label(path)}: unexpected property "${key}"`);
        }
      }
    }
  }

  if (Array.isArray(value) && Object.hasOwn(schema, 'items')) {
    const items = schema['items'];
    value.forEach((element, index) => {
      check(items, element, `${path}/${index}`, errors);
    });
  }
}

/**
 * Validate a value against the supported subset of a JSON Schema.
 *
 * Returns a result rather than throwing: an output that does not match its
 * schema is an ordinary outcome of a model call (SPEC.md feature 4 makes it a
 * first-class failure state), not an exceptional one. Every problem found is
 * reported, because the re-ask that follows is more likely to succeed when it
 * can name all of them at once.
 */
export function validateAgainstSchema(
  schema: Record<string, unknown>,
  value: unknown,
): ValidationResult {
  const errors: string[] = [];
  check(schema, value, '', errors);
  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

/** Strip one ```json … ``` fence, if the whole text is wrapped in one. */
function stripCodeFence(text: string): string {
  const fenced = /^```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n?```$/.exec(text.trim());
  return fenced?.[1] ?? text;
}

/**
 * Read a JSON object out of a model's reply.
 *
 * Chat models wrap JSON in prose and code fences however they please, so the
 * text is tried three ways: as-is, with one code fence removed, and as the span
 * from the first `{` to the last `}`. Throws `JsonParseError` when none of
 * those yields a JSON *object* — an array or a bare number is not a result
 * this product can store against an object schema.
 */
export function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const unfenced = stripCodeFence(trimmed).trim();

  const candidates = [trimmed, unfenced];
  const first = unfenced.indexOf('{');
  const last = unfenced.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(unfenced.slice(first, last + 1));

  for (const candidate of candidates) {
    if (candidate === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (isPlainObject(parsed)) return parsed;
    throw new JsonParseError(`expected a JSON object, got ${typeOf(parsed)}`);
  }

  throw new JsonParseError('no JSON object found in the model output');
}
