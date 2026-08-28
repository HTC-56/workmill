import type { Session } from '../db/engine.js';
import type { CreateWorkflowRequest } from './store.js';
import { createWorkflow } from './store.js';

/**
 * Seeded workflow definitions — three examples every tenant gets.
 *
 * These are starting templates, not a recommendation engine: each workflow
 * is a prompt + schema pair that the operator can edit or archive. Nothing
 * runs them automatically; the execution phase (SPEC.md feature 4) owns
 * that. `'default'` is a placeholder logical model name; the gateway phase
 * maps logical names to real ones.
 */
export const EXAMPLE_WORKFLOWS: readonly CreateWorkflowRequest[] = [
  {
    slug: 'extract',
    name: 'Extract fields',
    promptTemplate:
      'Extract the following fields from the input: {{input}} '
      + 'the person\'s name, their email address, and their company. '
      + 'Return only the requested fields.',
    outputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        email: { type: 'string' },
        company: { type: 'string' },
      },
    },
    model: 'default',
  },
  {
    slug: 'classify',
    name: 'Classify text',
    promptTemplate:
      'Classify the following input into exactly one of these categories: '
      + 'spam, marketing, or personal. '
      + '{{input}} '
      + 'Return only the chosen category.',
    outputSchema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['spam', 'marketing', 'personal'],
        },
      },
    },
    model: 'default',
  },
  {
    slug: 'summarize',
    name: 'Summarize document',
    promptTemplate:
      'Read the following document and write a single-paragraph summary that '
      + 'captures the key points. '
      + '{{input}}',
    outputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
      },
    },
    model: 'default',
    maxOutputTokens: 256,
  },
];

/**
 * Create the example workflows for a tenant.
 *
 * No transaction handling — the caller's `withTenant` already owns the
 * session. No state, no logging.
 */
export async function seedExampleWorkflows(
  sql: Session,
): Promise<{ workflowId: string; slug: string }[]> {
  return Promise.all(
    EXAMPLE_WORKFLOWS.map((wf) =>
      createWorkflow(sql, wf).then((result) => ({
        workflowId: result.workflow.id,
        slug: wf.slug,
      })),
    ),
  );
}
