import { describe, expect, it } from 'vitest';
import { parseYaml, parseScalar, YamlError } from '../src/config/yaml.js';

/**
 * Proves `parseYaml`, `parseScalar`, and `YamlError` in
 * `src/config/yaml.ts`: nesting, comments, block sequences, nulls,
 * every refusal on the right line, and edge cases.
 *
 * No database — pure function tests only.
 */

describe('parseYaml handles nesting and types', () => {
  it('parses two sections with key-value pairs into nested objects', () => {
    const doc = `
server:
  host: localhost
  port: 8080
database:
  url: postgres://db
  pool_size: 5
`.trim();
    const result = parseYaml(doc);
    expect(result).toEqual({
      server: { host: 'localhost', port: 8080 },
      database: { url: 'postgres://db', pool_size: 5 },
    });
  });

  it('booleans true and false land as booleans', () => {
    const doc = 'debug: true\nstrict: false';
    const result = parseYaml(doc);
    expect(result).toEqual({ debug: true, strict: false });
  });

  it('null and ~ both parse to null', () => {
    const doc = 'a: null\nb: ~';
    const result = parseYaml(doc);
    expect(result).toEqual({ a: null, b: null });
  });

  it('a double-quoted string preserves spaces inside quotes', () => {
    const doc = 'label: "hello world"';
    const result = parseYaml(doc);
    expect(result).toEqual({ label: 'hello world' });
  });
});

describe('parseYaml drops comments but preserves hashes in strings', () => {
  it('drops a whole-line comment', () => {
    const doc = `
# this is a comment
key: value
`.trim();
    const result = parseYaml(doc);
    expect(result).toEqual({ key: 'value' });
  });

  it('drops a trailing comment', () => {
    const doc = 'key: value # trailing note';
    const result = parseYaml(doc);
    expect(result).toEqual({ key: 'value' });
  });

  it('keeps # inside a quoted string', () => {
    const doc = 'label: "hash # inside"';
    const result = parseYaml(doc);
    expect(result).toEqual({ label: 'hash # inside' });
  });

  it('keeps # in a URL fragment', () => {
    const doc = 'gateway: http://localhost:8080/v1#frag';
    const result = parseYaml(doc);
    expect(result).toEqual({ gateway: 'http://localhost:8080/v1#frag' });
  });
});

describe('parseYaml parses block sequences', () => {
  it('- item lines become an array of scalars in order', () => {
    const doc = `
tags:
  - alpha
  - beta
  - gamma
`.trim();
    const result = parseYaml(doc);
    expect(result).toEqual({ tags: ['alpha', 'beta', 'gamma'] });
  });
});

describe('parseYaml treats empty values as null', () => {
  it('key: with nothing after gives null', () => {
    const doc = 'key:';
    const result = parseYaml(doc);
    expect(result).toEqual({ key: null });
  });
});

describe('parseYaml refuses tabs', () => {
  it('throws YamlError on a tab character', () => {
    const doc = '\tkey: value';
    expect(() => parseYaml(doc)).toThrow(YamlError);
  });
});

describe('parseYaml refuses flow mappings', () => {
  it('throws YamlError on {a: 1} at line 1', () => {
    const doc = 'data: {a: 1}';
    let caught: YamlError | undefined;
    try { parseYaml(doc); } catch (e) { caught = e as YamlError; }
    expect(caught).toBeInstanceOf(YamlError);
    expect(caught!.line).toBe(1);
  });
});

describe('parseYaml refuses flow sequences', () => {
  it('throws YamlError on [1, 2] at line 1', () => {
    const doc = 'nums: [1, 2]';
    let caught: YamlError | undefined;
    try { parseYaml(doc); } catch (e) { caught = e as YamlError; }
    expect(caught).toBeInstanceOf(YamlError);
    expect(caught!.line).toBe(1);
  });
});

describe('parseYaml refuses anchors and aliases', () => {
  it('throws YamlError on &x at line 1', () => {
    const doc = 'data: &x hello';
    let caught: YamlError | undefined;
    try { parseYaml(doc); } catch (e) { caught = e as YamlError; }
    expect(caught).toBeInstanceOf(YamlError);
    expect(caught!.line).toBe(1);
  });
});

describe('parseYaml refuses tags', () => {
  it('throws YamlError on !!str at line 1', () => {
    const doc = 'text: !!str hello';
    let caught: YamlError | undefined;
    try { parseYaml(doc); } catch (e) { caught = e as YamlError; }
    expect(caught).toBeInstanceOf(YamlError);
    expect(caught!.line).toBe(1);
  });
});

describe('parseYaml refuses duplicate keys', () => {
  it('throws YamlError on the second occurrence at line 2', () => {
    const doc = 'key: first\nkey: second';
    let caught: YamlError | undefined;
    try { parseYaml(doc); } catch (e) { caught = e as YamlError; }
    expect(caught).toBeInstanceOf(YamlError);
    expect(caught!.line).toBe(2);
  });
});

describe('parseYaml refuses bare invalid lines', () => {
  it('throws YamlError on a line that is neither key: nor - item', () => {
    const doc = 'just some text without a colon';
    expect(() => parseYaml(doc)).toThrow(YamlError);
  });
});

describe('parseYaml refuses mappings inside lists', () => {
  it('throws YamlError on - key: value at line 2', () => {
    const doc = `
items:
  - key: value
`.trim();
    let caught: YamlError | undefined;
    try { parseYaml(doc); } catch (e) { caught = e as YamlError; }
    expect(caught).toBeInstanceOf(YamlError);
    expect(caught!.line).toBe(2);
  });
});

describe('parseYaml edges', () => {
  it('parseYaml("") returns {}', () => {
    expect(parseYaml('')).toEqual({});
  });

  it('a document of only comments returns {}', () => {
    const doc = '# comment only\n# another';
    expect(parseYaml(doc)).toEqual({});
  });
});

describe('parseScalar edges', () => {
  it('leading zero stays the string "007"', () => {
    expect(parseScalar('007', 1)).toBe('007');
  });

  it('a decimal like "3.5" parses to the number 3.5', () => {
    expect(parseScalar('3.5', 1)).toBe(3.5);
  });
});
