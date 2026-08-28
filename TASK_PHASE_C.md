# Phase C — workflows as tenant data

**ROADMAP row:** #2 *Workflows as tenant data (template + schema + model,
versioned)*, currently NOT BUILT. SPEC.md feature 2: a workflow is a name, a
prompt template with `{{input}}`, a JSON output schema, a logical model name and
two parameters — rows a tenant owns, never code. Edits append versions; every
run pins the version it ran under. Three seeded examples ship with it.

**Already committed (do not rebuild):** `sql/004_workflows.sql` (the `workflows`
and `workflow_versions` tables, their RLS policies, their `tenant-scoped:`
markers, and the `work_orders.workflow_version_id` pin), `src/workflows/store.ts`
(`createWorkflow`, `updateWorkflow`, `renameWorkflow`, `archiveWorkflow`,
`listWorkflows`, `getWorkflow`, `getWorkflowVersion`, `listWorkflowVersions`,
`assertValidDefinition`), the `test/leak.test.ts` fixtures for the two new
tables, and the optional `workflowVersionId` on `enqueueOrder`. Sections §C1–§C3
are those commits; the tasks below start at §C4.

**Gate for every task below** (all three, always):
`pnpm typecheck` && `pnpm test` && `bash scripts/scrub-check.sh`.

**Five facts that will cost you a red gate if you guess them wrong:**

1. A workflow `slug` uses the same shape as a tenant slug —
   `^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$`, so **at least three characters**, all
   lowercase. Slugs are unique per tenant, never globally.
2. A prompt template **must contain `{{input}}`**. Both the database and
   `assertValidDefinition` refuse one that does not.
3. `outputSchema` must be a JSON object whose `type` is exactly `"object"`.
   `{ type: 'array' }` is refused.
4. Every function in `src/workflows/store.ts` takes a `Session` — call them
   inside `withTenant(db, tenantId, (sql) => …)`. Set tenants up with
   `provisionTenant`, as `test/tenancy.test.ts` does.
5. A workflow belonging to another tenant **throws `WorkflowNotFoundError`**; it
   does not return null. `archiveWorkflow` is the exception: it returns `false`.

---

## §C4 — src/workflows/render.ts: the one substitution

**Create:** `src/workflows/render.ts`. Nothing else. No new dependency.
**Pattern file:** `src/tenancy/entitlements.ts` — same shape: a header comment
saying what the file is for, a named `Error` subclass, and pure exported
functions.

This file is where SPEC.md's "no arbitrary code execution" non-goal is enforced.
The entire template language is one substitution. There is no expression syntax,
no conditional, no loop, and nothing here may build a regular expression from
tenant text or evaluate anything.

Export:

1. `TemplateError` — an `Error` subclass with `name` set to match, in the style
   of `MissingEntitlementsError` in the pattern file.
2. `renderPrompt(template: string, input: string): string` — returns the
   template with every occurrence of `{{input}}` replaced by the item text
   verbatim. No escaping, no trimming, no other placeholder touched.
3. `assertRenderable(template: string): void` — throws `TemplateError` when the
   template contains no `{{input}}`, and when it contains any *other* `{{…}}`
   placeholder. An unknown placeholder is refused rather than left in the
   prompt: silently shipping `{{name}}` to a model is how template logic creeps
   into a product that promised it has none.

Two rules the tests in §C5 will hold you to:

- **The substituted text is never re-scanned.** An item that itself contains the
  characters `{{input}}` is inserted once and left alone.
- **`String.prototype.replaceAll`'s replacement argument treats `$&`, `` $` ``
  and `$1` as special patterns**, so an item containing a dollar sign would be
  corrupted by the obvious one-liner. Split on the placeholder and join, or pass
  a replacer function — either is fine, but the item must land byte-for-byte.

---

## §C5 — test/render.test.ts

**Create:** `test/render.test.ts`. **Pattern file:** `test/entitlements.test.ts`
for import and `describe`/`it` style **only** — this test touches no database, so
it has no `freshDb`, no `beforeAll` and no `afterAll`. Importing anything from
`test/helpers/db.js` here is a mistake.

Under test: `src/workflows/render.ts` from §C4.

Assert:

1. A template with one `{{input}}` renders with the item substituted in place
   and every other character unchanged.
2. A template with `{{input}}` twice substitutes both occurrences.
3. An item containing `$&` and `$1` lands in the output byte-for-byte — compare
   against the exact expected string, not a `toContain`.
4. Rendering a template with the item `'{{input}}'` produces a string that still
   contains the placeholder text exactly once: the inserted text is not
   substituted again.
5. `assertRenderable` throws `TemplateError` for a template with no placeholder,
   and for one containing `{{name}}`.
6. `assertRenderable` returns without throwing for a plain template that
   contains `{{input}}` and nothing else in braces.

---

## §C6 — test/workflows.test.ts: create, list, get

**Create:** `test/workflows.test.ts`. **Pattern file:** `test/tenancy.test.ts` —
copy its `beforeAll` (`freshDb`), its `afterAll` (`db.close()`) and its habit of
provisioning a tenant per case.

Under test: `createWorkflow`, `listWorkflows`, `getWorkflow` and the error
classes from `src/workflows/store.ts`. Read that file before writing assertions;
it names the exact fields of `CreateWorkflowRequest`.

Assert:

1. `createWorkflow` returns a workflow whose `currentVersion` is 1 and a version
   whose `version` is 1, both with non-empty ids.
2. Unset parameters come back as the defaults **as numbers, not strings**:
   `temperature` is `0` and `maxOutputTokens` is `512`, and `typeof` each is
   `'number'`.
3. The `outputSchema` round-trips: what `createWorkflow` returns deep-equals the
   object that was passed in.
4. A tenant that created two workflows sees both from `listWorkflows`, ordered
   by slug; a second tenant sees zero. Nothing in that call filters by tenant —
   RLS does it.
5. `getWorkflow` returns the workflow with its current version, and calling it
   under a *different* tenant with the same workflow id rejects with
   `WorkflowNotFoundError`.
6. `createWorkflow` rejects with `InvalidWorkflowError` for a template with no
   `{{input}}`, and again for an `outputSchema` of `{ type: 'array' }`.

---

## §C7 — test/workflows.test.ts: versioning, archiving, the pin

**Edit only:** `test/workflows.test.ts` from §C6. Add cases; keep every existing
one.

Under test: `updateWorkflow`, `getWorkflowVersion`, `listWorkflowVersions`,
`renameWorkflow`, `archiveWorkflow`, and the `workflowVersionId` option on
`enqueueOrder` in `src/queue/enqueue.ts`.

Assert:

1. `updateWorkflow` returns version 2 with an id different from version 1's, and
   `getWorkflow` afterwards reports `currentVersion` 2 carrying the new template.
2. The old definition is untouched: `getWorkflowVersion` on the version-1 id
   still returns the original prompt template, and `listWorkflowVersions`
   returns versions `[1, 2]` in that order.
3. A second tenant calling `updateWorkflow` with the first tenant's workflow id
   rejects with `WorkflowNotFoundError`.
4. `archiveWorkflow` returns `true` the first time and `false` the second. After
   archiving, `listWorkflows` finds nothing but
   `listWorkflows(sql, { includeArchived: true })` still finds the row —
   retiring a workflow must not erase the orders that pinned its versions.
5. `enqueueOrder(sql, tenantId, ['a', 'b'], { workflowVersionId })` succeeds and
   the `work_orders` row reads back with that `workflow_version_id`; a second
   tenant passing the first tenant's version id rejects.

---

## §C8 — src/workflows/examples.ts: the three seeded workflows

**Create:** `src/workflows/examples.ts`. Nothing else. No new dependency, and do
not change `store.ts`.

**Pattern file:** `DEFAULT_ENTITLEMENTS` in `src/tenancy/provision.ts` — an
exported typed constant with a comment saying plainly what it is for and what it
is not. Import `CreateWorkflowRequest` and `createWorkflow` from
`./store.js`.

SPEC.md feature 2 names exactly three examples. Export:

