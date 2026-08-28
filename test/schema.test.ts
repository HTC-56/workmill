import { describe, expect, it } from 'vitest';
import {
  validateAgainstSchema,
  parseJsonObject,
  JsonParseError,
} from '../src/gateway/schema.js';

/**
 * Proves `validateAgainstSchema`, `parseJsonObject`, and `JsonParseError` in
 * `src/gateway/schema.ts`: type checking, required / additionalProperties /
 * enum enforcement, multiple error reporting, unsupported-keyword ignore, and
 * the three parse strategies.
 *
 * No database — pure function tests only.
 */

// ---------------------------------------------------------------------------
// validateAgainstSchema
// ---------------------------------------------------------------------------

describe('validateAgainstSchema — valid object', () => {
  it('accepts an object matching type, properties, required, and enum', () => {
    const schema = {
      type: 'object',
      properties: {
        role: { type: 'string', enum: ['admin', 'editor'] },
        count: { type: 'integer' },
      },
      required: ['role', 'count'],
    } as Record<string, unknown>;
    const result = validateAgainstSchema(schema, { role: 'admin', count: 3 });
    expect(result).toEqual({ valid: true });
  });
});

describe('validateAgainstSchema — single bad value', () => {
  it('returns valid: false with an errors array naming the property path', () => {
    const schema = {
      type: 'object',
      properties: {
        role: { type: 'string', enum: ['admin', 'editor'] },
      },
      required: ['role'],
    } as Record<string, unknown>;
    const result = validateAgainstSchema(schema, { role: 42 });
    expect(result.valid).toBe(false);
    if (result.valid === false) {
      expect(result.errors.length).toBeGreaterThan(0);
      // Property errors mention the slash path and the property name
      expect(result.errors[0]).toContain('/role');
    }
  });
});

describe('validateAgainstSchema — every problem is reported', () => {
  it('reports a missing required property AND a wrong-typed property', () => {
    const schema = {
      type: 'object',
      properties: {
        role: { type: 'string' },
        count: { type: 'integer' },
      },
      required: ['role', 'count'],
    } as Record<string, unknown>;
    // Missing `role`, `count` is a string (not integer)
    const result = validateAgainstSchema(schema, { count: 'three' });
    expect(result.valid).toBe(false);
    if (result.valid === false) {
      expect(result.errors.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('validateAgainstSchema — integer vs number', () => {
  it('1.5 fails { type: "integer" }', () => {
    const schema = {
      type: 'object',
      properties: { val: { type: 'integer' } },
    } as Record<string, unknown>;
    const result = validateAgainstSchema(schema, { val: 1.5 });
    expect(result.valid).toBe(false);
  });

  it('3 passes { type: "integer" }', () => {
    const schema = {
      type: 'object',
      properties: { val: { type: 'integer' } },
    } as Record<string, unknown>;
    const result = validateAgainstSchema(schema, { val: 3 });
    expect(result).toEqual({ valid: true });
  });
});

describe('validateAgainstSchema — additionalProperties', () => {
  it('refuses an undeclared key when additionalProperties is false', () => {
    const schema = {
      type: 'object',
      properties: { name: { type: 'string' } },
      additionalProperties: false,
    } as Record<string, unknown>;
    const result = validateAgainstSchema(schema, { name: 'A', extra: 1 });
    expect(result.valid).toBe(false);
  });

  it('accepts undeclared keys when additionalProperties is not present', () => {
    const schema = {
      type: 'object',
      properties: { name: { type: 'string' } },
    } as Record<string, unknown>;
    const result = validateAgainstSchema(schema, { name: 'A', extra: 1 });
    expect(result).toEqual({ valid: true });
  });
});

describe('validateAgainstSchema — unsupported keywords are ignored', () => {
  it('does not enforce minLength on a string', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 5 },
      },
    } as Record<string, unknown>;
    const result = validateAgainstSchema(schema, { name: 'A' });
    expect(result).toEqual({ valid: true });
  });
});

// ---------------------------------------------------------------------------
// parseJsonObject
// ---------------------------------------------------------------------------

describe('parseJsonObject — bare JSON', () => {
  it('reads an object from a JSON string', () => {
    const result = parseJsonObject('{"a": 1}');
    expect(result).toEqual({ a: 1 });
  });
});

describe('parseJsonObject — fenced code block', () => {
  it('strips one ```json fence and parses the inner content', () => {
    const result = parseJsonObject('```json\n{"a": 2}\n```');
    expect(result).toEqual({ a: 2 });
  });
});

describe('parseJsonObject — prose around the object', () => {
  it('extracts the object span from first { to last }', () => {
    const result = parseJsonObject('Sure, here is the result: {"a": 3}. Hope that helps!');
    expect(result).toEqual({ a: 3 });
  });
});

describe('parseJsonObject — throws JsonParseError', () => {
  it('throws for a JSON array', () => {
    expect(() => parseJsonObject('[1, 2]')).toThrow(JsonParseError);
  });

  it('throws for text with no JSON object', () => {
    expect(() => parseJsonObject('just words, no JSON')).toThrow(JsonParseError);
  });

  it('throws for an empty string', () => {
    expect(() => parseJsonObject('')).toThrow(JsonParseError);
  });
});
