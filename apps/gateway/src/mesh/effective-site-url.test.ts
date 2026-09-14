import { describe, expect, test } from 'bun:test';
import { createMeshSiteSettingsLink, nodeAccessUrl } from './effective-site-url';

const NODE = 'cc'.repeat(16);

describe('nodeAccessUrl', () => {
  test('strips trailing slashes then appends /n/<id>', () => {
    expect(nodeAccessUrl('https://relay.example/', NODE)).toBe(`https://relay.example/n/${NODE}`);
    expect(nodeAccessUrl('https://relay.example', NODE)).toBe(`https://relay.example/n/${NODE}`);
  });
});

describe('createMeshSiteSettingsLink', () => {
  test('pure node without relay uplink returns null so callers fall back to stored site_url', () => {
    const nodeLink = createMeshSiteSettingsLink({
      roles: { node: true, relay: false },
      localNodeId: () => NODE,
    });
    expect(nodeLink.linked()).toBe(true);
    expect(nodeLink.effectiveSiteUrl()).toBeNull();
  });

  test('standalone flags are unlinked', () => {
    const link = createMeshSiteSettingsLink({
      roles: { node: false, relay: false },
      localNodeId: () => NODE,
    });
    expect(link.linked()).toBe(false);
    expect(link.localNodeId()).toBeNull();
    expect(link.effectiveSiteUrl()).toBeNull();
  });

  test('中继上联的节点：站点 URL 不托管、保持可编辑', () => {
    const relayLink = createMeshSiteSettingsLink({
      roles: { node: true, relay: false },
      localNodeId: () => NODE,
      uplinkKind: () => 'relay',
    });
    expect(relayLink.linked()).toBe(true);
    expect(relayLink.effectiveSiteUrl()).toBeNull();
  });

  test('中继上联：存储值是回环地址时退回中继入口 <relay>/n/<self>', () => {
    const link = createMeshSiteSettingsLink({
      roles: { node: true, relay: false },
      localNodeId: () => NODE,
      uplinkKind: () => 'relay',
      storedSiteUrl: () => 'http://127.0.0.1:9883',
      relayAccessUrl: () => `https://relay.example/n/${NODE}`,
    });
    expect(link.effectiveSiteUrl()).toBe(`https://relay.example/n/${NODE}`);
  });

  test('中继上联：存储值本身是公网域名时以存储值为准', () => {
    const link = createMeshSiteSettingsLink({
      roles: { node: true, relay: false },
      localNodeId: () => NODE,
      uplinkKind: () => 'relay',
      storedSiteUrl: () => 'https://box.example.com',
      relayAccessUrl: () => `https://relay.example/n/${NODE}`,
    });
    expect(link.effectiveSiteUrl()).toBe('https://box.example.com');
  });

  test('中继上联：入口未探通时返回 null，调用方回落存储值', () => {
    const link = createMeshSiteSettingsLink({
      roles: { node: true, relay: false },
      localNodeId: () => NODE,
      uplinkKind: () => 'relay',
      storedSiteUrl: () => 'http://127.0.0.1:9883',
      relayAccessUrl: () => null,
    });
    expect(link.effectiveSiteUrl()).toBeNull();
  });
});
