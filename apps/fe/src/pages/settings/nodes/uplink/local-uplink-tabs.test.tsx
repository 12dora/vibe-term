// 本机卡两 tab：初始选中的推导、记忆值、各形态下面板里该出现的东西。
// 无 DOM 测试环境，用 react-dom/server 静态渲染——Base UI 只渲染当前选中的那个面板，
// 因此「面板里有什么」同时也证明了「选中的是哪个 tab」。

import { afterEach, describe, expect, test } from 'bun:test';
import { resetMeshHubsStateForTest } from '@/node/mesh-hubs';
import {
  type UseMeshRelayResult,
  resetMeshRelayStateForTest,
  setMeshRelayStateForTest,
} from '@/node/mesh-relay';
import type { AuthModeResponse } from '@tmex/api-client/auth/index';
import type { LocalRole, LocalStatusResponse } from '@tmex/api-client/local/types';
import type { RelayLinkStatus, RelayUplinkMode } from '@tmex/api-client/relay/tenant-api';
import zhCN from '@tmex/shared/i18n/locales/zh_CN.json';
import { installWindowStorage } from '@tmex/stores/test-utils';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { LocalMachineCard } from '../local-machine-card';
import type { RelayActionsController } from '../relay/use-relay-actions';
import { HubUplinkPanel } from './hub-uplink-panel';
import { useLocalUplinkController } from './local-uplink-controller';
import { RelayUplinkPanel } from './relay-uplink-panel';
import {
  UPLINK_TAB_STORAGE_KEY,
  type UplinkTabStorage,
  deriveUplinkTab,
  readUplinkTab,
  writeUplinkTab,
} from './uplink-tab-preference';

installWindowStorage();

const EMPTY_HUBS = {
  hubs: [],
  candidates: [],
  attached: null,
  writerHubId: null,
  loading: false,
  error: null,
  loadedAt: 1,
};

const STANDALONE_RELAY = {
  mode: 'none',
  relayMode: false,
  quota: null,
  tenantId: null,
  relays: [],
  ordered: [],
  attached: null,
  metaEpoch: 0,
  nodesViaRelay: 0,
  reauthRequired: false,
  readmitPending: 0,
  writable: true,
  kicked: false,
  loading: false,
  error: null,
  loadedAt: null,
  unsupported: false,
  refresh: () => undefined,
} satisfies UseMeshRelayResult;

const IDLE_RELAY_ACTIONS: RelayActionsController = {
  enroll: null,
  confirm: null,
  busy: false,
  error: null,
  openEnroll: () => undefined,
  closeEnroll: () => undefined,
  requestConfirm: () => undefined,
  dismissConfirm: () => undefined,
  submitEnroll: () => Promise.resolve(),
  runConfirm: () => Promise.resolve(),
  readmitMembers: () => Promise.resolve(),
  metaPending: [],
  retryMetaKey: () => Promise.resolve(),
  packPending: false,
  retryPack: () => Promise.resolve(),
};

const MESH_MODE: AuthModeResponse = {
  mode: 'mesh',
  nodeId: '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e',
  uid: 'user-1',
  username: 'alice',
  kdfParams: { salt: 'AAAAAAAAAAAAAAAAAAAAAA', memory_kib: 65536, iterations: 3, parallelism: 1 },
  passkeysForThisOrigin: false,
  passkeyAvailable: false,
  rootEpoch: 0,
};

function status(role: LocalRole): LocalStatusResponse {
  return {
    role,
    nodeEnv: 'production',
    hubUrl: role === 'node' ? 'https://hub.example' : null,
    hubPublicUrl: role === 'hub,node' ? 'https://hub.example' : null,
    direct: {
      supported: true,
      installed: true,
      enabled: true,
      capable: true,
      version: null,
      platform: 'darwin-arm64',
    },
    tls: { mode: 'none', listenerRunning: false, tlsPort: null },
    domainAccess: { allowed: true, viaDomain: false, hosts: [] },
    relay: null,
  };
}

