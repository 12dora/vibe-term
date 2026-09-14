// 「通用」标签的改名通道：中继模式改签 `rename-node` 记录。
// 无 DOM 测试环境，用 react-dom/server 静态渲染一个探针组件取出 hook 的返回值
// （store 走 useSyncExternalStore，服务端渲染同样读得到；effect 不跑，也就不会发请求）。

import { afterEach, describe, expect, test } from 'bun:test';
import { resetMeshNodesStateForTest, setMeshNodesStateForTest } from '@/node/mesh-nodes';
import { resetMeshRelayStateForTest, setMeshRelayStateForTest } from '@/node/mesh-relay';
import type { AuthModeResponse } from '@vibeterm/api-client/auth/index';
import type { MeshNode } from '@vibeterm/api-client/auth/index';
import { installWindowStorage } from '@vibeterm/stores/test-utils';
import type { SiteSettingsLinkage } from './site-settings-form';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
const { useNodeRenameChannel } = await import('./use-node-rename-channel');
const { UNLINKED_SITE_SETTINGS } = await import('./site-settings-form');

type Channel = ReturnType<typeof useNodeRenameChannel>;

const NODE = '0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c';

const LINKED: SiteSettingsLinkage = {
  ...UNLINKED_SITE_SETTINGS,
  siteNameLinkedToNode: true,
  siteUrlEditable: false,
  nodeId: NODE,
};

function meshNode(id: string, overrides: Partial<MeshNode> = {}): MeshNode {
  return {
    id,
    name: id.slice(0, 4),
    publicKey: '',
    online: true,
    reach: 'wan',
    version: null,
    direct_capable: false,
    loggedIn: true,
    ...overrides,
  };
}

function channelOf(linkage = LINKED): Channel {
  let captured: Channel | null = null;
  function Probe() {
    captured = useNodeRenameChannel(linkage);
    return null;
  }
  renderToStaticMarkup(<Probe />);
  if (!captured) throw new Error('probe did not render');
  return captured;
}

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  resetMeshNodesStateForTest();
  resetMeshRelayStateForTest();
});

const MESH_MODE: AuthModeResponse = {
  mode: 'mesh',
  nodeId: NODE,
  uid: 'user-1',
  username: 'alice',
  kdfParams: { salt: 'AAAAAAAAAAAAAAAAAAAAAA', memory_kib: 65536, iterations: 3, parallelism: 1 },
  passkeyAvailable: false,
  passkeysForThisOrigin: false,
  rootEpoch: 0,
};

describe('useNodeRenameChannel', () => {
  test('未联动（standalone / 老服务端）：改名不可用', () => {
    setMeshNodesStateForTest({
      nodes: [meshNode(NODE)],
      loadedAt: 1,
    });

    expect(channelOf(UNLINKED_SITE_SETTINGS).canRenameNode).toBe(false);
  });
});

describe('useNodeRenameChannel 中继模式', () => {
  test('挂上中继时改名可用，走 rename-node 记录', async () => {
    setMeshNodesStateForTest({
      nodes: [meshNode(NODE)],
      mode: MESH_MODE,
      modeLoaded: true,
      loadedAt: 1,
    });
    setMeshRelayStateForTest({
      mode: 'relay',
      tenantId: 'aabbccddeeff00112233445566778899',
      relays: [
        {
          url: 'https://relay.example.com',
          priority: 1,
          online: true,
          attached: true,
          rttMs: null,
          lastError: null,
          kicked: false,
        },
      ],
      loadedAt: 1,
    });

    const channel = channelOf();
    expect(channel.canRenameNode).toBe(true);

    const urls: string[] = [];
    globalThis.fetch = ((input: string) => {
      urls.push(String(input));
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as typeof fetch;
    void channel.renameNode(NODE, 'studio');
    await Promise.resolve();
    expect(urls).toEqual([]);
  });

  test('中继模式但没挂上：改名不可用', () => {
    setMeshNodesStateForTest({
      nodes: [meshNode(NODE)],
      mode: MESH_MODE,
      modeLoaded: true,
      loadedAt: 1,
    });
    setMeshRelayStateForTest({ mode: 'relay', relays: [], loadedAt: 1 });

    expect(channelOf().canRenameNode).toBe(false);
  });

  test('未接入中继（mode=none）：改名可用，本机落账', () => {
    setMeshNodesStateForTest({
      nodes: [meshNode(NODE)],
      mode: MESH_MODE,
      modeLoaded: true,
      loadedAt: 1,
    });
    setMeshRelayStateForTest({ mode: 'none', relays: [], loadedAt: 1 });

    expect(channelOf().canRenameNode).toBe(true);
  });
});
