// 「通用」标签的改名通道：hub 模式必须打给当前的写者 hub，中继模式改签 `rename-node` 记录。
// 无 DOM 测试环境，用 react-dom/server 静态渲染一个探针组件取出 hook 的返回值
// （store 走 useSyncExternalStore，服务端渲染同样读得到；effect 不跑，也就不会发请求）。

import { afterEach, describe, expect, test } from 'bun:test';
import { resetMeshHubsStateForTest, setMeshHubsStateForTest } from '@/node/mesh-hubs';
import { resetMeshNodesStateForTest, setMeshNodesStateForTest } from '@/node/mesh-nodes';
import { resetMeshRelayStateForTest, setMeshRelayStateForTest } from '@/node/mesh-relay';
import type { AuthModeResponse } from '@tmex/api-client/auth/index';
import type { MeshHubEndpoint, MeshNode } from '@tmex/api-client/auth/index';
import { installWindowStorage } from '@tmex/stores/test-utils';
import type { SiteSettingsLinkage } from './site-settings-form';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
const { useNodeRenameChannel } = await import('./use-node-rename-channel');
const { UNLINKED_SITE_SETTINGS } = await import('./site-settings-form');

type Channel = ReturnType<typeof useNodeRenameChannel>;

const HUB_A = '0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a';
const HUB_B = '0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b';
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

function hubEndpoint(nodeId: string, overrides: Partial<MeshHubEndpoint> = {}): MeshHubEndpoint {
  return {
    nodeId,
    publicUrl: `https://${nodeId.slice(0, 4)}.example`,
    mode: 'active',
    priority: 0,
    writerEpoch: 1,
    ...overrides,
  };
}

/** 静态渲染一次探针，取出 hook 的返回值。 */
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
  resetMeshHubsStateForTest();
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
  hubNodeId: HUB_B,
  hubPublicUrl: 'https://0b0b.example',
};

describe('useNodeRenameChannel', () => {
  test('两台 hub 且列表里排在前面的是备机：改名打给写者', async () => {
    setMeshNodesStateForTest({
      nodes: [
        meshNode(HUB_A, { isHub: true, hubMode: 'standby' }),
        meshNode(HUB_B, { isHub: true, hubMode: 'active' }),
        meshNode(NODE),
      ],
      loadedAt: 1,
    });
    setMeshHubsStateForTest({
      hubs: [hubEndpoint(HUB_A, { mode: 'standby' }), hubEndpoint(HUB_B)],
      writerHubId: HUB_B,
      attached: null,
      loadedAt: 1,
    });

    const channel = channelOf();

    const urls: string[] = [];
    globalThis.fetch = ((input: string) => {
      urls.push(String(input));
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as typeof fetch;
    await channel.renameNode(NODE, 'studio');

    expect(urls).toEqual([`/n/${HUB_B}/api/hub/nodes/${NODE}/rename`]);
  });

  test('hub 集合还没拉到 writer：退回 mesh 列表里的 hub 机，不至于整块失能', async () => {
    setMeshNodesStateForTest({
      nodes: [meshNode(HUB_A, { isHub: true }), meshNode(NODE)],
      loadedAt: 1,
    });

    const urls: string[] = [];
    globalThis.fetch = ((input: string) => {
      urls.push(String(input));
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as typeof fetch;
    await channelOf().renameNode(NODE, 'studio');

    expect(urls).toEqual([`/n/${HUB_A}/api/hub/nodes/${NODE}/rename`]);
  });

  test('未联动（standalone / 老服务端）：改名不可用', () => {
    setMeshNodesStateForTest({
      nodes: [meshNode(HUB_A, { isHub: true })],
      loadedAt: 1,
    });

    expect(channelOf(UNLINKED_SITE_SETTINGS).canRenameNode).toBe(false);
  });

  test('挂在备 hub 上（写入被拒）时改名不可用', () => {
    setMeshNodesStateForTest({
      nodes: [meshNode(HUB_B, { isHub: true }), meshNode(NODE)],
      loadedAt: 1,
    });
    setMeshHubsStateForTest({
      hubs: [hubEndpoint(HUB_A, { mode: 'standby' }), hubEndpoint(HUB_B)],
      writerHubId: HUB_B,
      attached: {
        hubNodeId: HUB_A,
        publicUrl: 'https://0a0a.example',
        mode: 'standby',
        writerEpoch: 0,
        since: 1,
      },
      loadedAt: 1,
    });

    expect(channelOf().canRenameNode).toBe(false);
  });
});

describe('useNodeRenameChannel 中继模式', () => {
  test('挂上中继时改名可用，走 rename-node 记录而不是 hub 控制面', async () => {
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
    // 没有凭据对话框可点，`withSigner` 会一直挂着；这里只验证「不打 hub 控制面」。
    void channel.renameNode(NODE, 'studio');
    await Promise.resolve();
    expect(urls).toEqual([]);
  });

  test('一条中继都没挂上：改名不可用', () => {
    setMeshNodesStateForTest({
      nodes: [meshNode(NODE)],
      mode: MESH_MODE,
      modeLoaded: true,
      loadedAt: 1,
    });
    setMeshRelayStateForTest({ mode: 'relay', relays: [], loadedAt: 1 });

    expect(channelOf().canRenameNode).toBe(false);
  });
});
