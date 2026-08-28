# Phase D — model calls through the gateway

**ROADMAP row:** #4 *Model calls through the gateway (schema validation,
bounded re-ask, usage capture)*, currently NOT BUILT. SPEC.md feature 4:
workmill speaks OpenAI-compatible HTTP to ONE configured base URL and never
talks to a model server directly; the output is validated against the
workflow's stored JSON Schema with a re-ask bounded at two; an output still
invalid after those re-asks is a **result**, not an exception; token usage is
read off every response.

**Already committed (do not rebuild):** `src/gateway/client.ts`
(`loadGatewayConfig`, `resolveModel`, `chatCompletion`, `addUsage`,
`ZERO_USAGE`, and the `GatewayError` / `GatewayTimeoutError` /
`GatewayHttpError` / `GatewayProtocolError` / `GatewayConfigError` classes),
`src/gateway/schema.ts` (`validateAgainstSchema`, `parseJsonObject`,
`JsonParseError`), and `test/helpers/stub-gateway.ts` (the in-process
OpenAI-compatible stub). Sections §D1–§D3 are those commits; the tasks below
start at §D4.

**Gate for every task below** (all three, always):
`pnpm typecheck` && `pnpm test` && `bash scripts/scrub-check.sh`.

**Six facts that will cost you a red gate if you guess them wrong:**

1. **A `GatewayConfig` is a plain object.** Build one in a test as
   `{ baseUrl: stub.baseUrl, timeoutMs: 2000, models: {} }`. No environment
   variable is involved and `loadGatewayConfig` takes its env as an argument —
   never mutate `process.env` in a test.
2. **The stub's API**, from `test/helpers/stub-gateway.ts`:
   `const stub = await startStubGateway()` gives `stub.baseUrl`,
   `stub.requests` (every request it received), `stub.queue(...behaviors)`
   (each behaviour is consumed by one call, in order), `stub.setDefault(b)`
   (what answers once the queue is empty) and `await stub.close()`.
3. **Behaviour kinds**, all from the same union:
   `{ kind: 'content', content, promptTokens?, completionTokens?, finishReason? }`,
   `{ kind: 'status', status, body? }`, `{ kind: 'malformed' }`,
   `{ kind: 'not-a-completion' }`, `{ kind: 'delay', ms, content? }`.
   Default usage on a `content` behaviour is 11 prompt + 7 completion tokens.
4. **Transport failure throws; a bad answer does not.** A 5xx, a timeout and a
   non-JSON body throw. An output that misses its schema is an ordinary
   returned value.
5. These test files touch **no database**: no `freshDb`, no `makeTenant`, no
   import from `test/helpers/db.js`. Always `await stub.close()` in `afterAll`
   or the run hangs on the open port.
6. `noUncheckedIndexedAccess` is on, so `stub.requests[0]` is
   `StubRequest | undefined`. Use `stub.requests.at(-1)!` or a local
   `const first = stub.requests[0]!`, the way the existing tests do.

---

## §D4 — test/schema.test.ts

**Create:** `test/schema.test.ts`. **Pattern file:** `test/render.test.ts` for
import and `describe`/`it` style — like that file this one touches no database
and no network, so it has no `beforeAll` and no `afterAll`.

Under test: `validateAgainstSchema`, `parseJsonObject` and `JsonParseError`
from `src/gateway/schema.ts`. Read that file's header comment first: it names
exactly which keywords are supported.

Assert:

1. An object matching a schema with `type`, `properties`, `required` and a
   string `enum` validates: the result is `{ valid: true }`.
2. One bad value gives `valid: false` with an `errors` array, and the message
   names the path it was found at (a property error mentions `/` and the
   property name).
3. **Every problem is reported, not just the first**: a value that misses a
   required property AND carries a wrong-typed one produces at least two
   errors.
4. `1.5` fails a `{ type: 'integer' }` property while `3` passes it — an
   integer is a number, a fraction is not an integer.
5. `additionalProperties: false` refuses an undeclared key; the same schema
   without that keyword accepts it.
6. An unsupported keyword is ignored rather than refused: a schema with
   `minLength` on a string still validates a short string.
