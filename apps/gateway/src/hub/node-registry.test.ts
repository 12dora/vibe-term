import { describe, expect, test } from 'bun:test';
import { createInMemoryLinkPair } from '@tmex/shared/link';
import { NodeRegistry } from './node-registry';

describe('NodeRegistry', () => {
  test('put / get / listForBroadcast', () => {
    const [a] = createInMemoryLinkPair();
    const [b] = createInMemoryLinkPair();
    const registry = new NodeRegistry();
    registry.put({
      nodeId: 'n1',
      userId: 'u1',
      link: a,
      meta: registry.emptyMeta('one'),
      lastSeen: 1,
      authenticated: true,
    });
    registry.put({
      nodeId: 'n2',
      userId: 'u2',
      link: b,
      meta: registry.emptyMeta('two'),
      lastSeen: 1,
      authenticated: true,
    });
    expect(registry.get('n1')?.userId).toBe('u1');
    expect(registry.listForBroadcast('u1')).toHaveLength(1);
    expect(registry.listForBroadcast('u2')).toHaveLength(1);
    a.close();
    b.close();
  });

  test('同一 nodeId 再次 put 会关闭旧 link', async () => {
    const [oldNode, oldHub] = createInMemoryLinkPair();
    const [newNode, newHub] = createInMemoryLinkPair();
    const registry = new NodeRegistry();
    registry.put({
      nodeId: 'n1',
      userId: 'u1',
      link: oldHub,
      meta: registry.emptyMeta(),
      lastSeen: 1,
      authenticated: true,
    });
    const closed = oldHub.closed;
    registry.put({
      nodeId: 'n1',
      userId: 'u1',
      link: newHub,
      meta: registry.emptyMeta(),
      lastSeen: 2,
      authenticated: true,
    });
    const info = await closed;
    expect(info.reason).toBe('replaced');
    expect(registry.get('n1')?.link).toBe(newHub);
    oldNode.close();
    newNode.close();
    newHub.close();
  });
});