function link(overrides: Partial<RelayLinkStatus> = {}): RelayLinkStatus {
  return {
    url: 'https://relay.example.com:8443',
    priority: 1,
    online: true,
    attached: true,
    rttMs: null,
    lastError: null,
    kicked: false,
    ...overrides,
  };
}

function withRelayMode(mode: RelayUplinkMode, relays: RelayLinkStatus[] = []): void {
  setMeshRelayStateForTest({ mode, relays, loadedAt: 1 });
}

function Harness({
  local,
  mode,
}: {
  local: LocalStatusResponse;
  mode: AuthModeResponse | null;
}) {
  const uplink = useLocalUplinkController({ mode });
  return (
    <LocalMachineCard
      mode={mode}
      status={local}
      loading={false}
      loginRequired={false}
      api={{ setDirect: () => Promise.reject(new Error('unexpected call')) }}
      uplink={uplink}
      onRefresh={() => undefined}
      relaySetup={<span data-testid="relay-setup-slot" />}
    />
  );
}

function render(local: LocalStatusResponse, mode: AuthModeResponse | null = MESH_MODE): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <Harness local={local} mode={mode} />
    </MemoryRouter>
  );
}

function memoryStorage(initial?: string): UplinkTabStorage & { value: string | null } {
  return {
    value: initial ?? null,
    getItem(key: string) {
      return key === UPLINK_TAB_STORAGE_KEY ? this.value : null;
    },
    setItem(key: string, next: string) {
      if (key === UPLINK_TAB_STORAGE_KEY) this.value = next;
    },
  };
}

afterEach(() => {
  resetMeshHubsStateForTest();
  resetMeshRelayStateForTest();
  localStorage.removeItem(UPLINK_TAB_STORAGE_KEY);
});

describe('初始选中的推导', () => {
  test('接了中继就是中继 tab，接了 Hub 就是 Hub tab，都与记忆无关', () => {
    expect(deriveUplinkTab('relay', 'hub')).toBe('relay');
    expect(deriveUplinkTab('hub', 'relay')).toBe('hub');
  });

  test('没有上级时才用记忆值，缺省是 Hub', () => {
    expect(deriveUplinkTab('none', 'relay')).toBe('relay');
    expect(deriveUplinkTab('none', 'hub')).toBe('hub');
  });
});

describe('tab 记忆', () => {
  test('只认两个合法值，读不到 / 读到脏值都退回 Hub', () => {
    expect(readUplinkTab(memoryStorage('relay'))).toBe('relay');
    expect(readUplinkTab(memoryStorage('hub'))).toBe('hub');
    expect(readUplinkTab(memoryStorage('nonsense'))).toBe('hub');
    expect(readUplinkTab(memoryStorage())).toBe('hub');
    expect(readUplinkTab(null)).toBe('hub');
  });

  test('写入落在约定的键上；没有存储时不抛', () => {
    const store = memoryStorage();
    writeUplinkTab('relay', store);
    expect(store.value).toBe('relay');
    expect(() => writeUplinkTab('hub', null)).not.toThrow();
  });
});

