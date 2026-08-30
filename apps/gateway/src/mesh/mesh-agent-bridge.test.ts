import { describe, expect, test } from 'bun:test';
import { lookupRemoteNode } from './mesh-agent-bridge';

describe('lookupRemoteNode', () => {
  const nodeId = 'peer-1';

  test('unknown when peer is not in reach map', () => {
    expect(lookupRemoteNode(nodeId, new Map(), new Set([nodeId]))).toBe('unknown');
  });

  test('hub online + idle link → online', () => {
    expect(lookupRemoteNode(nodeId, new Map([[nodeId, null]]), new Set([nodeId]))).toBe('online');
  });

  test('hub offline + live direct link → online', () => {
    expect(lookupRemoteNode(nodeId, new Map([[nodeId, 'lan']]), new Set())).toBe('online');
    expect(lookupRemoteNode(nodeId, new Map([[nodeId, 'wan']]), new Set())).toBe('online');
    expect(lookupRemoteNode(nodeId, new Map([[nodeId, 'relay']]), new Set())).toBe('online');
  });

  test('hub offline + idle link → offline', () => {
    expect(lookupRemoteNode(nodeId, new Map([[nodeId, null]]), new Set())).toBe('offline');
  });
});
