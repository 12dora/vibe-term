import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { StateSnapshotPayload } from '@tmex/shared';
import { wsBorsh } from '@tmex/shared';
import { agentWsHub } from '../agent/ws-hub';
import { runMigrations } from '../db/migrate';
import { WebSocketServer } from './index';
import { type ShareWsService, setShareWsServiceResolver } from './share-hooks';
import type { ShareScope } from './share-scope';
import { createBorshTestWs, setupConnectionEntry } from './test-helpers';
import type { GatewaySocketData } from './types';

const SCOPE: ShareScope = { shareId: 'sh1', deviceId: 'device-a', windowId: '@1' };

function snapshot(): StateSnapshotPayload {
  return {
    deviceId: SCOPE.deviceId,
    session: {
      id: '$0',
      name: 'tmex',
      windows: [
        {
          id: '@1',
          name: 'build',
          index: 0,
          active: true,
          panes: [{ id: '%1', windowId: '@1', index: 0, active: true, width: 80, height: 24 }],
        },
        {
          id: '@2',
          name: 'secret',
          index: 1,
          active: false,
          panes: [{ id: '%9', windowId: '@2', index: 0, active: true, width: 80, height: 24 }],
        },
      ],
    },
  };
}

function helloPayload(): Uint8Array {
  return wsBorsh.encodePayload(wsBorsh.schema.HelloC2SSchema, {
    clientImpl: 'tmex-fe',
    clientVersion: '1.1.33',
    maxFrameBytes: wsBorsh.DEFAULT_MAX_FRAME_BYTES,
    supportsCompression: false,
    supportsDiffSnapshot: false,
  });
}

beforeAll(() => {
  runMigrations();
});

afterEach(() => {
  setShareWsServiceResolver(null);
});

describe('share session index', () => {
  test('handleOpen 带 scope 时登记，closeShareSessions 用 4410 断开', () => {
    const server = new WebSocketServer();
    const first = createBorshTestWs();
    const second = createBorshTestWs();
    server.handleOpen(first, { shareScope: SCOPE });
    server.handleOpen(second, { shareScope: SCOPE });

    expect(server.countShareSessions(SCOPE.shareId)).toBe(2);
    expect(first.shareScope).toEqual(SCOPE);

    expect(server.closeShareSessions(SCOPE.shareId)).toBe(2);
    expect(server.countShareSessions(SCOPE.shareId)).toBe(0);
    for (const session of [first, second]) {
      expect(session.closed).toBe(true);
      expect(session.data.carrier).toBeDefined();
    }
    const carrier = first.data.carrier as unknown as {
      closeCalls: Array<{ code: number; reason: string }>;
    };
    expect(carrier.closeCalls).toEqual([{ code: 4410, reason: 'SHARE_ENDED' }]);
  });

  test('连接自行断开后从索引中移除', () => {
    const server = new WebSocketServer();
    const session = createBorshTestWs();
    server.handleOpen(session, { shareScope: SCOPE });
    expect(server.countShareSessions(SCOPE.shareId)).toBe(1);
    server.closeSession(session, 1006, 'client disconnected');
    expect(server.countShareSessions(SCOPE.shareId)).toBe(0);
    expect(server.closeShareSessions(SCOPE.shareId)).toBe(0);
  });

  test('通过 ws.data.shareScope 升级的连接同样被登记', () => {
    const server = new WebSocketServer();
    const socket = {
      data: { shareScope: SCOPE } as unknown as GatewaySocketData,
      send: () => 1,
      close: () => {},
      readyState: 1,
    };
    server.handleOpen(socket as never);
    expect(server.countShareSessions(SCOPE.shareId)).toBe(1);
    expect(socket.data.session.shareScope).toEqual(SCOPE);
  });

  test('分享服务注册后接管断开与在线人数', () => {
    let ended!: (shareId: string) => void;
    let counter!: (shareId: string) => number;
    const service: ShareWsService = {
      recordInput: () => {},
      recordResize: () => {},
      onEnded: (listener) => {
        ended = listener;
        return () => {};
      },
      setViewerCounter: (fn) => {
        counter = fn;
      },
    };
    setShareWsServiceResolver(() => service);

    const server = new WebSocketServer();
    const session = createBorshTestWs();
    server.handleOpen(session, { shareScope: SCOPE });
    expect(counter(SCOPE.shareId)).toBe(1);

    ended(SCOPE.shareId);
    expect(session.closed).toBe(true);
    expect(counter(SCOPE.shareId)).toBe(0);
  });
});

