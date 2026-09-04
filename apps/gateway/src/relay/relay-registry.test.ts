import { describe, expect, test } from 'bun:test';
import { createInMemoryLinkPair } from '@tmex/shared/link';
import { RelayRegistry, noteRelayPing, noteRelayPong } from './relay-registry';

function put(
  registry: RelayRegistry,
  opts: { tenantId?: string; nodeId?: string; connectedAt: number }
) {
  const [link] = createInMemoryLinkPair();
  return {
    link,
    result: registry.put({
      tenantId: opts.tenantId ?? 'tenant-a',
      nodeId: opts.nodeId ?? 'node-1',
      link,
      tokenEpoch: 1,
      tokenHash: 'hash',
      protoVersion: 1,
      clientVersion: '1.1.23',
      connectedAt: opts.connectedAt,
    }),
  };
}

describe('RelayRegistry reconnects / RTT', () => {
  test('首次认证 reconnects=0，替换与再次接入递增', () => {
    const registry = new RelayRegistry();
    const first = put(registry, { connectedAt: 1000 });
    expect(first.result.replaced).toBeNull();
    expect(first.result.live.reconnects).toBe(0);
    expect(first.result.live.connectedAt).toBe(1000);
    expect(first.result.live.rttMs).toBeNull();

    const second = put(registry, { connectedAt: 2000 });
    expect(second.result.replaced).toBe(first.result.live);
    expect(second.result.live.reconnects).toBe(1);
    expect(second.result.live.connectedAt).toBe(2000);
    expect(registry.reconnectsOf('tenant-a', 'node-1')).toBe(1);

    registry.removeLink(second.link);
    expect(registry.get('tenant-a', 'node-1')).toBeUndefined();
    expect(registry.reconnectsOf('tenant-a', 'node-1')).toBe(1);

    const third = put(registry, { connectedAt: 3000 });
    expect(third.result.replaced).toBeNull();
    expect(third.result.live.reconnects).toBe(2);
    expect(third.result.live.connectedAt).toBe(3000);
  });

  test('noteRelayPing/Pong 用发出时刻计算 rttMs', () => {
    const registry = new RelayRegistry();
    const { result } = put(registry, { connectedAt: 10 });
    const live = result.live;
    noteRelayPing(live, 100);
    expect(live.pingAt).toBe(100);
    live.awaitingPong = true;
    live.misses = 2;
    noteRelayPong(live, 137);
    expect(live.awaitingPong).toBe(false);
    expect(live.misses).toBe(0);
    expect(live.rttMs).toBe(37);
    expect(live.pingAt).toBeNull();
  });

  test('成员流计数在源和目标上各 +1，释放后归零', () => {
    const registry = new RelayRegistry();
    expect(registry.reserveStream('t', 8)).toBe(true);
    registry.reserveMemberPair('t', 'a', 'b');
    expect(registry.streamCount('t')).toBe(1);
    expect(registry.memberStreamCount('t', 'a')).toBe(1);
    expect(registry.memberStreamCount('t', 'b')).toBe(1);
    registry.releaseMemberPair('t', 'a', 'b');
    registry.releaseStream('t');
    expect(registry.streamCount('t')).toBe(0);
    expect(registry.memberStreamCount('t', 'a')).toBe(0);
    expect(registry.memberStreamCount('t', 'b')).toBe(0);
  });
});
