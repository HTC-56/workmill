/**
 * The in-process event bus behind `GET /events` (SPEC.md feature 8).
 *
 * The dashboard wants "live per-item progress" without polling, and the spec's
 * non-goals forbid an external broker, so transitions are published in-process
 * and streamed as Server-Sent Events. SSE rather than WebSockets on purpose: it
 * is one-directional, it is plain text over the same HTTP the rest of the API
 * uses, and browsers reconnect it for free.
 *
 * Two rules shape everything here.
 *
 * FIRST, an event carries a tenant id and subscribers are filtered by it. RLS
 * cannot help in memory — there is no policy on a JavaScript array — so the
 * filter is this module's whole job and `subscribe` takes the tenant as its
 * first argument rather than as an option a caller might forget.
 *
 * SECOND, an event carries ids and states, never content. A job's input is
 * tenant text and its output may be anything a model wrote; neither belongs in
 * a stream that exists to say "item 3 of 5 finished". A client that wants the
 * result fetches it.
 *
 * The buffer is bounded and lossy by design. A browser that reconnects sends
 * `Last-Event-ID` and gets whatever is still in the ring; if it was away longer
 * than the ring is deep, it is told to reload rather than shown a gap.
 */

/** What a transition says. Ids and states only — never item text or output. */
export interface OpsEvent {
  /** Monotonic within one process. Becomes the SSE `id:` field. */
  seq: number;
  /** ISO 8601, UTC. */
  at: string;
  kind: 'job' | 'order';
  tenantId: string;
  /** The job id or the order id, per `kind`. */
  id: string;
  /** The state it moved to: 'running', 'done', 'failed', 'dead', 'blocked', … */
  state: string;
  /** For a job event, the order it belongs to — so a client can group. */
  orderId?: string;
  /** Item index within the order, for per-item progress. */
  idx?: number;
  /** A short machine-readable reason, e.g. 'daily-token-budget-exhausted'. */
  reason?: string;
}

/** What a publisher supplies; `seq` and `at` are the bus's to assign. */
export type OpsEventInput = Omit<OpsEvent, 'seq' | 'at'>;

export type EventListener = (event: OpsEvent) => void;

/** How many past events one bus keeps for reconnecting clients. */
export const DEFAULT_BUFFER_SIZE = 256;

export class EventBus {
  readonly #buffer: OpsEvent[] = [];
  readonly #bufferSize: number;
  readonly #listeners = new Set<{ tenantId: string; listener: EventListener }>();
  #seq = 0;

  constructor(bufferSize: number = DEFAULT_BUFFER_SIZE) {
    if (!Number.isInteger(bufferSize) || bufferSize < 1) {
      throw new RangeError(`buffer size must be a positive integer, got ${bufferSize}`);
    }
    this.#bufferSize = bufferSize;
  }

  /** The last sequence number handed out. Zero before anything is published. */
  get lastSeq(): number {
    return this.#seq;
  }

  /** Live subscriber count, for the fleet panel and for leak tests. */
  get subscriberCount(): number {
    return this.#listeners.size;
  }

  /**
   * Publish one transition and return the stamped event.
   *
   * A listener that throws must not take down the publisher: the runner calls
   * this after a job has already been committed, and an exception here would
   * roll nothing back while failing the tick. Errors are swallowed per listener,
   * which is the one place in this repo where that is the right answer.
   */
  publish(input: OpsEventInput): OpsEvent {
    const event: OpsEvent = { ...input, seq: ++this.#seq, at: new Date().toISOString() };
    this.#buffer.push(event);
    if (this.#buffer.length > this.#bufferSize) this.#buffer.shift();
    for (const entry of this.#listeners) {
      if (entry.tenantId !== event.tenantId) continue;
      try {
        entry.listener(event);
      } catch {
        // A broken pipe on one SSE response is not the publisher's problem.
      }
    }
    return event;
  }

  /** Subscribe to one tenant's events. The returned function unsubscribes. */
  subscribe(tenantId: string, listener: EventListener): () => void {
    const entry = { tenantId, listener };
    this.#listeners.add(entry);
    return () => {
      this.#listeners.delete(entry);
    };
  }

  /**
   * Buffered events for one tenant with `seq` greater than `afterSeq`, oldest
   * first. `afterSeq` of 0 means "everything still buffered".
   */
  replay(tenantId: string, afterSeq = 0): OpsEvent[] {
    return this.#buffer.filter((e) => e.tenantId === tenantId && e.seq > afterSeq);
  }

  /**
   * True when `afterSeq` is older than everything still buffered, so a replay
   * from it would silently skip events. A reconnecting client is told to reload
   * instead of being handed a hole.
   */
  hasGapSince(afterSeq: number): boolean {
    const oldest = this.#buffer[0];
    if (!oldest) return false;
    return afterSeq > 0 && afterSeq < oldest.seq - 1;
  }
}

/**
 * Encode one event as an SSE frame, terminator included.
 *
 * The `data:` payload is JSON, which by construction contains no raw newline, so
 * a single `data:` line is always enough — no continuation handling and no way
 * for an event to inject a frame boundary.
 */
export function formatSse(event: OpsEvent): string {
  return `id: ${event.seq}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** A comment frame. Keeps idle connections and proxies from timing out. */
export function sseComment(text = 'ping'): string {
  return `: ${text}\n\n`;
}

/** Tells the browser's EventSource how long to wait before reconnecting. */
export function sseRetry(ms: number): string {
  return `retry: ${Math.max(0, Math.round(ms))}\n\n`;
}

/**
 * Parse a `Last-Event-ID` header into a sequence number. Anything that is not a
 * non-negative integer is treated as "no resume point", which is what a fresh
 * connection sends anyway.
 */
export function parseLastEventId(header: string | undefined): number {
  if (typeof header !== 'string') return 0;
  const n = Number(header.trim());
  return Number.isInteger(n) && n >= 0 ? n : 0;
}
