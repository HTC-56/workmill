import { describe, expect, it } from 'vitest';
import type { OpsEvent } from '../src/ops/events.js';
import {
  EventBus,
  formatSse,
  parseLastEventId,
  sseComment,
  sseRetry,
} from '../src/ops/events.js';

/**
 * Proves `EventBus` (`publish`, `subscribe`, `replay`, `hasGapSince`,
 * `lastSeq`, `subscriberCount`) and `formatSse`, `sseComment`, `sseRetry`,
 * `parseLastEventId` in `src/ops/events.ts`.
 *
 * No database — pure function tests only.
 */

describe('a subscriber hears only its own tenant', () => {
  it('tenant A listener does not see tenant B events', () => {
    const bus = new EventBus();
    const seen: OpsEvent[] = [];
    bus.subscribe('tenant-a', (event) => seen.push(event));

    bus.publish({ kind: 'job', tenantId: 'tenant-a', id: '1', state: 'running' });
    bus.publish({ kind: 'job', tenantId: 'tenant-b', id: '2', state: 'running' });
    bus.publish({ kind: 'job', tenantId: 'tenant-a', id: '3', state: 'done' });

    expect(seen).toHaveLength(2);
    expect(seen[0]!.tenantId).toBe('tenant-a');
    expect(seen[0]!.id).toBe('1');
    expect(seen[1]!.tenantId).toBe('tenant-a');
    expect(seen[1]!.id).toBe('3');
  });
});

describe('seq increases by one per publish across all tenants', () => {
  it('each publish increments lastSeq', () => {
    const bus = new EventBus();
    expect(bus.lastSeq).toBe(0);

    bus.publish({ kind: 'job', tenantId: 'a', id: '1', state: 'running' });
    expect(bus.lastSeq).toBe(1);

    bus.publish({ kind: 'order', tenantId: 'b', id: '2', state: 'blocked' });
    expect(bus.lastSeq).toBe(2);
  });

  it('the returned event seq matches lastSeq', () => {
    const bus = new EventBus();
    const e1 = bus.publish({ kind: 'job', tenantId: 'a', id: '1', state: 'running' });
    const e2 = bus.publish({ kind: 'job', tenantId: 'a', id: '2', state: 'done' });
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
  });
});

describe('the returned event at parses as a date', () => {
  it('at is valid ISO 8601', () => {
    const bus = new EventBus();
    const event = bus.publish({ kind: 'job', tenantId: 'a', id: '1', state: 'running' });
    const parsed = new Date(event.at);
    expect(parsed.toString()).not.toBe('Invalid Date');
  });
});

describe('subscribe returns unsubscribes', () => {
  it('after unsubscribe, subscriberCount is back to 0', () => {
    const bus = new EventBus();
    const unsub = bus.subscribe('tenant-a', () => {});
    expect(bus.subscriberCount).toBe(1);
    unsub();
    expect(bus.subscriberCount).toBe(0);
  });

  it('a further publish after unsubscribe reaches nobody', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    const unsub = bus.subscribe('tenant-a', (event) => seen.push(event.id));
    unsub();
    bus.publish({ kind: 'job', tenantId: 'tenant-a', id: '1', state: 'running' });
    expect(seen).toHaveLength(0);
  });
});

describe('a throwing listener does not break the publisher', () => {
  it('the recording listener still saw the event and publish did not reject', () => {
    const bus = new EventBus();
    const goodSeen: OpsEvent[] = [];

    // A listener that throws on every call
    const thrower = () => { throw new Error('boom'); };
    bus.subscribe('tenant-a', thrower);
    bus.subscribe('tenant-a', (event) => goodSeen.push(event));

    // publish should not throw
    const event = bus.publish({ kind: 'job', tenantId: 'tenant-a', id: '1', state: 'running' });
    expect(event).toBeDefined();
    expect(goodSeen).toHaveLength(1);
    expect(goodSeen[0]!.id).toBe('1');
  });
});

describe('replay returns only that tenant events with greater seq', () => {
  it('replay(tenantId, 0) returns everything for that tenant', () => {
    const bus = new EventBus();
    bus.publish({ kind: 'job', tenantId: 'a', id: '1', state: 'running' });
    bus.publish({ kind: 'job', tenantId: 'b', id: '2', state: 'running' });
    bus.publish({ kind: 'job', tenantId: 'a', id: '3', state: 'done' });

    const result = bus.replay('a', 0);
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe('1');
    expect(result[1]!.id).toBe('3');
  });

  it('replay(tenantId, afterSeq) skips events <= afterSeq', () => {
    const bus = new EventBus();
    bus.publish({ kind: 'job', tenantId: 'a', id: '1', state: 'running' });
    bus.publish({ kind: 'job', tenantId: 'a', id: '2', state: 'done' });
    bus.publish({ kind: 'job', tenantId: 'a', id: '3', state: 'failed' });

    const result = bus.replay('a', 1);
    expect(result).toHaveLength(2);
    expect(result[0]!.seq).toBe(2);
    expect(result[1]!.seq).toBe(3);
  });

  it('events are returned oldest first', () => {
    const bus = new EventBus();
    bus.publish({ kind: 'job', tenantId: 'a', id: '1', state: 'running' });
    bus.publish({ kind: 'job', tenantId: 'a', id: '2', state: 'done' });
    bus.publish({ kind: 'job', tenantId: 'a', id: '3', state: 'failed' });

    const result = bus.replay('a', 0);
    expect(result[0]!.seq).toBe(1);
    expect(result[1]!.seq).toBe(2);
    expect(result[2]!.seq).toBe(3);
  });
});

