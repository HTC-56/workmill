/**
 * A YAML reader for exactly the shape workmill's config file takes, and nothing
 * else (SPEC.md feature 9, "YAML config").
 *
 * Why not a YAML library: the dependency surface is deliberately tiny, and a
 * config file that a person hand-edits needs perhaps five of YAML's features.
 * Full YAML is a large language with anchors, tags, merge keys and five string
 * styles; supporting all of it here would be a bigger liability than the
 * hundred lines below. So this reader implements a documented SUBSET and
 * REFUSES everything outside it, loudly, with a line number. A config file
 * quietly parsed into the wrong thing is the failure mode worth spending
 * strictness on.
 *
 * The subset, in full:
 *
 *   - Mappings of `key: value`, nested by indentation (spaces only, any even
 *     step; a tab anywhere is an error, because a tab's width is a matter of
 *     opinion and indentation here is meaning).
 *   - Block sequences of scalars: `- item` lines indented under their key.
 *   - Scalars: `true` / `false`, `null` / `~`, integers, decimals, single- or
 *     double-quoted strings, and bare text (taken literally, trailing spaces
 *     trimmed).
 *   - `#` comments, whole-line or trailing, honoured outside quotes only.
 *
 * Refused, each with its own message: tabs, flow collections (`{a: 1}`,
 * `[1, 2]`), anchors and aliases (`&x`, `*x`), tags (`!!str`), multi-line
 * scalars (`|`, `>`), documents (`---`), mappings nested inside sequences,
 * duplicate keys, and any line that is not a comment, a `key:` or a `- item`.
 */

export class YamlError extends Error {
  constructor(
    readonly line: number,
    problem: string,
  ) {
    super(`config line ${line}: ${problem}`);
    this.name = 'YamlError';
  }
}

interface SourceLine {
  /** 1-based, so an error message points at what a person sees in an editor. */
  readonly n: number;
  readonly indent: number;
  readonly text: string;
}

/** `key: value`, where the key is a plain scalar — the only kind this accepts. */
const KEY_RE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)[ \t]*:(.*)$/;
const SEQ_RE = /^-(?:[ \t]+(.*))?$/;
const INT_RE = /^-?(?:0|[1-9][0-9]*)$/;
const DECIMAL_RE = /^-?(?:0|[1-9][0-9]*)\.[0-9]+$/;

/**
 * Drop a trailing `#` comment, respecting quotes.
 *
 * A `#` only starts a comment at the start of the line or after whitespace —
 * `http://localhost:8080/v1#frag` keeps its fragment, and so does any bare
 * string with a hash in the middle of it.
 */
function stripComment(raw: string, n: number): string {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote !== null) {
      if (ch === '\\' && quote === '"') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || raw[i - 1] === ' ' || raw[i - 1] === '\t')) {
      return raw.slice(0, i);
    }
  }
  if (quote !== null) throw new YamlError(n, 'unterminated quoted string');
  return raw;
}

function readLines(source: string): SourceLine[] {
  const out: SourceLine[] = [];
  const raw = source.split(/\r?\n/);
  for (let i = 0; i < raw.length; i++) {
    const physical = raw[i] ?? '';
    const n = i + 1;
    if (physical.includes('\t')) {
      throw new YamlError(n, 'tabs are not valid indentation; use spaces');
    }
    const body = stripComment(physical, n).replace(/\s+$/, '');
    if (body === '') continue;
    if (body.startsWith('---') || body.startsWith('...')) {
      throw new YamlError(n, 'document markers are not supported');
    }
    const indent = body.length - body.trimStart().length;
    out.push({ n, indent, text: body.trimStart() });
  }
  return out;
}

function unquote(raw: string, n: number): string {
  const body = raw.slice(1, -1);
  if (raw.startsWith("'")) {
    // Single quotes are literal; the only escape YAML gives them is '' for '.
    return body.replace(/''/g, "'");
  }
  return body.replace(/\\(.)/g, (_all, ch: string) => {
    switch (ch) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case '\\':
        return '\\';
      case '"':
        return '"';
      default:
        throw new YamlError(n, `unknown escape \\${ch}`);
    }
  });
}

