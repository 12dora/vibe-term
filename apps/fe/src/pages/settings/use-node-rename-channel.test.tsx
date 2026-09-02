// 「通用」标签的改名通道：必须打给当前的写者 hub。
// 无 DOM 测试环境，用 react-dom/server 静态渲染一个探针组件取出 hook 的返回值
// （store 走 useSyncExternalStore，服务端渲染同样读得到；effect 不跑，也就不会发请求）。

import { afterEach, describe, expect, test } from 'bun:test';
import { resetMeshHubsStateForTest, setMeshHubsStateForTest } from '@/node/mesh-hubs';
import { resetMeshNodesStateForTest, setMeshNodesStateForTest } from '@/node/mesh-nodes';
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
});

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
    expect(channel.hubApi?.hubNodeId).toBe(HUB_B);

    const urls: string[] = [];
    globalThis.fetch = ((input: string) => {
      urls.push(String(input));
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as typeof fetch;
    await channel.hubApi?.rename(NODE, 'studio');

    expect(urls).toEqual([`/n/${HUB_B}/api/hub/nodes/${NODE}/rename`]);
  });

  test('hub 集合还没拉到 writer：退回 mesh 列表里的 hub 机，不至于整块失能', () => {
    setMeshNodesStateForTest({
      nodes: [meshNode(HUB_A, { isHub: true }), meshNode(NODE)],
      loadedAt: 1,
    });

    expect(channelOf().hubApi?.hubNodeId).toBe(HUB_A);
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