describe('两个 tab 的版式', () => {
  test('tab 栏总是两个，三语键都在', () => {
    const html = render(status('node'));
    expect(html).toContain('data-testid="local-uplink-tabs"');
    expect(html).toContain('data-testid="local-uplink-tab-hub"');
    expect(html).toContain('data-testid="local-uplink-tab-relay"');
    expect(zhCN.translation.nodes.machine.uplinkTabHub).toBe('接入 Hub');
    expect(zhCN.translation.nodes.machine.uplinkTabRelay).toBe('接入中继');
  });

  test('hub 模式：Hub tab 选中，中继那边只留「改为接入中继」', () => {
    withRelayMode('hub');
    const html = render(status('node'));
    expect(html).toContain('nodes.machine.currentHub');
    expect(html).not.toContain('data-testid="local-uplink-relay-panel"');
    expect(html).not.toContain('data-testid="nodes-relay-enroll"');
  });

  test('中继模式：中继 tab 选中，链路条与整排操作都摆在明面上', () => {
    withRelayMode('relay', [link()]);
    const html = render(status('node'));
    expect(html).toContain('data-testid="local-uplink-relay-panel"');
    expect(html).toContain('data-testid="nodes-relay-strip"');
    expect(html).toContain('data-testid="nodes-relay-add"');
    expect(html).toContain('data-testid="nodes-relay-reauth-menu"');
    expect(html).toContain('data-testid="nodes-relay-rotate"');
    expect(html).toContain('data-testid="nodes-relay-leave"');
    // 图标菜单已经没有了
    expect(html).not.toContain('data-testid="nodes-relay-menu"');
    // 中继模式下 Hub 那边不摆可操作的版式
    expect(html).not.toContain('nodes.machine.currentHub');
  });

  test('中继模式下多条链路：逐条给出移除入口', () => {
    withRelayMode('relay', [
      link({ url: 'https://a.example' }),
      link({ url: 'https://b.example', attached: false, priority: 2 }),
    ]);
    const html = render(status('node'));
    expect(html).toContain('data-testid="nodes-relay-remove-a.example"');
    expect(html).toContain('data-testid="nodes-relay-remove-b.example"');
  });

  test('中继模式下多条被踢：逐条给出重输口令，不再合并成一个入口', () => {
    withRelayMode('relay', [
      link({ url: 'https://a.example', kicked: true }),
      link({ url: 'https://b.example', kicked: true, attached: false, priority: 2 }),
    ]);
    const html = render(status('node'));
    expect(html).toContain('data-testid="nodes-relay-reauth-a.example"');
    expect(html).toContain('data-testid="nodes-relay-reauth-b.example"');
    expect(html).not.toContain('data-testid="nodes-relay-reauth-menu"');
    expect(html).toContain('data-testid="nodes-relay-reauth"');
  });

  test('没有上级时跟随记忆值：记的是中继就直接落在中继那边', () => {
    withRelayMode('none');
    localStorage.setItem(UPLINK_TAB_STORAGE_KEY, 'relay');
    const html = render(status('node'));
    expect(html).toContain('data-testid="local-uplink-relay-panel"');
    expect(html).toContain('data-testid="nodes-relay-enroll"');
    expect(html).not.toContain('nodes.machine.currentHub');
  });

  test('standalone：Hub tab 里是开启 hub 的向导', () => {
    const html = render(status('standalone'), null);
    expect(html).toContain('data-testid="hub-setup-wizard"');
    expect(html).not.toContain('data-testid="local-uplink-relay-standalone"');
  });
});

describe('中继模式下的 Hub tab', () => {
  test('只留一句说明，指回「接入中继」里离开', () => {
    const html = renderToStaticMarkup(
      <HubUplinkPanel
        localRole="node"
        selfNodeId={MESH_MODE.nodeId}
        status={status('node')}
        hubs={{ ...EMPTY_HUBS, writesBlocked: false }}
        hubOnline={false}
        hubLoading={false}
        hubFailure={null}
        relayMode
        standalone={false}
        changeHubDisabled={false}
        onChangeHub={() => undefined}
        wizardPath={null}
      />
    );
    expect(html).toContain('data-testid="local-uplink-hub-blocked"');
    expect(html).toContain('nodes.machine.uplinkHubBlocked');
    expect(html).not.toContain('data-testid="local-machine-change-hub"');
    expect(zhCN.translation.nodes.machine.uplinkHubBlocked).toContain('接入中继');
  });
});

describe('standalone 的中继 tab', () => {
  test('给一句说明并把「本机作为中继」表单插槽渲染出来', () => {
    const html = renderToStaticMarkup(
      <RelayUplinkPanel
        relay={STANDALONE_RELAY}
        actions={IDLE_RELAY_ACTIONS}
        standalone
        relaySetup={<span data-testid="relay-setup-slot" />}
      />
    );
    expect(html).toContain('data-testid="local-uplink-relay-standalone"');
    expect(html).toContain('nodes.machine.uplinkRelayStandalone');
    expect(html).toContain('data-testid="relay-setup-slot"');
  });
});
