import { describe, expect, test } from 'bun:test';
import { NODE_EVENT_DEDUPE_MAX, NodeEventDedupe } from './node-event-dedupe';

describe('NodeEventDedupe', () => {
  test('list events emit when inventory/version/name change even if status stays online', () => {
    const dedupe = new NodeEventDedupe();
    const base = {
      nodeId: 'aa'.repeat(16),
      status: 'online' as const,
      reach: null,
      inventory: '{"version":"1"}',
      version: '1',
      direct_capable: false,
      name: 'peer',
    };
    expect(dedupe.shouldEmitList(base)).toBe(true);
    expect(dedupe.shouldEmitList(base)).toBe(false);
    expect(dedupe.shouldEmitList({ ...base, inventory: '{"version":"2"}', version: '2' })).toBe(
      true
    );
    expect(dedupe.shouldEmitList({ ...base, inventory: '{"version":"2"}', version: '2' })).toBe(
      false
    );
    expect(
      dedupe.shouldEmitList({
        ...base,
        inventory: '{"version":"2"}',
        version: '2',
        transport: 'ws-secure',
        rttMs: 12,
      })
    ).toBe(true);
    expect(
      dedupe.shouldEmitList({
        ...base,
        inventory: '{"version":"2"}',
        version: '2',
        transport: 'ws-secure',
        rttMs: 12,
      })
    ).toBe(false);
    expect(
      dedupe.shouldEmitList({ ...base, inventory: '{"version":"2"}', version: '2', name: 'n2' })
    ).toBe(true);
    expect(
      dedupe.shouldEmitList({
        ...base,
        inventory: '{"version":"2"}',
        version: '2',
        name: 'n2',
        direct_capable: true,
      })
    ).toBe(true);
    expect(
      dedupe.shouldEmitList({
        ...base,
        inventory: '{"version":"2"}',
        version: '2',
        name: 'n2',
        direct_capable: true,
        dcBreaker: {
          cooling: true,
          until: 1,
          failures: 3,
          level: 1,
          lastFailureKind: 'liveness-timeout',
        },
      })
    ).toBe(true);
    expect(
      dedupe.shouldEmitList({
        ...base,
        inventory: '{"version":"2"}',
        version: '2',
        name: 'n2',
        direct_capable: true,
        dcBreaker: {
          cooling: true,
          until: 1,
          failures: 3,
          level: 1,
          lastFailureKind: 'liveness-timeout',
        },
      })
    ).toBe(false);
  });

  test('synthetic offline is de-duped per generation and list can emit online again', () => {
    const dedupe = new NodeEventDedupe();
    const nodeId = 'bb'.repeat(16);
    expect(dedupe.shouldEmitSyntheticOffline(nodeId, 1)).toBe(true);
    expect(dedupe.shouldEmitSyntheticOffline(nodeId, 1)).toBe(false);
    expect(dedupe.shouldEmitList({ nodeId, status: 'online', inventory: '{}' })).toBe(true);
    expect(dedupe.shouldEmitSyntheticOffline(nodeId, 2)).toBe(true);
    expect(dedupe.shouldEmitSyntheticOffline(nodeId, 2)).toBe(false);
  });

  test('revoke removes cached projection and stop clears all', () => {
    const dedupe = new NodeEventDedupe();
    const nodeId = 'cc'.repeat(16);
    expect(dedupe.shouldEmitList({ nodeId, status: 'online' })).toBe(true);
    expect(dedupe.size).toBe(1);
    dedupe.onRevoke(nodeId);
    expect(dedupe.size).toBe(0);
    expect(dedupe.shouldEmitList({ nodeId, status: 'online' })).toBe(true);
    dedupe.clear();
    expect(dedupe.size).toBe(0);
  });

  test('last-emitted map is bounded and evicts oldest', () => {
    const dedupe = new NodeEventDedupe(NODE_EVENT_DEDUPE_MAX);
    const event = (i: number) => ({
      nodeId: i.toString(16).padStart(32, '0'),
      status: 'online' as const,
      inventory: '{}',
    });
    for (let i = 0; i < NODE_EVENT_DEDUPE_MAX + 1; i++) {
      expect(dedupe.shouldEmitList(event(i))).toBe(true);
    }
    expect(dedupe.size).toBe(NODE_EVENT_DEDUPE_MAX);
    expect(dedupe.shouldEmitList(event(0))).toBe(true);
  });
});
