import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Engine } from '../src/db/engine.js';
import { withTenant } from '../src/seam/withTenant.js';
import { freshDb, makeTenant } from './helpers/db.js';
import {
  createWorkflow,
  listWorkflows,
  getWorkflow,
  updateWorkflow,
  getWorkflowVersion,
  listWorkflowVersions,
  renameWorkflow,
  archiveWorkflow,
  InvalidWorkflowError,
  WorkflowNotFoundError,
} from '../src/workflows/store.js';
import { enqueueOrder } from '../src/queue/enqueue.js';

/**
 * Proves `createWorkflow`, `listWorkflows`, `getWorkflow`, `updateWorkflow`,
 * `getWorkflowVersion`, `listWorkflowVersions`, `renameWorkflow`,
 * `archiveWorkflow`, and `enqueueOrder` with `workflowVersionId` in
 * `src/workflows/store.ts` and `src/queue/enqueue.ts`: creation, defaults,
 * ordering, cross-tenant RLS, validation errors, versioning, archiving, and
 * the version pin.
 *
 * Patterned after test/tenancy.test.ts: same beforeAll shape (freshDb) and
 * afterAll shape (db.close). §C7 cases appended below §C6 cases.
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

// §C7 — versioning, archiving, the pin

describe('updateWorkflow returns version 2 with a new id; getWorkflow reports currentVersion 2', () => {
  it('version 2 has a different definition id and updated template', async () => {
    const { id: tenantId } = await makeTenant(db, 'update-v1');

    const createResult = await withTenant(db, tenantId, (sql) =>
      createWorkflow(sql, {
        slug: 'update-test',
        name: 'Update Test',
        promptTemplate: 'Original {{input}}',
        outputSchema: { type: 'object', properties: { x: { type: 'string' } } },
        model: 'default',
      }),
    );

    expect(createResult.workflow.currentVersion).toBe(1);
    expect(createResult.version.version).toBe(1);
    const v1Id = createResult.version.id;

    // Update the workflow to version 2.
    const updateResult = await withTenant(db, tenantId, (sql) =>
      updateWorkflow(sql, createResult.workflow.id, {
        promptTemplate: 'Updated {{input}}',
        outputSchema: { type: 'object', properties: { y: { type: 'number' } } },
        model: 'default',
      }),
    );

    expect(updateResult.version).toBe(2);
    expect(updateResult.id).not.toBe(v1Id);
    expect(updateResult.promptTemplate).toBe('Updated {{input}}');

    // getWorkflow now reports currentVersion 2 with the new template.
    const getResult = await withTenant(db, tenantId, (sql) =>
      getWorkflow(sql, createResult.workflow.id),
    );
    expect(getResult.workflow.currentVersion).toBe(2);
    expect(getResult.version.promptTemplate).toBe('Updated {{input}}');
  });
});

describe('getWorkflowVersion on v1 is untouched; listWorkflowVersions returns [1, 2]', () => {
  it('old definition survives; version list is ordered', async () => {
    const { id: tenantId } = await makeTenant(db, 'survive-v1');

    const createResult = await withTenant(db, tenantId, (sql) =>
      createWorkflow(sql, {
        slug: 'survive-test',
        name: 'Survive Test',
        promptTemplate: 'Original {{input}}',
        outputSchema: { type: 'object', properties: { x: { type: 'string' } } },
        model: 'default',
      }),
    );

    await withTenant(db, tenantId, (sql) =>
      updateWorkflow(sql, createResult.workflow.id, {
        promptTemplate: 'Updated {{input}}',
        outputSchema: { type: 'object', properties: { y: { type: 'number' } } },
        model: 'default',
      }),
    );

    // v1 is still readable.
    const v1 = await withTenant(db, tenantId, (sql) =>
      getWorkflowVersion(sql, createResult.version.id),
    );
    expect(v1.version).toBe(1);
    expect(v1.promptTemplate).toBe('Original {{input}}');

    // listWorkflowVersions returns [1, 2].
    const versions = await withTenant(db, tenantId, (sql) =>
      listWorkflowVersions(sql, createResult.workflow.id),
    );
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
  });
});

describe('a second tenant updating the first tenant workflow rejects with WorkflowNotFoundError', () => {
  it('cross-tenant update is refused', async () => {
    const { id: tenantA } = await makeTenant(db, 'cross-update-a');

    const createResult = await withTenant(db, tenantA, (sql) =>
      createWorkflow(sql, {
        slug: 'cross-update',
        name: 'Cross Update',
        promptTemplate: 'Original {{input}}',
        outputSchema: { type: 'object', properties: { x: { type: 'string' } } },
        model: 'default',
      }),
    );

    const { id: tenantB } = await makeTenant(db, 'cross-update-b');

    await expect(
      withTenant(db, tenantB, (sql) =>
        updateWorkflow(sql, createResult.workflow.id, {
          promptTemplate: 'Hacked {{input}}',
          outputSchema: { type: 'object', properties: { x: { type: 'string' } } },
          model: 'default',
        }),
      ),
    ).rejects.toThrow(WorkflowNotFoundError);
  });
});

describe('archiveWorkflow returns true first time, false second; listWorkflows hides archived by default', () => {
  it('archiving is idempotent; includeArchived still finds it', async () => {
    const { id: tenantId } = await makeTenant(db, 'archive-test');

    const createResult = await withTenant(db, tenantId, (sql) =>
      createWorkflow(sql, {
        slug: 'archive-test-slug',
        name: 'Archive Test',
        promptTemplate: 'Archive {{input}}',
        outputSchema: { type: 'object', properties: { x: { type: 'string' } } },
        model: 'default',
      }),
    );

    // First archive returns true.
    const first = await withTenant(db, tenantId, (sql) =>
      archiveWorkflow(sql, createResult.workflow.id),
    );
    expect(first).toBe(true);

    // Second archive returns false.
    const second = await withTenant(db, tenantId, (sql) =>
      archiveWorkflow(sql, createResult.workflow.id),
    );
    expect(second).toBe(false);

    // listWorkflows hides it.
    const activeList = await withTenant(db, tenantId, (sql) =>
      listWorkflows(sql),
    );
    expect(activeList).toHaveLength(0);

    // includeArchived finds it.
    const archivedList = await withTenant(db, tenantId, (sql) =>
      listWorkflows(sql, { includeArchived: true }),
    );
    expect(archivedList).toHaveLength(1);
    expect(archivedList[0]!.state).toBe('archived');
  });
});

describe('enqueueOrder pins a workflow version; cross-tenant version reject', () => {
  it('order carries the version id; second tenant rejecting', async () => {
    const { id: tenantA } = await makeTenant(db, 'pin-tenant-a');

    const createResult = await withTenant(db, tenantA, (sql) =>
      createWorkflow(sql, {
        slug: 'pin-test',
        name: 'Pin Test',
        promptTemplate: 'Pin {{input}}',
        outputSchema: { type: 'object', properties: { x: { type: 'string' } } },
        model: 'default',
      }),
    );

    // Enqueue an order pinned to version 1.
    const orderResult = await withTenant(db, tenantA, (sql) =>
      enqueueOrder(sql, tenantA, ['item1'], { workflowVersionId: createResult.version.id }),
    );

    expect(orderResult.jobIds).toHaveLength(1);

    // Read back the work_order and verify workflow_version_id.
    const [orderRow] = await withTenant(db, tenantA, (sql) =>
      sql.query<{ id: string; workflow_version_id: string | null }>(
        'SELECT id, workflow_version_id FROM work_orders WHERE id = $1',
        [orderResult.orderId],
      ),
    );
    expect(orderRow!.workflow_version_id).toBe(createResult.version.id);

    // A second tenant passing the first tenant's version id rejects.
    const { id: tenantB } = await makeTenant(db, 'pin-tenant-b');

    await expect(
      withTenant(db, tenantB, (sql) =>
        enqueueOrder(sql, tenantB, ['item1'], { workflowVersionId: createResult.version.id }),
      ),
    ).rejects.toThrow();
  });
});

describe('renameWorkflow preserves definition; no new version minted', () => {
  it('name changes; version count stays the same', async () => {
    const { id: tenantId } = await makeTenant(db, 'rename-test');

    const createResult = await withTenant(db, tenantId, (sql) =>
      createWorkflow(sql, {
        slug: 'rename-test-slug',
        name: 'Old Name',
        promptTemplate: 'Rename {{input}}',
        outputSchema: { type: 'object', properties: { x: { type: 'string' } } },
        model: 'default',
      }),
    );

    expect(createResult.workflow.name).toBe('Old Name');

    const renamed = await withTenant(db, tenantId, (sql) =>
      renameWorkflow(sql, createResult.workflow.id, 'New Name'),
    );
    expect(renamed.name).toBe('New Name');

    // Definition is untouched.
    const current = await withTenant(db, tenantId, (sql) =>
      getWorkflow(sql, createResult.workflow.id),
    );
    expect(current.workflow.currentVersion).toBe(1);
    expect(current.version.promptTemplate).toBe('Rename {{input}}');
  });
});