1. `EXAMPLE_WORKFLOWS: readonly CreateWorkflowRequest[]` — three entries, slugs
   `extract`, `classify` and `summarize`, in that order. Each has a human name,
   a prompt template containing `{{input}}` and no other `{{…}}` placeholder, an
   `outputSchema` with `"type": "object"` and a `properties` object, and the
   logical model name `'default'` (the placeholder name the gateway phase will
   map).
   - **extract** — text in, fields out: a few string properties such as a
     person's name, an email address and a company.
   - **classify** — text in, one label from a **fixed set**: the label property's
     schema carries an `enum` array of three or four labels, so the set really
     is closed. Say the labels in the prompt template too.
   - **summarize** — a document in, a one-paragraph brief out: a single string
     property, and a `maxOutputTokens` lower than the 512 default.
2. `seedExampleWorkflows(sql: Session): Promise<{ workflowId: string; slug: string }[]>`
   — calls `createWorkflow` for each entry in order and returns what it made. It
   does nothing else: no transaction handling (the caller's `withTenant` already
   owns one), no state, no logging.

---

## §C9 — test/examples.test.ts

**Create:** `test/examples.test.ts`. **Pattern file:** the
`test/workflows.test.ts` you wrote in §C6.

Under test: `src/workflows/examples.ts` from §C8, plus `assertValidDefinition`
from `src/workflows/store.ts` and `assertRenderable` from
`src/workflows/render.ts`.

Assert:

1. `EXAMPLE_WORKFLOWS` has exactly three entries and their slugs are
   `extract`, `classify`, `summarize`.
2. Every entry passes `assertValidDefinition` without throwing — loop over the
   array rather than writing three near-identical cases.
3. Every entry's prompt template passes `assertRenderable`, which proves each one
   carries `{{input}}` and smuggles in no other placeholder.
4. `seedExampleWorkflows` inside `withTenant` creates three workflows;
   `listWorkflows` afterwards returns three, each at `currentVersion` 1.
5. The `classify` entry's output schema names a closed label set: some property
   in it has an `enum` array with at least two entries.
6. Two different tenants can each seed the examples successfully — slugs are
   unique per tenant, not globally.

---

## §C10 — README.md: Phase C status

**Edit only:** `README.md`. Prose only; change no code.

Two changes, nothing more:

- **Status.** Add a Phase C paragraph after the Phase B one: workflows are
  tenant data now — a prompt template with `{{input}}`, a JSON output schema, a
  logical model name, temperature and max output tokens, all under RLS and all
  covered by the leak suite. Edits append a version instead of rewriting one,
  and a work order pins the version it was submitted against. Three example
  workflows ship: extract, classify, summarize. Say plainly that **nothing runs
  them yet** — the gateway and the job runner are not built, so a stored output
  schema is not yet validated against any model output.
- **Layout.** Add one line for `src/workflows/` — definitions, versioning, the
  `{{input}}` renderer, the three examples.

Every command shown in this file must already work: `verify.sh` gate 4 fails the
build otherwise. Do not add commands. No hostnames but `localhost`, no IPs but
`192.0.2.x`, no absolute home paths.

---

## §C11 — close Phase C: verify.sh, STATUS.md, ROADMAP.md

**Edit:** `STATUS.md` (append a section) and `ROADMAP.md` (one row plus the
reservations ledger). Change no code.

Run `bash verify.sh` first. It must be green before you write either file.

**STATUS.md** — append a `## Phase C — workflows are tenant data` section, at
most 15 lines: the two tables exist under RLS, so the catalog-driven leak suite
now proves nine tenant-scoped tables; an edit appends a version and a work order
pins the version it ran under; three examples ship; the `{{input}}` substitution
is the whole template language, which is where the no-code-execution non-goal is
enforced. End with what is NOT true yet: nothing executes a workflow, so the
stored output schema has not yet met a model. Do not restate Phase A or B.

**ROADMAP.md** — two edits:

- Row #2: status `SHIPPED`, phase `C`, and a one-line note — definitions,
  versioning and the order pin are complete as tenant data; the pages that
  expose them are rows #6 and #7.
- Reservations ledger: append two entries. First, `work_orders.workflow_version_id`
  is nullable for now and the runner phase makes it `NOT NULL`, once the submit
  path always supplies it. Second, the output schema is stored but nothing
  validates a model's output against it until the gateway phase (feature 4).

Flip no other row. Phase C completes row #2 and no other.
