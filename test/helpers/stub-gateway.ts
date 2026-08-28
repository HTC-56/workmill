import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * An in-process OpenAI-compatible gateway, for tests.
 *
 * Pre-registered in DECISIONS.md: CI has no model server, so every gateway path
 * is proven against this stub, and `scripts/live-check.sh` proves the same
 * paths against a real one. The stub exists to make failures ORDINARY — a
 * timeout, a 5xx, a body that is not JSON, and an output that misses its schema
 * are all one line of setup here, so the code that handles them is exercised as
 * routinely as the happy path.
 *
 * Behaviours are a queue: `queue(a, b)` scripts the next two calls, and every
 * call after that gets the default. That is how a re-ask test says "fail, fail,
 * then succeed" without any timing.
 */

export type StubBehavior =
  /** 200 with this text as the assistant message. */
  | {
      kind: 'content';
      content: string;
      promptTokens?: number;
      completionTokens?: number;
      finishReason?: string;
    }
  /** A non-2xx status with an arbitrary body. */
  | { kind: 'status'; status: number; body?: string }
  /** 200 whose body is not JSON at all. */
  | { kind: 'malformed' }
  /** 200 whose JSON is well formed but is not a chat completion. */
  | { kind: 'not-a-completion' }
  /** Answer after `ms`, which is how a client timeout is provoked. */
  | { kind: 'delay'; ms: number; content?: string };

/** What the stub saw, so a test can assert on what was actually sent. */
export interface StubRequest {
  model: string;
  messages: { role: string; content: string }[];
  temperature: number | undefined;
  maxTokens: number | undefined;
  authorization: string | undefined;
  path: string;
}

export interface StubGateway {
  /** OpenAI-compatible root — pass straight into a `GatewayConfig.baseUrl`. */
  readonly baseUrl: string;
  /** Every chat-completion request received, in order. */
  readonly requests: StubRequest[];
  /** Script the next calls; each behaviour is consumed by one call. */
  queue(...behaviors: StubBehavior[]): void;
  /** What answers once the queue is empty. */
  setDefault(behavior: StubBehavior): void;
  close(): Promise<void>;
}

const DEFAULT_BEHAVIOR: StubBehavior = { kind: 'content', content: '{}' };

function completionBody(
  behavior: Extract<StubBehavior, { kind: 'content' }> | { content: string },
): string {
  const content = behavior.content;
  const promptTokens = 'promptTokens' in behavior ? (behavior.promptTokens ?? 11) : 11;
  const completionTokens =
    'completionTokens' in behavior ? (behavior.completionTokens ?? 7) : 7;
  const finishReason =
    'finishReason' in behavior ? (behavior.finishReason ?? 'stop') : 'stop';
  return JSON.stringify({
    id: 'chatcmpl-stub',
    object: 'chat.completion',
    created: 1_700_000_000,
    model: 'stub-model',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  });
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function send(res: ServerResponse, status: number, body: string, json = true): void {
  res.writeHead(status, { 'content-type': json ? 'application/json' : 'text/plain' });
  res.end(body);
}

/**
 * Start the stub on an ephemeral loopback port. Always `close()` it in an
 * `afterAll`, or vitest will hold the port open until the run ends.
 */
export async function startStubGateway(): Promise<StubGateway> {
  const requests: StubRequest[] = [];
  const scripted: StubBehavior[] = [];
  let fallback: StubBehavior = DEFAULT_BEHAVIOR;
  const timers = new Set<NodeJS.Timeout>();

  const respond = (res: ServerResponse, behavior: StubBehavior): void => {
    switch (behavior.kind) {
      case 'status':
        send(res, behavior.status, behavior.body ?? 'stub failure', false);
        return;
      case 'malformed':
        send(res, 200, 'not json at all', false);
        return;
      case 'not-a-completion':
        send(res, 200, JSON.stringify({ object: 'chat.completion', choices: [] }));
        return;
      case 'delay': {
        const timer = setTimeout(() => {
          timers.delete(timer);
          if (!res.writableEnded) {
            send(res, 200, completionBody({ content: behavior.content ?? '{}' }));
          }
        }, behavior.ms);
        timers.add(timer);
        return;
      }
      case 'content':
        send(res, 200, completionBody(behavior));
        return;
    }
  };

  const server: Server = createServer((req, res) => {
    const path = req.url ?? '';
    if (req.method === 'GET' && path.endsWith('/models')) {
      send(res, 200, JSON.stringify({ object: 'list', data: [{ id: 'stub-model', object: 'model' }] }));
      return;
    }
    if (req.method !== 'POST' || !path.endsWith('/chat/completions')) {
      send(res, 404, JSON.stringify({ error: { message: `no such route: ${path}` } }));
      return;
    }

    void readBody(req).then((raw) => {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // A malformed request body is itself worth recording; leave it empty.
      }
      const messages = Array.isArray(parsed['messages'])
        ? (parsed['messages'] as { role: string; content: string }[])
        : [];
      const temperature = parsed['temperature'];
      const maxTokens = parsed['max_tokens'];
      requests.push({
        model: typeof parsed['model'] === 'string' ? parsed['model'] : '',
        messages,
        temperature: typeof temperature === 'number' ? temperature : undefined,
        maxTokens: typeof maxTokens === 'number' ? maxTokens : undefined,
        authorization: req.headers.authorization,
        path,
      });
      respond(res, scripted.shift() ?? fallback);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    queue(...behaviors: StubBehavior[]): void {
      scripted.push(...behaviors);
    },
    setDefault(behavior: StubBehavior): void {
      fallback = behavior;
    },
    async close(): Promise<void> {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
