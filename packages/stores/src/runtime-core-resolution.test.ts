import { afterEach, describe, expect, mock, test } from 'bun:test';
import { ApiClient, defaultApiClient } from '@tmex/api-client';
import { type BellPlayer, type NotificationSink, noopNotificationSink } from '@tmex/notifications';
import {
  type GatewayConnection,
  LazyWebSocketGatewayTransport,
  type PaneSink,
  type SelectCallbacks,
  createGatewayConnection,
  createSharedGatewayTransport,
} from '@tmex/ws-client';
import { dispatchPaneOutput, registerPaneSink } from '@tmex/ws-client/pane-sink-registry';
import type { HostServices, TerminalFileLinksProvider } from './runtime';

// runtime.ts 在模块求值时把 playBellSound 固化进 defaultBell，必须先于首次求值替换，
// 否则默认 bell 相关用例会真的去建 AudioContext。
const notificationsActual = await import('@tmex/notifications');
mock.module('@tmex/notifications', () => ({
  ...notificationsActual,
  playBellSound: mock(() => {}),
}));

const { resolveRuntimeCore } = await import('./runtime');

const connections: GatewayConnection[] = [];

function makeConnection(): GatewayConnection {
  const connection = createGatewayConnection({ wsUrl: 'ws://runtime-core.test/ws' });
  connections.push(connection);
  return connection;
}

function collectingSink(events: string[]): PaneSink {
  return {
    onReset: (origin) => {
      events.push(`reset:${origin}`);
    },
    onApplyHistory: (data) => {
      events.push(`history:${data}`);
    },
    onOutput: (data) => {
      events.push(`output:${data.length}`);
    },
  };
}

afterEach(() => {
  for (const connection of connections.splice(0)) connection.dispose();
});

describe('transport 解析优先级', () => {
  test('显式 transport 覆盖连接自带 transport', () => {
    const connection = makeConnection();
    const transport = createSharedGatewayTransport({ initialState: 'READY', onCommand: () => {} });
    expect(resolveRuntimeCore({ connection, transport }).transport).toBe(transport);
    transport.dispose();
  });

  test('无显式 transport 时用连接自带的', () => {
    const connection = makeConnection();
    expect(resolveRuntimeCore({ connection }).transport).toBe(connection.transport);
  });

  test('两者皆无时回落到惰性 WS transport', () => {
    expect(resolveRuntimeCore().transport).toBeInstanceOf(LazyWebSocketGatewayTransport);
  });

  test('惰性回落不在解析时建 client', () => {
    let clientReads = 0;
    const connection = makeConnection();
    const probe: GatewayConnection = {
      ...connection,
      get client() {
        clientReads += 1;
        return connection.client;
      },
      dispose: () => {},
    };
    const core = resolveRuntimeCore({ connection: probe, transport: connection.transport });
    expect(clientReads).toBe(0);
    expect(core.client).toBe(connection.client);
    expect(clientReads).toBe(1);
  });
});

describe('client 解析优先级', () => {
  test('有连接时取连接的 client，且每次读取都重新求值', () => {
    const connection = makeConnection();
    const core = resolveRuntimeCore({ connection });
    expect(core.client).toBe(connection.client);
    expect(core.client).toBe(connection.client);
  });
});

describe('selectMachine 解析优先级', () => {
  test('有连接时复用连接的状态机，并按需注入回调', () => {
    const connection = makeConnection();
    const received: SelectCallbacks[] = [];
    connection.selectMachine.setCallbacks = (callbacks: SelectCallbacks) => {
      received.push(callbacks);
    };
    const core = resolveRuntimeCore({ connection });

    expect(core.selectMachine()).toBe(connection.selectMachine);
    expect(received).toHaveLength(0);

    const callbacks: SelectCallbacks = {};
    expect(core.selectMachine(callbacks)).toBe(connection.selectMachine);
    expect(received).toEqual([callbacks]);
  });

  // 注：模块级 getSelectStateMachine 会被同进程其它测试文件 mock，这里只断言「不走连接分支」
  test('无连接时回落到模块级工厂，而不是任何连接的状态机', () => {
    const connection = makeConnection();
    const received: SelectCallbacks[] = [];
    connection.selectMachine.setCallbacks = (callbacks: SelectCallbacks) => {
      received.push(callbacks);
    };
    const machine = resolveRuntimeCore().selectMachine({});
    expect(machine).not.toBe(connection.selectMachine);
    expect(received).toHaveLength(0);
  });
});