7. `parseJsonObject` reads an object out of bare JSON, out of a ```` ```json ````
   fenced block, and out of a reply with prose around the object; it throws
   `JsonParseError` for a JSON array, for text with no object in it, and for
   an empty string.

---

## §D5 — test/gateway.test.ts

**Create:** `test/gateway.test.ts`. **Pattern file:** `test/render.test.ts` for
style, plus fact 2 above for the stub. Start the stub in `beforeAll`, close it
in `afterAll`.

Under test: `src/gateway/client.ts` against the stub.

Assert:

1. A `content` behaviour returns its text as `content`, and `usage` reads back
   `{ promptTokens, completionTokens, totalTokens }` matching the numbers the
   behaviour was given — with `totalTokens` the sum.
2. What went out is what was asked for: after a call passing `temperature` and
   `maxOutputTokens`, the recorded request's `temperature` matches and its
   `maxTokens` matches (the wire name is `max_tokens`, which the stub already
   translates for you).
3. A `{ kind: 'status', status: 503 }` behaviour rejects with
   `GatewayHttpError`, and the thrown error's `status` is `503`.
4. A `{ kind: 'malformed' }` behaviour rejects with `GatewayProtocolError`, and
   so does `{ kind: 'not-a-completion' }`.
5. A `{ kind: 'delay', ms: 500 }` behaviour against a config with
   `timeoutMs: 60` rejects with `GatewayTimeoutError`.
6. A config with `apiKey` set makes the recorded request's `authorization`
   read `Bearer <key>`; a config without one leaves it undefined.
7. `loadGatewayConfig({})` defaults `baseUrl` to `http://localhost:8080/v1`; a
   trailing slash on `GATEWAY_BASE_URL` is stripped; `GATEWAY_MODELS` of
   `{"default":"real-name"}` makes `resolveModel(config, 'default')` return
   `real-name` while an unmapped name comes back unchanged; a non-http URL and
   an unparseable `GATEWAY_MODELS` each throw `GatewayConfigError`.

---

## §D6 — src/gateway/complete.ts: the bounded re-ask

**Create:** `src/gateway/complete.ts`. Nothing else, no new dependency, and
change neither `client.ts` nor `schema.ts`.

**Pattern file:** `src/workflows/render.ts` — same shape: a header comment
saying what the file is for, exported constants, then exported functions.
Import `renderPrompt` from `../workflows/render.js`; `chatCompletion`,
`addUsage`, `ZERO_USAGE` and the types from `./client.js`; `parseJsonObject`,
`validateAgainstSchema` and `JsonParseError` from `./schema.js`.

This is the layer that turns a workflow definition plus one item into a
validated result. Export:

1. `MAX_REASKS = 2` — SPEC.md bounds the re-ask at two, so one call makes at
   most three attempts.
2. `CompleteRequest` — `promptTemplate`, `input`, `outputSchema`, `model`, and
   optional `temperature` and `maxOutputTokens`.
