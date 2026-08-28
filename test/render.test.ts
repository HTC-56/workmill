import { describe, expect, it } from 'vitest';
import { renderPrompt, assertRenderable, TemplateError } from '../src/workflows/render.js';

/**
 * Proves `renderPrompt`, `assertRenderable`, and `TemplateError` in
 * `src/workflows/render.ts`: single and double substitution, dollar-sign
 * safety, no re-scan, and the two assertRenderable failure paths.
 *
 * No database — pure function tests only.
 */

describe('renderPrompt substitutes one {{input}} placeholder', () => {
  it('replaces {{input}} and leaves surrounding text unchanged', () => {
    const template = 'Process this: {{input}} end';
    const result = renderPrompt(template, 'hello world');
    expect(result).toBe('Process this: hello world end');
  });
});

describe('renderPrompt substitutes two {{input}} placeholders', () => {
  it('both occurrences are replaced', () => {
    const template = '{{input}} before and {{input}} after';
    const result = renderPrompt(template, 'X');
    expect(result).toBe('X before and X after');
  });
});

describe('renderPrompt handles $& and $1 in input byte-for-byte', () => {
  it('dollar-sign special patterns land unchanged', () => {
    const template = 'Input: {{input}}';
    const item = 'value with $& and $1 and $`';
    const result = renderPrompt(template, item);
    expect(result).toBe('Input: value with $& and $1 and $`');
  });
});

describe('renderPrompt does not re-scan substituted text', () => {
  it('input that contains {{input}} is inserted once, not re-substituted', () => {
    const template = 'start {{input}} end';
    const item = 'first {{input}} second';
    const result = renderPrompt(template, item);
    expect(result).toBe('start first {{input}} second end');
  });
});

describe('assertRenderable throws TemplateError', () => {
  it('throws for a template with no placeholder at all', () => {
    expect(() => assertRenderable('just plain text')).toThrow(TemplateError);
  });

  it('throws for a template containing {{name}}', () => {
    expect(() => assertRenderable('Hello, {{name}}!')).toThrow(TemplateError);
  });
});

describe('assertRenderable returns for a valid template', () => {
  it('does not throw when only {{input}} is present', () => {
    expect(() => assertRenderable('Say: {{input}}')).not.toThrow();
  });
});