describe('bounded buffer drops oldest and hasGapSince detects the hole', () => {
  it('publishing four events keeps only the last two in a bus built as new EventBus(2)', () => {
    const bus = new EventBus(2);
    bus.publish({ kind: 'job', tenantId: 'a', id: '1', state: 'running' });
    bus.publish({ kind: 'job', tenantId: 'a', id: '2', state: 'done' });
    bus.publish({ kind: 'job', tenantId: 'a', id: '3', state: 'failed' });
    bus.publish({ kind: 'job', tenantId: 'a', id: '4', state: 'dead' });

    expect(bus.lastSeq).toBe(4);
    const replayed = bus.replay('a', 0);
    expect(replayed).toHaveLength(2);
    expect(replayed[0]!.id).toBe('3');
    expect(replayed[1]!.id).toBe('4');
  });

  it('hasGapSince(1) is true after four publishes in a size-2 buffer', () => {
    const bus = new EventBus(2);
    bus.publish({ kind: 'job', tenantId: 'a', id: '1', state: 'running' });
    bus.publish({ kind: 'job', tenantId: 'a', id: '2', state: 'done' });
    bus.publish({ kind: 'job', tenantId: 'a', id: '3', state: 'failed' });
    bus.publish({ kind: 'job', tenantId: 'a', id: '4', state: 'dead' });

    expect(bus.hasGapSince(1)).toBe(true);
  });

  it('hasGapSince(0) is false on an empty buffer', () => {
    const bus = new EventBus();
    expect(bus.hasGapSince(0)).toBe(false);
  });

  it('hasGapSince is false when the client is right at the oldest', () => {
    const bus = new EventBus(3);
    bus.publish({ kind: 'job', tenantId: 'a', id: '1', state: 'running' });
    bus.publish({ kind: 'job', tenantId: 'a', id: '2', state: 'done' });
    bus.publish({ kind: 'job', tenantId: 'a', id: '3', state: 'failed' });

    // oldest.seq = 1, so afterSeq = 0 means oldest - 1 = 0, not > 0, so false
    expect(bus.hasGapSince(0)).toBe(false);
    // afterSeq = 1 == oldest.seq - 0, so not < oldest.seq - 1
    expect(bus.hasGapSince(1)).toBe(false);
  });
});

describe('formatSse produces a frame ending in a blank line', () => {
  it('id: is the seq and data: parses back to the event', () => {
    const bus = new EventBus();
    const event = bus.publish({ kind: 'job', tenantId: 'a', id: '42', state: 'running' });
    const frame = formatSse(event);

    expect(frame).toMatch(/^id: 1\n/);
    expect(frame).toMatch(/event: job\n/);
    expect(frame).toMatch(/data: /);
    expect(frame.endsWith('\n\n')).toBe(true);

    const dataMatch = frame.match(/^data: (.+)$/m);
    expect(dataMatch).toBeDefined();
    expect(dataMatch![1]).toBeDefined();
    const parsed = JSON.parse(dataMatch![1]!);
    expect(parsed.seq).toBe(1);
    expect(parsed.id).toBe('42');
    expect(parsed.state).toBe('running');
  });
});

describe('sseComment produces a comment frame', () => {
  it('defaults to ping', () => {
    expect(sseComment()).toBe(': ping\n\n');
  });

  it('uses the provided text', () => {
    expect(sseComment('keep-alive')).toBe(': keep-alive\n\n');
  });
});

describe('sseRetry returns a retry frame', () => {
  it('rounds and clamps to zero', () => {
    expect(sseRetry(250.7)).toBe('retry: 251\n\n');
    expect(sseRetry(-10)).toBe('retry: 0\n\n');
  });
});

describe('parseLastEventId returns 0 for undefined and for abc, and 7 for 7', () => {
  it('returns 0 for undefined', () => {
    expect(parseLastEventId(undefined)).toBe(0);
  });

  it('returns 0 for a non-numeric string', () => {
    expect(parseLastEventId('abc')).toBe(0);
  });

  it('returns 7 for the string 7', () => {
    expect(parseLastEventId('7')).toBe(7);
  });

  it('returns 0 for negative numbers', () => {
    expect(parseLastEventId('-1')).toBe(0);
  });

  it('returns 0 for a float', () => {
    expect(parseLastEventId('3.14')).toBe(0);
  });

  it('parses a large integer header', () => {
    expect(parseLastEventId('12345')).toBe(12345);
  });
});