describe('share session broadcast isolation', () => {
  test('主题 / 设置 / 通知广播跳过分享连接', () => {
    const server = new WebSocketServer();
    const normal = createBorshTestWs();
    const shared = createBorshTestWs();
    server.handleOpen(normal);
    server.handleOpen(shared, { shareScope: SCOPE });

    server.broadcastSettingsUpdate('site');
    server.broadcastEventNotify('device_disconnect', {
      type: 'device_disconnect',
      timestamp: new Date().toISOString(),
      data: {},
    } as never);

    expect(normal.sent.length).toBe(2);
    expect(shared.sent.length).toBe(0);
  });

  test('分享连接不进 agent hub，收不到 WATCH_EVENT', async () => {
    const server = new WebSocketServer();
    const shared = createBorshTestWs();
    server.handleOpen(shared, { shareScope: SCOPE });
    await server.handleBorshMessage(shared, wsBorsh.KIND_HELLO_C2S, 1, helloPayload());
    const helloFrames = shared.sent.length;
    expect(helloFrames).toBeGreaterThan(0);

    agentWsHub.broadcastWatchEvent('rule-1', SCOPE.deviceId, '%1', 1 as never, {} as never);
    expect(shared.sent.length).toBe(helloFrames);
    server.closeSession(shared, 1000, 'cleanup');
  });

  test('设备事件只在 pane 属于 scope window 时投递给分享连接', async () => {
    const server = new WebSocketServer();
    const normal = createBorshTestWs();
    const shared = createBorshTestWs();
    server.handleOpen(normal);
    server.handleOpen(shared, { shareScope: SCOPE });
    const entry = setupConnectionEntry(server, {
      deviceId: SCOPE.deviceId,
      clients: new Set([normal, shared]),
      lastSnapshot: snapshot(),
    });

    await server.broadcastTmuxEvent(SCOPE.deviceId, { type: 'bell', data: { paneId: '%1' } });
    expect(normal.sent.length).toBe(1);
    expect(shared.sent.length).toBe(1);

    await server.broadcastTmuxEvent(SCOPE.deviceId, { type: 'bell', data: { paneId: '%9' } });
    expect(normal.sent.length).toBe(2);
    expect(shared.sent.length).toBe(1);

    server.broadcastDeviceEvent(entry, { deviceId: SCOPE.deviceId, type: 'disconnected' });
    expect(normal.sent.length).toBe(3);
    expect(shared.sent.length).toBe(1);
  });
});

describe('share pane scope oracle', () => {
  test('按设备最新快照判定 pane 归属，快照缺失时拒绝', () => {
    const server = new WebSocketServer();
    const shared = createBorshTestWs();
    server.handleOpen(shared, { shareScope: SCOPE });
    const oracle = server.sharePaneOracle(shared);

    expect(oracle(SCOPE.deviceId, '%1')).toBe(false);
    const entry = setupConnectionEntry(server, {
      deviceId: SCOPE.deviceId,
      lastSnapshot: snapshot(),
    });
    expect(oracle(SCOPE.deviceId, '%1')).toBe(true);
    expect(oracle(SCOPE.deviceId, '%9')).toBe(false);
    expect(oracle('device-b', '%1')).toBe(false);

    const moved = snapshot();
    moved.session?.windows[1]?.panes.push({
      id: '%1',
      windowId: '@2',
      index: 1,
      active: false,
      width: 80,
      height: 24,
    });
    if (moved.session) moved.session.windows[0].panes = [];
    entry.lastSnapshot = moved;
    expect(oracle(SCOPE.deviceId, '%1')).toBe(false);
  });

  test('普通连接不受 scope 限制', () => {
    const server = new WebSocketServer();
    const normal = createBorshTestWs();
    server.handleOpen(normal);
    expect(server.sharePaneOracle(normal)('device-b', '%9')).toBe(true);
  });
});
