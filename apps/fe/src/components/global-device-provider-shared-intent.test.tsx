// 走真实组件树的回归测试：路由层（NodeRuntimeBoundary）与侧栏聚合视图（NodeRuntimeScope）
// 会给**同一个 node**各挂一份 GlobalDeviceProvider，这里用同一个 runtime 下嵌套两份 provider
// 忠实建模这个组合（NodeRuntimeScope 的作用就是「同 nodeId → 同 runtime → 再挂一份 provider」）。
//
// 仓库无 DOM 测试环境，只能静态渲染（effect 不执行）。因此「重渲染」用「再渲染一次同样的树」
// 建模：断言的是 provider 暴露出来的连接意图与调用序列，而不是 React 的调度细节。

import { beforeEach, describe, expect, test } from 'bun:test';
import type { AppRuntime } from '@tmex/stores';
import { installWindowStorage } from '@tmex/stores/test-utils';
import type {
  ConnectionState,
  GatewayTransport,
  GatewayTransportCommand,
  GatewayTransportEvent,
} from '@tmex/ws-client';

installWindowStorage();

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createAppRuntime } = await import('@tmex/stores');
const { RuntimeProvider } = await import('@tmex/stores/react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { MemoryRouter } = await import('react-router');
const { GlobalDeviceProvider, useGlobalDevice } = await import('./global-device-provider');
const { deviceIntentStore, resetDeviceIntentStores } = await import('./device-intent-store');

type TransportEventHandler = Parameters<GatewayTransport['onEvent']>[0];

class FakeTransport implements GatewayTransport {
  readonly kind = 'websocket' as const;
  readonly sourceRoute = 'gateway' as const;
  readonly capabilities = {
    sequencedTerminal: true,
    atomicScreen: true,
    cursorHistory: true,
    serverSelection: true,
  };
  readonly hasConnectedOnce = true;
  readonly latencyMs = null;
  readonly serverCapabilities: readonly string[] = [];
  private readonly handlers = new Set<TransportEventHandler>();
  /** 下发给网关的设备连接/断开序列（即「调用序列」的可观测形式）。 */
  readonly deviceCommands: string[] = [];

  connect(): void {}
  disconnect(): void {}
  dispose(): void {}
  getState(): ConnectionState {
    return 'READY';
  }
  isReady(): boolean {
    return true;
  }
  send(command: GatewayTransportCommand): boolean {
    if (command.type === 'connect-device' || command.type === 'disconnect-device') {
      this.deviceCommands.push(`${command.type}:${command.deviceId}`);
    }
    return true;
  }
  onEvent(handler: TransportEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
  emit(event: GatewayTransportEvent): void {
    for (const handler of [...this.handlers]) handler(event);
  }
}

const PREFIX_A = 'n:0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a:';
const PREFIX_B = 'n:0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b:';

function connectedKey(prefix: string): string {
  return `${prefix}tmex:connectedDevices`;
}

function disconnectedKey(prefix: string): string {
  return `${prefix}tmex:disconnectedDevices`;
}

function createRuntime(storagePrefix: string): { runtime: AppRuntime; transport: FakeTransport } {
  const transport = new FakeTransport();
  return { runtime: createAppRuntime({ transport, storagePrefix }), transport };
}

type GlobalDevice = ReturnType<typeof useGlobalDevice>;

function Capture({ into }: { into: GlobalDevice[] }) {
  into.push(useGlobalDevice());
  return null;
}

interface CapturedProviders {
  /** 路由层那份（NodeRuntimeBoundary） */
  route: GlobalDevice[];
  /** 侧栏聚合视图那份（NodeRuntimeScope，同一个 nodeId） */
  sidebar: GlobalDevice[];
}

function renderProviders(runtime: AppRuntime): CapturedProviders {
  const captured: CapturedProviders = { route: [], sidebar: [] };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  renderToStaticMarkup(
    <MemoryRouter initialEntries={['/devices/dev-1']}>
      <RuntimeProvider runtime={runtime}>
        <QueryClientProvider client={queryClient}>
          <GlobalDeviceProvider>
            <Capture into={captured.route} />
            <GlobalDeviceProvider>
              <Capture into={captured.sidebar} />
            </GlobalDeviceProvider>
          </GlobalDeviceProvider>
        </QueryClientProvider>
      </RuntimeProvider>
    </MemoryRouter>
  );
  queryClient.clear();
  return captured;
}

beforeEach(() => {
  localStorage.clear();
  resetDeviceIntentStores();
});

describe('缺陷 2：同一 node 的两份 provider 共享连接意图', () => {
  test('侧栏显式断开后，路由层不会立刻把设备连回来', () => {
    const { runtime, transport } = createRuntime(PREFIX_A);

    // 设备页已自动订阅 dev-1
    runtime.stores.tmux.getState().connectDevice('dev-1');
    expect(transport.deviceCommands).toEqual(['connect-device:dev-1']);
    transport.deviceCommands.length = 0;

    const first = renderProviders(runtime);
    // 侧栏点「断开」
    first.sidebar[0].connection.disconnect('dev-1');

    // 两份 provider 因意图/订阅变化重渲染，路由层再跑一次自动订阅
    const second = renderProviders(runtime);
    second.route[0].ensureDeviceSubscribed('dev-1');

    // 调用序列里 disconnect 之后不再出现 connect，订阅集合也不再含该设备
    expect(transport.deviceCommands).toEqual(['disconnect-device:dev-1']);
    expect(runtime.stores.tmux.getState().connectedDevices.has('dev-1')).toBe(false);

    // 意图落在共享事实源上，而不是某一份 provider 的局部状态
    const intent = deviceIntentStore(PREFIX_A).getSnapshot();
    expect(intent.disconnected.has('dev-1')).toBe(true);
    expect(intent.connected.has('dev-1')).toBe(false);
    expect(second.route[0].connection.isIntentionallyDisconnected('dev-1')).toBe(true);
    expect(second.route[0].connection.status('dev-1')).toBe('disconnected');

    runtime.dispose();
  });

  test('侧栏重新连接后自动订阅恢复（显式断开的抑制可撤销）', () => {
    const { runtime, transport } = createRuntime(PREFIX_A);

    const first = renderProviders(runtime);
    first.sidebar[0].connection.disconnect('dev-1');
    transport.deviceCommands.length = 0;

    const second = renderProviders(runtime);
    second.sidebar[0].connection.connect('dev-1');
    expect(transport.deviceCommands).toEqual(['connect-device:dev-1']);

    const third = renderProviders(runtime);
    expect(third.route[0].connection.isIntentionallyDisconnected('dev-1')).toBe(false);
    third.route[0].ensureDeviceSubscribed('dev-1');
    // 已订阅，不重复下发
    expect(transport.deviceCommands).toEqual(['connect-device:dev-1']);
    expect(runtime.stores.tmux.getState().connectedDevices.has('dev-1')).toBe(true);

    runtime.dispose();
  });
});

describe('缺陷 1：不同 node 的 provider 各用自己的意图与存储键', () => {
  test('A 上的意图不会进入 B 的存储键，也不会被 B 的 provider 采用', () => {
    localStorage.setItem(connectedKey(PREFIX_B), JSON.stringify(['dev-b1']));
    localStorage.setItem(disconnectedKey(PREFIX_B), JSON.stringify(['dev-b2']));

    const { runtime: runtimeA } = createRuntime(PREFIX_A);
    const capturedA = renderProviders(runtimeA);
    capturedA.route[0].connection.disconnect('dev-a1');
    capturedA.route[0].connection.connect('dev-a2');

    const bConnectedRaw = localStorage.getItem(connectedKey(PREFIX_B));
    const bDisconnectedRaw = localStorage.getItem(disconnectedKey(PREFIX_B));

    const { runtime: runtimeB } = createRuntime(PREFIX_B);
    const capturedB = renderProviders(runtimeB);

    expect(capturedB.route[0].connection.isIntentionallyDisconnected('dev-b2')).toBe(true);
    expect(capturedB.route[0].connection.isIntentionallyDisconnected('dev-a1')).toBe(false);
    expect(capturedB.route[0].connection.status('dev-b1')).toBe('disconnected');

    // A 的意图立即落在 A 自己的键上（不靠 effect 写回），B 的两个键分毫未动
    expect(localStorage.getItem(disconnectedKey(PREFIX_A))).toBe(JSON.stringify(['dev-a1']));
    expect(localStorage.getItem(connectedKey(PREFIX_A))).toBe(JSON.stringify(['dev-a2']));
    expect(localStorage.getItem(connectedKey(PREFIX_B))).toBe(bConnectedRaw);
    expect(localStorage.getItem(disconnectedKey(PREFIX_B))).toBe(bDisconnectedRaw);

    runtimeA.dispose();
    runtimeB.dispose();
  });

  test('渲染本身不写任何连接意图键（写入只由显式意图触发）', () => {
    localStorage.setItem(connectedKey(PREFIX_B), JSON.stringify(['dev-b1']));
    const { runtime } = createRuntime(PREFIX_B);

    const writes: string[] = [];
    const setItem = localStorage.setItem.bind(localStorage);
    localStorage.setItem = (key: string, value: string) => {
      if (key.endsWith('tmex:connectedDevices') || key.endsWith('tmex:disconnectedDevices')) {
        writes.push(key);
      }
      setItem(key, value);
    };

    try {
      renderProviders(runtime);
      renderProviders(runtime);
      expect(writes).toEqual([]);
    } finally {
      localStorage.setItem = setItem;
      runtime.dispose();
    }
  });
});
