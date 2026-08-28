import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Engine } from '../src/db/engine.js';
import { withTenant } from '../src/seam/withTenant.js';
import { freshDb, makeTenant } from './helpers/db.js';
import {
  createWorkflow,
  listWorkflows,
  getWorkflow,
  InvalidWorkflowError,
  WorkflowNotFoundError,
} from '../src/workflows/store.js';

/**
 * Proves `createWorkflow`, `listWorkflows`, and `getWorkflow` in
 * `src/workflows/store.ts`: creation, defaults, ordering, cross-tenant RLS,
 * and validation errors.
 *
 * Patterned after test/tenancy.test.ts: same beforeAll shape (freshDb) and
 * afterAll shape (db.close).
 */

let db: Engine;

beforeAll(async () => {
  db = await freshDb();
});

afterAll(async () => {
  await db?.close();
});

describe('createWorkflow returns currentVersion=1 and version=1 with non-empty ids', () => {
  it('both ids are non-empty strings; version numbers are 1', async () => {
    const { id: tenantId } = await makeTenant(db, 'version-test');

    const result = await withTenant(db, tenantId, (sql) =>
      createWorkflow(sql, {
        slug: 'extract',
        name: 'Extract',
        promptTemplate: 'Extract fields from {{input}}',
        outputSchema: { type: 'object', properties: { key: { type: 'string' } } },
        model: 'default',
      }),
    );

    expect(result.workflow.id).toBeDefined();
    expect(result.workflow.id.length).toBeGreaterThan(0);
    expect(result.version.id).toBeDefined();
    expect(result.version.id.length).toBeGreaterThan(0);
    expect(result.workflow.currentVersion).toBe(1);
    expect(result.version.version).toBe(1);
  });
});

describe('unset parameters come back as defaults as numbers', () => {
  it('temperature is 0 (number) and maxOutputTokens is 512 (number)', async () => {
    const { id: tenantId } = await makeTenant(db, 'defaults-test');

    const result = await withTenant(db, tenantId, (sql) =>
      createWorkflow(sql, {
        slug: 'defaults',
        name: 'Defaults',
        promptTemplate: 'Process {{input}}',
        outputSchema: { type: 'object', properties: { x: { type: 'number' } } },
        model: 'default',
      }),
    );

    expect(typeof result.version.temperature).toBe('number');
    expect(result.version.temperature).toBe(0);
    expect(typeof result.version.maxOutputTokens).toBe('number');
    expect(result.version.maxOutputTokens).toBe(512);
  });
});

describe('outputSchema round-trips through the database', () => {
  it('returned schema deep-equals what was passed in', async () => {
    const { id: tenantId } = await makeTenant(db, 'roundtrip-test');

    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        score: { type: 'number' },
      },
    };

    const result = await withTenant(db, tenantId, (sql) =>
      createWorkflow(sql, {
        slug: 'roundtrip',
        name: 'Roundtrip',
        promptTemplate: 'Analyze {{input}}',
        outputSchema: schema,
        model: 'default',
      }),
    );

    expect(result.version.outputSchema).toEqual(schema);
  });
});

describe('listWorkflows returns two workflows ordered by slug; second tenant sees zero', () => {
  it('both workflows visible under the creating tenant; zero under a different tenant', async () => {
    const { id: acmeId } = await makeTenant(db, 'list-acme');

    await withTenant(db, acmeId, (sql) =>
      createWorkflow(sql, {
        slug: 'zebra',
        name: 'Zebra Workflow',
        promptTemplate: 'Process {{input}}',
        outputSchema: { type: 'object', properties: { a: { type: 'string' } } },
        model: 'default',
      }),
    );

    await withTenant(db, acmeId, (sql) =>
      createWorkflow(sql, {
        slug: 'alpha',
        name: 'Alpha Workflow',
        promptTemplate: 'Transform {{input}}',
        outputSchema: { type: 'object', properties: { b: { type: 'string' } } },
        model: 'default',
      }),
    );

    const acmeWorkflows = await withTenant(db, acmeId, (sql) =>
      listWorkflows(sql),
    );
    expect(acmeWorkflows).toHaveLength(2);
    expect(acmeWorkflows[0]!.slug).toBe('alpha');
    expect(acmeWorkflows[1]!.slug).toBe('zebra');

    // Provision a second tenant and verify they see nothing.
    const { id: globexId } = await makeTenant(db, 'list-globex');

    const globexWorkflows = await withTenant(db, globexId, (sql) =>
      listWorkflows(sql),
    );
    expect(globexWorkflows).toHaveLength(0);
  });
});

describe('getWorkflow returns the workflow with its current version', () => {
  it('the version matches the one returned by createWorkflow', async () => {
    const { id: tenantId } = await makeTenant(db, 'getter-test');

    const createResult = await withTenant(db, tenantId, (sql) =>
      createWorkflow(sql, {
        slug: 'getter',
        name: 'Getter',
        promptTemplate: 'Get {{input}}',
        outputSchema: { type: 'object', properties: { v: { type: 'string' } } },
        model: 'default',
      }),
    );

    const getResult = await withTenant(db, tenantId, (sql) =>
      getWorkflow(sql, createResult.workflow.id),
    );

    expect(getResult.workflow.id).toBe(createResult.workflow.id);
    expect(getResult.workflow.currentVersion).toBe(1);
    expect(getResult.version.version).toBe(1);
    expect(getResult.version.promptTemplate).toBe('Get {{input}}');
  });

  it('calling getWorkflow under a different tenant rejects with WorkflowNotFoundError', async () => {
    // Create a workflow under tenant A.
    const { id: tenantA } = await makeTenant(db, 'cross-tenant-a');

    const createResult = await withTenant(db, tenantA, (sql) =>
      createWorkflow(sql, {
        slug: 'cross-tenant',
        name: 'Cross Tenant',
        promptTemplate: 'Cross {{input}}',
        outputSchema: { type: 'object', properties: { x: { type: 'string' } } },
        model: 'default',
      }),
    );

    // Now try to get it under tenant B — should reject.
    const { id: tenantB } = await makeTenant(db, 'cross-tenant-b');

    await expect(
      withTenant(db, tenantB, (sql) => getWorkflow(sql, createResult.workflow.id)),
    ).rejects.toThrow(WorkflowNotFoundError);
  });
});

describe('createWorkflow rejects invalid definitions with InvalidWorkflowError', () => {
  it('promptTemplate without {{input}} throws InvalidWorkflowError', async () => {
    const { id: tenantId } = await makeTenant(db, 'no-input-test');

    await expect(
      withTenant(db, tenantId, (sql) =>
        createWorkflow(sql, {
          slug: 'no-input',
          name: 'No Input',
          promptTemplate: 'Just some text with no placeholder',
          outputSchema: { type: 'object', properties: { x: { type: 'string' } } },
          model: 'default',
        }),
      ),
    ).rejects.toThrow(InvalidWorkflowError);
  });

  it('outputSchema with type "array" throws InvalidWorkflowError', async () => {
    const { id: tenantId } = await makeTenant(db, 'bad-schema-test');

    await expect(
      withTenant(db, tenantId, (sql) =>
        createWorkflow(sql, {
          slug: 'bad-schema',
          name: 'Bad Schema',
          promptTemplate: 'Process {{input}}',
          outputSchema: { type: 'array' },
          model: 'default',
        }),
      ),
    ).rejects.toThrow(InvalidWorkflowError);
  });
});
