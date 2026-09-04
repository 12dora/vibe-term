import { beforeAll, describe, expect, test } from 'bun:test';
import type { StateSnapshotPayload } from '@tmex/shared';
import { GATEWAY_CAPABILITY_CANONICAL_STATE_V1_1, wsBorsh } from '@tmex/shared';
import { runMigrations } from '../db/migrate';
import {
  CANONICAL_V11_REQUIRED_PREFIX,
  ERROR_CANONICAL_V11_REQUIRED,
  clientTooOldMessage,
  peerNodeTooOldMessage,
} from './canonical-gate';
import { WebSocketServer } from './index';
import { createBorshTestWs, createGatewaySession, setupConnectionEntry } from './test-helpers';

beforeAll(() => {
  runMigrations();
});

function helloPayload(clientVersion: string): Uint8Array {
  return wsBorsh.encodePayload(wsBorsh.schema.HelloC2SSchema, {
    clientImpl: 'tmex-fe',
    clientVersion,
    maxFrameBytes: wsBorsh.DEFAULT_MAX_FRAME_BYTES,
    supportsCompression: false,
    supportsDiffSnapshot: false,
  });
}

function decodeSent(ws: ReturnType<typeof createBorshTestWs>) {
  return ws.sent.map((frame: Uint8Array) => wsBorsh.decodeEnvelope(frame));
}

describe('HELLO canonical v1.1 版本门槛', () => {
  test('客户端 >= 1.1.23：协商成功并播报 canonical-state-v1.1 能力', async () => {
    const server = new WebSocketServer() as any;
    const ws = createBorshTestWs();
    server.handleOpen(ws);
    await server.handleBorshMessage(ws, wsBorsh.KIND_HELLO_C2S, 1, helloPayload('1.1.23'));

    const frames = decodeSent(ws);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.kind).toBe(wsBorsh.KIND_HELLO_S2C);
    const hello = wsBorsh.decodePayload(
      wsBorsh.schema.HelloS2CSchema,
      frames[0]?.payload as Uint8Array
    );
    expect(hello.capabilities).toContain(GATEWAY_CAPABILITY_CANONICAL_STATE_V1_1);
    expect(ws.borshState.negotiated).toBe(true);
    expect(ws.borshState.clientVersion).toBe('1.1.23');
    expect(ws.closed).toBe(false);
    server.closeSession(ws, 1000, 'test cleanup');
  });

  test('客户端 < 1.1.23：ERROR + 关闭会话，不回退 legacy', async () => {
    const server = new WebSocketServer() as any;
    const ws = createBorshTestWs();
    server.handleOpen(ws);
    await server.handleBorshMessage(ws, wsBorsh.KIND_HELLO_C2S, 7, helloPayload('1.1.22'));

    const frames = decodeSent(ws);
    expect(frames[0]?.kind).toBe(wsBorsh.KIND_ERROR);
    const error = wsBorsh.decodePayload(
      wsBorsh.schema.ErrorSchema,
      frames[0]?.payload as Uint8Array
    );
    expect(error.code).toBe(ERROR_CANONICAL_V11_REQUIRED);
    expect(error.code).toBe(wsBorsh.ERROR_UNSUPPORTED_PROTOCOL);
    expect(error.refSeq).toBe(7);
    // message 即契约：前端按它解析出「谁太旧 + 版本」，这里逐字比对
    expect(error.message).toBe(
      wsBorsh.formatCanonicalV11RequiredError({ side: 'client', version: '1.1.22' })
    );
    expect(error.message).toBe('canonical-state-v1.1 required: client 1.1.22 < 1.1.23');
    expect(error.retryable).toBe(false);
    expect(ws.borshState.negotiated).toBe(false);
    expect(ws.closed).toBe(true);
  });

  test('无法解析的 clientVersion 一律 fail-closed', async () => {
    for (const version of ['', 'test', '1.1', 'v1.1.23']) {
      const server = new WebSocketServer() as any;
      const ws = createBorshTestWs();
      server.handleOpen(ws);
      await server.handleBorshMessage(ws, wsBorsh.KIND_HELLO_C2S, 1, helloPayload(version));
      expect(decodeSent(ws)[0]?.kind).toBe(wsBorsh.KIND_ERROR);
      expect(ws.closed).toBe(true);
    }
  });
});

describe('canonical v1.1 拒绝 message 契约', () => {
  test('两条 message 都由共享模块拼装，前端可解析回 side / 节点 / 版本', () => {
    expect(CANONICAL_V11_REQUIRED_PREFIX).toBe(wsBorsh.CANONICAL_V11_REQUIRED_ERROR_PREFIX);
    expect(clientTooOldMessage('1.1.22')).toBe(
      'canonical-state-v1.1 required: client 1.1.22 < 1.1.23'
    );
    expect(peerNodeTooOldMessage('node-a', null)).toBe(
      'canonical-state-v1.1 required: node node-a version unknown < 1.1.23'
    );
    expect(
      wsBorsh.parseCanonicalV11RequiredError(
        ERROR_CANONICAL_V11_REQUIRED,
        peerNodeTooOldMessage('node-a', '1.1.22_dev')
      )
    ).toEqual({ side: 'node', nodeId: 'node-a', version: '1.1.22_dev' });
    expect(
      wsBorsh.parseCanonicalV11RequiredError(
        ERROR_CANONICAL_V11_REQUIRED,
        clientTooOldMessage(null)
      )
    ).toEqual({ side: 'client', nodeId: null, version: null });
  });
});