/** One scalar. Everything this reader refuses is refused here or in readLines. */
export function parseScalar(raw: string, n: number): unknown {
  const text = raw.trim();
  if (text === '') return null;

  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' || first === "'") && last === first) return unquote(text, n);
    if (first === '"' || first === "'") throw new YamlError(n, 'unterminated quoted string');
  }
  if (text.startsWith('{') || text.startsWith('[')) {
    throw new YamlError(n, 'flow collections are not supported; use block style');
  }
  if (text.startsWith('&') || text.startsWith('*')) {
    throw new YamlError(n, 'anchors and aliases are not supported');
  }
  if (text.startsWith('!')) throw new YamlError(n, 'tags are not supported');
  if (text === '|' || text === '>') {
    throw new YamlError(n, 'multi-line scalars are not supported');
  }

  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null' || text === '~') return null;
  if (INT_RE.test(text)) return Number.parseInt(text, 10);
  if (DECIMAL_RE.test(text)) return Number.parseFloat(text);
  return text;
}

interface Cursor {
  readonly lines: readonly SourceLine[];
  index: number;
}

function peek(cursor: Cursor): SourceLine | undefined {
  return cursor.lines[cursor.index];
}

function parseSequence(cursor: Cursor, indent: number): unknown[] {
  const items: unknown[] = [];
  for (;;) {
    const line = peek(cursor);
    if (line === undefined || line.indent < indent) return items;
    if (line.indent > indent) throw new YamlError(line.n, 'unexpected indentation');
    const match = SEQ_RE.exec(line.text);
    if (match === null) return items;
    const value = match[1];
    if (value === undefined) {
      throw new YamlError(line.n, 'a list item must be a scalar on its own line');
    }
    if (KEY_RE.test(value)) {
      throw new YamlError(line.n, 'mappings inside lists are not supported');
    }
    items.push(parseScalar(value, line.n));
    cursor.index++;
  }
}

function parseMapping(cursor: Cursor, indent: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (;;) {
    const line = peek(cursor);
    if (line === undefined || line.indent < indent) return out;
    if (line.indent > indent) throw new YamlError(line.n, 'unexpected indentation');
    if (SEQ_RE.test(line.text)) {
      throw new YamlError(line.n, 'a list item here has no key above it');
    }

    const match = KEY_RE.exec(line.text);
    if (match === null) throw new YamlError(line.n, `not a "key: value" line: ${line.text}`);
    const key = match[1] as string;
    const inline = (match[2] ?? '').trim();
    if (Object.hasOwn(out, key)) throw new YamlError(line.n, `duplicate key "${key}"`);
    cursor.index++;

    if (inline !== '') {
      out[key] = parseScalar(inline, line.n);
      continue;
    }

    // An empty value means "look below": a deeper line opens a nested block,
    // and anything else means the key is genuinely null.
    const next = peek(cursor);
    if (next === undefined || next.indent <= indent) {
      out[key] = null;
      continue;
    }
    out[key] = SEQ_RE.test(next.text)
      ? parseSequence(cursor, next.indent)
      : parseMapping(cursor, next.indent);
  }
}

/**
 * Parse the subset. Always returns a mapping — a config file that is a bare
 * scalar or a bare list is a mistake, not a configuration.
 */
export function parseYaml(source: string): Record<string, unknown> {
  const lines = readLines(source);
  if (lines.length === 0) return {};
  const first = lines[0] as SourceLine;
  if (first.indent !== 0) throw new YamlError(first.n, 'the first line must not be indented');

  const cursor: Cursor = { lines, index: 0 };
  const value = parseMapping(cursor, 0);
  const leftover = peek(cursor);
  if (leftover !== undefined) throw new YamlError(leftover.n, 'unexpected indentation');
  return value;
}