3. `CompleteResult` — a union discriminated on `ok`. Success carries
   `ok: true`, `value` (the parsed object), `raw` (the model's text),
   `attempts`, `usage` and `model`. Failure carries `ok: false`, `reason`
   (`'unparseable'` or `'schema-invalid'`), `errors: string[]`, `raw`,
   `attempts` and `usage`.
4. `runCompletion(config, request): Promise<CompleteResult>`.

How it behaves:

- The first attempt sends two messages: a system message telling the model to
  answer with JSON matching the schema, with the schema itself included as
  JSON text; then a user message holding `renderPrompt(promptTemplate, input)`.
- Each attempt calls `chatCompletion`, adds that response's `usage` to a
  running total that starts at `ZERO_USAGE`, then tries `parseJsonObject`
  followed by `validateAgainstSchema`.
- On success it returns immediately, with `attempts` set to the number of
  calls actually made.
- On a bad answer with attempts left, it appends the model's raw reply as an
  `assistant` message and a new `user` message naming the problems, then tries
  again. The conversation grows; it is not rebuilt from scratch.
- After the last attempt it RETURNS a failure result — it never throws for a
  bad answer. `reason` is `'unparseable'` when the final failure was a
  `JsonParseError` (put its message in `errors` as the single entry),
  otherwise `'schema-invalid'` with the validator's own errors.
- A `GatewayError` from `chatCompletion` is not caught. Retrying a 5xx is the
  job runner's business, not this function's.

---

## §D7 — test/complete.test.ts

**Create:** `test/complete.test.ts`. **Pattern file:** the
`test/gateway.test.ts` you wrote in §D5 — same stub setup and teardown.

Under test: `runCompletion` from §D6. Use a small schema throughout, e.g. an
object with one `label` property carrying an `enum` of two values, and
`required: ['label']`.

Assert:

1. A first reply that already matches returns `ok: true` with `attempts` 1,
   `value` deep-equal to the object the stub sent, and `usage.totalTokens`
   equal to that one response's total.
2. An invalid first reply followed by a valid second returns `ok: true` with
   `attempts` 2, and `usage.totalTokens` is the SUM across both calls — the
   paper trail counts the re-ask.
3. Three replies that all miss the schema return `ok: false` with `reason`
   `'schema-invalid'`, `attempts` 3, a non-empty `errors` array, and
   `stub.requests` has length 3 — bounded means bounded.
4. Three replies that are not JSON at all return `ok: false` with `reason`
   `'unparseable'`.
5. The re-ask carries context: the second recorded request has MORE messages
   than the first, and its last message text mentions the schema problem.
6. A `{ kind: 'status', status: 500 }` behaviour makes `runCompletion` reject
   with `GatewayHttpError` — a transport failure is never a `CompleteResult`.

---

## §D8 — scripts/live-check.sh: the real-gateway proof

**Create:** `scripts/live-check.sh`. **Pattern file:** `scripts/scrub-check.sh`
— `#!/usr/bin/env bash`, `set -euo pipefail`, a header comment saying what the
script is for, one section per check, a green `PASS:` line at the end and a
non-zero exit with a `FAIL:` line on `stderr` otherwise.

DECISIONS.md pre-registers this script: CI proves the gateway paths against the
in-process stub, and THIS proves the same contract against a real gateway and a
real model. It is deliberately **not** run by CI and not by `verify.sh` —
neither has a model server. A human runs it before a demo deployment.

Rules:

- `curl` only. No new dependency, no `jq`, no node.
- Configuration, all with defaults: `GATEWAY_BASE_URL` (default
  `http://localhost:8080/v1`), `GATEWAY_MODEL` (default `default`), and an
  optional `GATEWAY_API_KEY` sent as `Authorization: Bearer …` only when set.
- **Never print the API key**, not even in an error message.
- Say what is being checked before each check and print what came back on
  failure, so a failed run is diagnosable without editing the script.

Three checks:

1. `GET $GATEWAY_BASE_URL/models` answers HTTP 200 and its body contains
   `"data"`.
2. `POST $GATEWAY_BASE_URL/chat/completions` with a small JSON body — the
   configured model, one user message asking for a JSON object, `stream` false
   — answers HTTP 200 and its body contains `"choices"` and `"content"`.
3. The same response body contains `"usage"` and a `"total_tokens"` field:
   usage capture is part of the contract, so a gateway that omits it fails this
   check loudly rather than silently costing the product its paper trail.

---

## §D9 — README.md: Phase D status

**Edit only:** `README.md`. Prose only; change no code.

Three changes, nothing more:

- **Status.** Add a Phase D paragraph after the Phase C one: model calls go
  through one configured OpenAI-compatible base URL and nowhere else; a logical
  model name resolves through config, so swapping the model behind `'default'`
  is not a data migration; output is parsed and validated against the
  workflow's stored schema with a re-ask bounded at two, and an output still
  invalid after them is a returned failure, not a thrown error; token usage is
  read off every response. Say plainly what is NOT true yet: nothing stores
  those results or that usage — the job runner and the token ledger are not
  built, so no work order runs end to end.
- **Layout.** Add one line for `src/gateway/` — the OpenAI-compatible client,
  the JSON Schema subset validator, the bounded re-ask.
- **Gates.** Add `bash scripts/live-check.sh` below the three gate commands,
  with one sentence: it needs a real gateway and a real model, so CI and
  `verify.sh` do not run it; a human runs it before a demo deployment. Name the
  environment variables it reads (`GATEWAY_BASE_URL`, `GATEWAY_MODEL`,
  optional `GATEWAY_API_KEY`).

Every command shown in this file must already work — `verify.sh` gate 4 fails
the build otherwise, and it checks that each `bash <path>` exists on disk. No
hostnames but `localhost`, no IPs but `127.0.0.1` or `192.0.2.x`, no absolute
home paths.

---

## §D10 — close Phase D: verify.sh, STATUS.md, ROADMAP.md

**Edit:** `STATUS.md` (append a section) and `ROADMAP.md` (one row plus the
reservations ledger). Change no code.

Run `bash verify.sh` first. It must be green before you write either file.

**STATUS.md** — append a `## Phase D — model calls through the gateway`
section, at most 15 lines: one configured base URL is the only outbound HTTP in
`src/`; logical model names resolve through config; the stored output schema
finally meets a model's output, validated by a documented subset of JSON Schema
and re-asked at most twice; an invalid-after-re-asks output is a returned
failure carrying its errors, its raw text and its token usage, not an
exception; every gateway path is proven against the in-process stub and
`scripts/live-check.sh` proves the same contract against a real gateway. End
with what is NOT true yet: nothing persists a result or its usage, because the
job runner and the token ledger are not built. Do not restate Phases A–C.

**ROADMAP.md** — two edits:

- Row #4: status `SHIPPED`, phase `D`, one-line note — the client, the subset
  validator, the bounded re-ask and usage capture are complete and proven
  against the stub; attributing usage to a job lands with the runner (row #3)
  and the ledger (row #5).
- Reservations ledger: append three entries. First, the validator covers a
  documented subset of JSON Schema and ignores keywords outside it; widening it
  waits until a real workflow needs one. Second, usage is captured per call but
  persisted nowhere yet. Third, `scripts/live-check.sh` now exists but neither
  CI nor `verify.sh` runs it — it needs a real gateway, and a human runs it
  before a demo deployment.

Flip no other row. Phase D completes row #4 and no other.