function snapshotWith(cols: number, rows: number): StateSnapshotPayload {
  return {
    deviceId: 'device-a',
    session: {
      id: '$1',
      name: 'tmex',
      windows: [
        {
          id: '@1',
          name: 'w',
          index: 0,
          active: true,
          panes: [
            {
              id: '%0',
              windowId: '@1',
              index: 0,
              title: 't',
              active: true,
              width: cols,
              height: rows,
            },
          ],
        },
      ],
    },
  };
}

function setupResizeServer(cols = 80, rows = 24) {
  const server = new WebSocketServer() as any;
  const resizePaneCalls: Array<[string, number, number]> = [];
  setupConnectionEntry(server, {
    lastSnapshot: snapshotWith(cols, rows),
    runtime: {
      requestSnapshot() {},
      resizePane(paneId: string, cols: number, rows: number) {
        resizePaneCalls.push([paneId, cols, rows]);
      },
      resizeWindow() {},
    },
  });
  return { server, resizePaneCalls };
}

describe('canonical v1.1 尺寸 reason/epoch', () => {
  test('epoch 低于已接受值的尺寸被丢弃', () => {
    const { server, resizePaneCalls } = setupResizeServer();
    const session = createGatewaySession();

    server.handleCanonicalResize(session, {
      deviceId: 'device-a',
      paneId: '%0',
      cols: 100,
      rows: 30,
      reason: wsBorsh.CANONICAL_GEOMETRY_REASON_CHANGE,
      sizeEpoch: 5n,
    });
    expect(resizePaneCalls).toEqual([['%0', 100, 30]]);

    // 过期 epoch：整条命令忽略
    server.handleCanonicalResize(session, {
      deviceId: 'device-a',
      paneId: '%0',
      cols: 60,
      rows: 20,
      reason: wsBorsh.CANONICAL_GEOMETRY_REASON_CHANGE,
      sizeEpoch: 4n,
    });
    expect(resizePaneCalls).toEqual([['%0', 100, 30]]);
    expect(session.paneSizeEpochs.get('device-a\0%0')).toBe(5n);
  });

  test('change 被快照几何去重，同 epoch 的 resend 仍重新下发', () => {
    // 快照 live 几何已经是 100x30
    const { server, resizePaneCalls } = setupResizeServer(100, 30);
    const session = createGatewaySession();

    // change：live 几何一致 → 去重，不下发
    server.handleCanonicalResize(session, {
      deviceId: 'device-a',
      paneId: '%0',
      cols: 100,
      rows: 30,
      reason: wsBorsh.CANONICAL_GEOMETRY_REASON_CHANGE,
      sizeEpoch: 1n,
    });
    expect(resizePaneCalls).toEqual([]);

    // resend：不信任快照几何（暖切换/重连后 tmux 侧可能已漂移）→ 强制下发
    server.handleCanonicalResize(session, {
      deviceId: 'device-a',
      paneId: '%0',
      cols: 100,
      rows: 30,
      reason: wsBorsh.CANONICAL_GEOMETRY_REASON_RESEND,
      sizeEpoch: 1n,
    });
    expect(resizePaneCalls).toEqual([['%0', 100, 30]]);
  });

  test('断开设备时清掉该设备的尺寸 epoch', () => {
    const { server } = setupResizeServer();
    const session = createGatewaySession();
    server.handleCanonicalResize(session, {
      deviceId: 'device-a',
      paneId: '%0',
      cols: 100,
      rows: 30,
      reason: wsBorsh.CANONICAL_GEOMETRY_REASON_CHANGE,
      sizeEpoch: 3n,
    });
    expect(session.paneSizeEpochs.size).toBe(1);

    server.dropPaneSizeEpochs(session, 'device-b');
    expect(session.paneSizeEpochs.size).toBe(1);
    server.dropPaneSizeEpochs(session, 'device-a');
    expect(session.paneSizeEpochs.size).toBe(0);
  });

  test('pane 增删后快照对账清掉已消失 pane 的尺寸 epoch', () => {
    const { server } = setupResizeServer();
    const session = createGatewaySession();
    const entry = server.connections.get('device-a');
    entry.clients.add(session);

    let epoch = 0n;
    for (const paneId of ['%0', '%1', '%2', '%3']) {
      epoch += 1n;
      server.handleCanonicalResize(session, {
        deviceId: 'device-a',
        paneId,
        cols: 100,
        rows: 30,
        reason: wsBorsh.CANONICAL_GEOMETRY_REASON_CHANGE,
        sizeEpoch: epoch,
      });
    }
    expect(session.paneSizeEpochs.size).toBe(4);

    // 快照里只剩 %0：其余三个 pane 已经不存在，epoch 不该继续挂着。
    server.installStateSnapshot('device-a', snapshotWith(80, 24));
    expect([...session.paneSizeEpochs.keys()]).toEqual(['device-a\0%0']);

    // 别的设备不受影响
    session.paneSizeEpochs.set('device-b\0%9', 1n);
    server.installStateSnapshot('device-a', snapshotWith(80, 24));
    expect(session.paneSizeEpochs.has('device-b\0%9')).toBe(true);
  });
});