describe('paneSinks 解析优先级', () => {
  test('无连接时直接绑模块级注册表', () => {
    expect(resolveRuntimeCore().paneSinks.registerPaneSink).toBe(registerPaneSink);
    expect(resolveRuntimeCore().paneSinks.dispatchPaneOutput).toBe(dispatchPaneOutput);
  });

  test('有连接时全部转发到连接自己的注册表', () => {
    const connection = makeConnection();
    const core = resolveRuntimeCore({ connection });
    const events: string[] = [];

    expect(core.paneSinks.registerPaneSink).not.toBe(registerPaneSink);
    const unregister = core.paneSinks.registerPaneSink('dev', '%1', collectingSink(events));

    core.paneSinks.dispatchPaneReset('dev', '%1', 'select');
    core.paneSinks.dispatchPaneOutput('dev', '%1', new Uint8Array([1, 2]));
    core.paneSinks.dispatchPaneApplyHistory('dev', '%1', 'hist', false, 0);
    expect(events).toEqual(['reset:select', 'output:2', 'history:hist']);

    // 模块级注册表未被污染：同名 pane 在默认注册表上无 sink
    dispatchPaneOutput('dev', '%1', new Uint8Array([9]));
    expect(events).toHaveLength(3);

    unregister();
  });

  test('history gate 与 cleanup 同样落在连接的注册表上', () => {
    const connection = makeConnection();
    const core = resolveRuntimeCore({ connection });
    const token = new Uint8Array([7, 7]);

    expect(core.paneSinks.dispatchPaneHistory('dev', '%1', token, 'a', false, 0)).toBe(false);
    core.paneSinks.beginPaneHistoryGate('dev', '%1', token);
    expect(core.paneSinks.dispatchPaneHistory('dev', '%1', token, 'a', false, 0)).toBe(true);

    core.paneSinks.beginPaneHistoryGate('dev', '%1', token);
    core.paneSinks.cleanupDevicePaneState('dev');
    expect(core.paneSinks.dispatchPaneHistory('dev', '%1', token, 'a', false, 0)).toBe(false);
  });
});

describe('服务面缺省与覆盖', () => {
  test('注入的 apiClient / notifications / bell / host 原样透传', () => {
    const apiClient = new ApiClient('http://runtime-core.test');
    const notifications: NotificationSink = {
      info: () => {},
      success: () => {},
      warning: () => {},
      error: () => {},
    };
    const bell: BellPlayer = { play: () => {} };
    const host: HostServices = {
      ...resolveRuntimeCore().host,
      navigate: () => {},
    };
    const terminalFileLinks: TerminalFileLinksProvider = {
      listRoots: async () => [],
      stat: async () => null,
      openFile: () => {},
    };
    const core = resolveRuntimeCore({
      apiClient,
      notifications,
      bell,
      host,
      terminalFileLinks,
      storagePrefix: 'prefix:',
    });
    expect(core.apiClient).toBe(apiClient);
    expect(core.notifications).toBe(notifications);
    expect(core.bell).toBe(bell);
    expect(core.host).toBe(host);
    expect(core.terminalFileLinks).toBe(terminalFileLinks);
    expect(core.storagePrefix).toBe('prefix:');
  });

  // 多 node 下没有全局默认接收方：宿主不传就静默，避免一个 node 的通知落到别人的 sink
  test('缺省 notifications 为 noop', () => {
    expect(resolveRuntimeCore().notifications).toBe(noopNotificationSink);
  });

  test('缺省 bell 是跨 runtime 共享的同一实现', () => {
    const bell = resolveRuntimeCore().bell;
    expect(resolveRuntimeCore().bell).toBe(bell);
    expect(resolveRuntimeCore({ bell: { play: () => {} } }).bell).not.toBe(bell);
  });

  test('缺省 storagePrefix 为空串，apiClient 用共享实例，terminalFileLinks 不填充', () => {
    const core = resolveRuntimeCore();
    expect(core.storagePrefix).toBe('');
    expect(core.apiClient).toBe(defaultApiClient);
    expect(core.terminalFileLinks).toBeUndefined();
  });

  test('注入的 t 覆盖 i18next 缺省实现', () => {
    const core = resolveRuntimeCore({ t: (key, params) => `${key}:${JSON.stringify(params)}` });
    expect(core.t('a.b', { x: 1 })).toBe('a.b:{"x":1}');
  });

  test('缺省 t 返回字符串', () => {
    expect(typeof resolveRuntimeCore().t('terminal.copied')).toBe('string');
  });
});

describe('features 解析', () => {
  test('缺省全开，hostManagedNotifications 关', () => {
    expect(resolveRuntimeCore({ features: {} }).features).toEqual({
      agentUi: true,
      watchUi: true,
      filesUi: true,
      hostManagedNotifications: false,
    });
  });

  test.each([
    ['agentUi', { agentUi: false }],
    ['watchUi', { watchUi: false }],
    ['filesUi', { filesUi: false }],
  ] as const)('%s 可单独关断', (flag, features) => {
    const core = resolveRuntimeCore({ features });
    expect(core.features[flag]).toBe(false);
    const others = (['agentUi', 'watchUi', 'filesUi'] as const).filter((key) => key !== flag);
    for (const key of others) expect(core.features[key]).toBe(true);
  });

  test('hostManagedNotifications 可单独开启', () => {
    const core = resolveRuntimeCore({ features: { hostManagedNotifications: true } });
    expect(core.features.hostManagedNotifications).toBe(true);
    expect(core.features.agentUi).toBe(true);
  });
});
