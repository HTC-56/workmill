/**
 * Rendering a workflow's prompt template.
 *
 * This is where the "no arbitrary code execution" non-goal is enforced. The
 * entire template language is one substitution: every occurrence of `{{input}}`
 * is replaced by the item text verbatim. There is no expression syntax, no
 * conditional, no loop.
 *
 * `assertRenderable` refuses templates that contain unknown `{{…}}`
 * placeholders — silently shipping `{{name}}` to a model is how template
 * logic creeps into a product that promised it has none.
 */

/**
 * Thrown when a template is not renderable: it either lacks the required
 * `{{input}}` placeholder or contains an unknown `{{…}}` placeholder.
 */
export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateError';
  }
}

/**
 * Checks that a template is renderable: it must contain exactly one or more
 * `{{input}}` placeholders and zero unknown `{{…}}` placeholders.
 *
 * Throws `TemplateError` when the template is not renderable.
 */
export function assertRenderable(template: string): void {
  // Find all {{…}} placeholders
  const placeholderRe = /\{\{([^}]+)\}\}/g;
  let match;
  let hasInput = false;
  const unknown: string[] = [];

  while ((match = placeholderRe.exec(template)) !== null) {
    const content = match[1];
    if (content === 'input') {
      hasInput = true;
    } else {
      unknown.push(`{{${content}}}`);
    }
  }

  if (!hasInput) {
    throw new TemplateError(
      'template has no {{input}} placeholder — nothing to substitute',
    );
  }

  if (unknown.length > 0) {
    throw new TemplateError(
      `unknown placeholder${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`,
    );
  }
}

/**
 * Returns the template with every occurrence of `{{input}}` replaced by the
 * item text verbatim.
 *
 * The substituted text is never re-scanned, and special `$&`, `` $` ``, `$1`
 * patterns in the replacement are treated as literal characters — the item
 * lands byte-for-byte.
 */
export function renderPrompt(template: string, input: string): string {
  const placeholder = '{{input}}';
  const parts = template.split(placeholder);
  return parts.join(input);
}
