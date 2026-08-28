import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Engine } from '../src/db/engine.js';
import { withTenant } from '../src/seam/withTenant.js';
import { freshDb, makeTenant } from './helpers/db.js';
import {
  EXAMPLE_WORKFLOWS,
  seedExampleWorkflows,
} from '../src/workflows/examples.js';
import { assertValidDefinition, InvalidWorkflowError } from '../src/workflows/store.js';
import { assertRenderable, TemplateError } from '../src/workflows/render.js';
import { listWorkflows } from '../src/workflows/store.js';

/**
 * Proves `seedExampleWorkflows` and `EXAMPLE_WORKFLOWS` in
 * `src/workflows/examples.ts`, plus `assertValidDefinition` in
 * `src/workflows/store.ts` and `assertRenderable` in `src/workflows/render.ts`.
 *
 * Patterned after test/workflows.test.ts: same beforeAll/afterAll shape
 * (freshDb, db.close) and withTenant/makeTenant usage.
 */

let db: Engine;

beforeAll(async () => {
  db = await freshDb();
});

afterAll(async () => {
  await db?.close();
});

describe('EXAMPLE_WORKFLOWS has exactly three entries with the expected slugs', () => {
  it('array length is 3; slugs are extract, classify, summarize', () => {
    expect(EXAMPLE_WORKFLOWS).toHaveLength(3);
    expect(EXAMPLE_WORKFLOWS.map((wf) => wf.slug)).toEqual([
      'extract',
      'classify',
      'summarize',
    ]);
  });
});

describe('every example passes assertValidDefinition without throwing', () => {
  it('loops over EXAMPLE_WORKFLOWS — no individual cases needed', () => {
    for (const wf of EXAMPLE_WORKFLOWS) {
      expect(() => assertValidDefinition(wf)).not.toThrow(InvalidWorkflowError);
    }
  });
});

describe('every example prompt template passes assertRenderable', () => {
  it('each template carries {{input}} and no unknown placeholder', () => {
    for (const wf of EXAMPLE_WORKFLOWS) {
      expect(() => assertRenderable(wf.promptTemplate)).not.toThrow(TemplateError);
    }
  });
});

describe('seedExampleWorkflows creates three workflows at version 1', () => {
  it('listWorkflows returns three entries, each at currentVersion 1', async () => {
    const { id: tenantId } = await makeTenant(db, 'seed-single');

    await withTenant(db, tenantId, (sql) => seedExampleWorkflows(sql));

    const workflows = await withTenant(db, tenantId, (sql) =>
      listWorkflows(sql),
    );

    expect(workflows).toHaveLength(3);
    for (const wf of workflows) {
      expect(wf.currentVersion).toBe(1);
    }
  });
});

describe('classify output schema names a closed label set', () => {
  it('some property in outputSchema has an enum array with at least two entries', () => {
    const classify = EXAMPLE_WORKFLOWS.find((wf) => wf.slug === 'classify');
    expect(classify).toBeDefined();

    const schema = classify!.outputSchema as Record<string, unknown>;
    const props = schema.properties as Record<string, unknown> | undefined;
    expect(props).toBeDefined();

    // Walk properties looking for an enum array with length >= 2.
    let found = false;
    if (props && typeof props === 'object') {
      for (const _key of Object.keys(props)) {
        const propDef = props[_key] as Record<string, unknown>;
        const enumArr = propDef.enum;
        if (
          Array.isArray(enumArr) &&
          enumArr.length >= 2
        ) {
          found = true;
          break;
        }
      }
    }
    expect(found).toBe(true);
  });
});

describe('two tenants can each seed examples — slugs are per-tenant', () => {
  it('both tenants end up with three workflows; no slug collision', async () => {
    const { id: tenantA } = await makeTenant(db, 'seed-a');
    const { id: tenantB } = await makeTenant(db, 'seed-b');

    await withTenant(db, tenantA, (sql) => seedExampleWorkflows(sql));
    await withTenant(db, tenantB, (sql) => seedExampleWorkflows(sql));

    const workflowsA = await withTenant(db, tenantA, (sql) =>
      listWorkflows(sql),
    );
    const workflowsB = await withTenant(db, tenantB, (sql) =>
      listWorkflows(sql),
    );

    expect(workflowsA).toHaveLength(3);
    expect(workflowsB).toHaveLength(3);
    expect(workflowsA.map((wf) => wf.slug).sort()).toEqual([
      'classify',
      'extract',
      'summarize',
    ]);
    expect(workflowsB.map((wf) => wf.slug).sort()).toEqual([
      'classify',
      'extract',
      'summarize',
    ]);
  });
});
