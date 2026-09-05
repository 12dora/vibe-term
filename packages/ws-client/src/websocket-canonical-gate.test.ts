import { describe, expect, test } from 'bun:test';
import { GATEWAY_CAPABILITY_CANONICAL_STATE_V1_1, wsBorsh } from '@tmex/shared';
import { BorshWebSocketClient } from './client';
import { type BinaryFakeSocket, createFakeSocket, helloFrame } from './test-fakes';
import { WebSocketGatewayTransport } from './websocket-transport';

const CANONICAL = [GATEWAY_CAPABILITY_CANONICAL_STATE_V1_1];
/** 本套用例统一的 HELLO 基线：新版网关 + 60s 心跳。 */
const HELLO_BASE = { serverVersion: '1.2.0', heartbeatIntervalMs: 60_000 } as const;

function nodeTooOld(nodeId: string, version: string): Uint8Array {
  return wsBorsh.encodeEnvelope(
    wsBorsh.KIND_ERROR,
    wsBorsh.encodePayload(wsBorsh.schema.ErrorSchema, {
      refSeq: null,
      code: wsBorsh.ERROR_UNSUPPORTED_PROTOCOL,
      message: wsBorsh.formatCanonicalV11RequiredError({ side: 'node', nodeId, version }),
      retryable: false,
    }),
    2
  );
}

function createHarness() {
  const socket = createFakeSocket({ binary: true });
  const client = new BorshWebSocketClient({
    url: 'ws://example.test/ws',
    socketFactory: () => socket,
    heartbeatIntervalMs: 60_000,
  });
  const transport = new WebSocketGatewayTransport(client);
  const events: string[] = [];
  const tooOld: Array<{
    side: string;
    minVersion: string;
    version: string | null;
    nodeId?: string | null;
  }> = [];
  transport.onEvent((event) => {
    if (event.type === 'state-feed-mode') events.push(event.mode);
    if (event.type === 'server-too-old') {
      tooOld.push({
        side: event.side,
        minVersion: event.minVersion,
        version: event.version,
        nodeId: event.nodeId,
      });
    }
  });
  transport.connect();
  return { socket, client, transport, events, tooOld };
}

function stubDocument(): {
  setVisibility(value: string): void;
  dispatch(): void;
  restore(): void;
} {
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: 'hidden',
    addEventListener(type: string, handler: () => void) {
      if (type === 'visibilitychange') listeners.add(handler);
    },
    removeEventListener(type: string, handler: () => void) {
      if (type === 'visibilitychange') listeners.delete(handler);
    },
  };
  const hadDocument = 'document' in globalThis;
  const previous = Reflect.get(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true });
  return {
    setVisibility(value) {
      doc.visibilityState = value;
    },
    dispatch() {
      for (const listener of [...listeners]) listener();
    },
    restore() {
      if (hadDocument) {
        Object.defineProperty(globalThis, 'document', {
          value: previous,
          configurable: true,
        });
      } else {
        Reflect.deleteProperty(globalThis, 'document');
      }
    },
  };
}

function businessKinds(socket: BinaryFakeSocket): number[] {
  return socket.sent
    .map((frame) => wsBorsh.decodeEnvelope(frame).kind)
    .filter((kind) => kind !== wsBorsh.KIND_HELLO_C2S && kind !== wsBorsh.KIND_PING);
}

describe('canonical state capability gate', () => {
  test('forwards visible page transitions to canonical subscription recovery', () => {
    const doc = stubDocument();
    try {
      const { transport } = createHarness();
      const canonical = Reflect.get(transport, 'canonical') as {
        resumeSubscriptions(): unknown;
      };
      const resume = canonical.resumeSubscriptions.bind(canonical);
      let calls = 0;
      canonical.resumeSubscriptions = () => {
        calls += 1;
        return resume();
      };

      doc.dispatch();
      expect(calls).toBe(0);
      doc.setVisibility('visible');
      doc.dispatch();
      expect(calls).toBe(1);

      transport.disconnect();
      transport.dispose();
    } finally {
      doc.restore();
    }
  });

  test('delays typed subscriptions until HELLO and selects canonical when advertised', () => {
    const { socket, client, transport, events } = createHarness();
    expect(transport.send({ type: 'connect-device', deviceId: 'device-a' })).toBe('queued');
    expect(
      transport.send({
        type: 'set-pane-subscriptions',
        deviceId: 'device-a',
        generation: 1n,
        paneIds: ['%1'],
      })
    ).toBe('queued');
    socket.open();
    socket.deliver(helloFrame({ ...HELLO_BASE, capabilities: CANONICAL }));

    expect(client.stateFeedMode).toBe('canonical');
    expect(transport.stateFeedMode).toBe('canonical');
    expect(transport.capabilities).toMatchObject({
      sequencedTerminal: true,
      atomicScreen: true,
      cursorHistory: true,
    });
    expect(events).toEqual(['canonical']);
    expect(businessKinds(socket)).toEqual([
      wsBorsh.KIND_CANONICAL_COMMAND,
      wsBorsh.KIND_DEVICE_CONNECT,
      wsBorsh.KIND_CANONICAL_COMMAND,
    ]);
    // 0x020d = 已删除的 legacy TMUX_SUBSCRIBE_PANES，canonical 会话不得再发
    expect(businessKinds(socket)).not.toContain(0x020d);
    transport.disconnect();
  });

  test('缺 canonical-state-v1.1 能力时不降级，只报 server-too-old', () => {
    const { socket, client, transport, events, tooOld } = createHarness();
    transport.send({
      type: 'set-pane-subscriptions',
      deviceId: 'device-a',
      generation: 1n,
      paneIds: ['%1'],
    });
    socket.open();
    socket.deliver(helloFrame(HELLO_BASE));

    expect(client.stateFeedMode).toBe('unsupported');
    expect(transport.capabilities.atomicScreen).toBe(false);
    expect(events).toEqual(['unsupported']);
    expect(tooOld).toEqual([
      {
        side: 'gateway',
        minVersion: wsBorsh.CANONICAL_V11_MIN_PEER_VERSION,
        version: '1.2.0',
        nodeId: null,
      },
    ]);
    // legacy 订阅帧已下线：没有任何业务帧发出去
    expect(businessKinds(socket)).toEqual([]);
    transport.disconnect();
  });

  test('服务端版本低于 1.1.23 时即使播报能力也拒建 canonical 会话', () => {
    const { socket, client, transport, tooOld } = createHarness();
    socket.open();
    socket.deliver(
      helloFrame({
        ...HELLO_BASE,
        capabilities: CANONICAL,
        maxFrameBytes: 1024 * 1024,
        serverVersion: '1.1.22',
      })
    );

    expect(client.stateFeedMode).toBe('unsupported');
    expect(tooOld).toEqual([
      {
        side: 'gateway',
        minVersion: wsBorsh.CANONICAL_V11_MIN_PEER_VERSION,
        version: '1.1.22',
        nodeId: null,
      },
    ]);
    transport.disconnect();
  });

  test('同一网关重连后不再重复弹「版本过低」，升级到 canonical 后重新计数', () => {
    const sockets = [
      createFakeSocket({ binary: true }),
      createFakeSocket({ binary: true }),
      createFakeSocket({ binary: true }),
    ];
    let socketIndex = 0;
    const client = new BorshWebSocketClient({
      url: 'ws://example.test/ws',
      socketFactory: () => sockets[socketIndex++] as BinaryFakeSocket,
      heartbeatIntervalMs: 60_000,
    });
    const transport = new WebSocketGatewayTransport(client);
    const tooOld: Array<string | null> = [];
    transport.onEvent((event) => {
      if (event.type === 'server-too-old') tooOld.push(event.version);
    });
    transport.connect();
    sockets[0]?.open();
    sockets[0]?.deliver(
      helloFrame({ ...HELLO_BASE, maxFrameBytes: 1024 * 1024, serverVersion: '1.1.22' })
    );
    client.reconnect();
    sockets[1]?.open();
    sockets[1]?.deliver(
      helloFrame({ ...HELLO_BASE, maxFrameBytes: 1024 * 1024, serverVersion: '1.1.22' })
    );
    expect(tooOld).toEqual(['1.1.22']);

    // 对端升级到位后重新协商成 canonical：去重记忆清空，之后再退化仍会提示
    client.reconnect();
    sockets[2]?.open();
    sockets[2]?.deliver(helloFrame({ ...HELLO_BASE, capabilities: CANONICAL }));
    expect(tooOld).toEqual(['1.1.22']);
    transport.disconnect();
  });

  test('ERROR 帧里的节点编号与版本原样上报，不被入口网关自身的版本覆盖', () => {
    const { socket, transport } = createHarness();
    const tooOld: Array<{ side: string; version: string | null; nodeId?: string | null }> = [];
    transport.onEvent((event) => {
      if (event.type === 'server-too-old') {
        tooOld.push({ side: event.side, version: event.version, nodeId: event.nodeId });
      }
    });
    socket.open();
    socket.deliver(helloFrame({ ...HELLO_BASE, capabilities: CANONICAL }));
    socket.deliver(
      wsBorsh.encodeEnvelope(
        wsBorsh.KIND_ERROR,
        wsBorsh.encodePayload(wsBorsh.schema.ErrorSchema, {
          refSeq: null,
          code: wsBorsh.ERROR_UNSUPPORTED_PROTOCOL,
          message: wsBorsh.formatCanonicalV11RequiredError({
            side: 'node',
            nodeId: 'a1b2c3d4e5f6',
            version: '1.1.22',
          }),
          retryable: false,
        }),
        2
      )
    );

    expect(tooOld).toEqual([{ side: 'node', version: '1.1.22', nodeId: 'a1b2c3d4e5f6' }]);
    transport.disconnect();
  });

  test('A、B 两个旧节点交替报错各弹一次，不会来回重复', () => {
    const { socket, transport } = createHarness();
    const tooOld: Array<{ nodeId?: string | null; version: string | null }> = [];
    transport.onEvent((event) => {
      if (event.type === 'server-too-old') {
        tooOld.push({ nodeId: event.nodeId, version: event.version });
      }
    });
    socket.open();
    socket.deliver(helloFrame({ ...HELLO_BASE, capabilities: CANONICAL }));
    const report = (nodeId: string, version: string) => socket.deliver(nodeTooOld(nodeId, version));

    report('aaaaaaaaaaaa', '1.1.22');
    report('bbbbbbbbbbbb', '1.1.21');
    report('aaaaaaaaaaaa', '1.1.22');
    report('bbbbbbbbbbbb', '1.1.21');

    expect(tooOld).toEqual([
      { nodeId: 'aaaaaaaaaaaa', version: '1.1.22' },
      { nodeId: 'bbbbbbbbbbbb', version: '1.1.21' },
    ]);
    transport.disconnect();
  });

  test('入口重新协商成 canonical 只清 gateway 那一条，节点记忆保留', () => {
    const sockets = [createFakeSocket({ binary: true }), createFakeSocket({ binary: true })];
    let socketIndex = 0;
    const client = new BorshWebSocketClient({
      url: 'ws://example.test/ws',
      socketFactory: () => sockets[socketIndex++] as BinaryFakeSocket,
      heartbeatIntervalMs: 60_000,
    });
    const transport = new WebSocketGatewayTransport(client);
    const tooOld: Array<{ side: string; nodeId?: string | null }> = [];
    transport.onEvent((event) => {
      if (event.type === 'server-too-old') tooOld.push({ side: event.side, nodeId: event.nodeId });
    });
    transport.connect();
    sockets[0]?.open();
    sockets[0]?.deliver(helloFrame({ ...HELLO_BASE, capabilities: CANONICAL }));
    sockets[0]?.deliver(nodeTooOld('aaaaaaaaaaaa', '1.1.22'));
    expect(tooOld).toHaveLength(1);

    // 入口网络抖了一下又回到 canonical：节点没变过，不该再弹一次。
    client.reconnect();
    sockets[1]?.open();
    sockets[1]?.deliver(helloFrame({ ...HELLO_BASE, capabilities: CANONICAL }));
    sockets[1]?.deliver(nodeTooOld('aaaaaaaaaaaa', '1.1.22'));
    expect(tooOld).toHaveLength(1);

    // 同一节点报了另一个版本：旧记忆作废，重新提示。
    sockets[1]?.deliver(nodeTooOld('aaaaaaaaaaaa', '1.1.20'));
    expect(tooOld).toHaveLength(2);
    transport.disconnect();
  });

  test('重连升级到 canonical 时沿用最近一次订阅意图', () => {
    const sockets = [createFakeSocket({ binary: true }), createFakeSocket({ binary: true })];
    let socketIndex = 0;
    const client = new BorshWebSocketClient({
      url: 'ws://example.test/ws',
      socketFactory: () => sockets[socketIndex++] as BinaryFakeSocket,
      heartbeatIntervalMs: 60_000,
    });
    const transport = new WebSocketGatewayTransport(client);
    transport.connect();
    sockets[0]?.open();
    sockets[0]?.deliver(helloFrame(HELLO_BASE));
    transport.send({
      type: 'set-pane-subscriptions',
      deviceId: 'device-a',
      generation: 1n,
      paneIds: ['%stale'],
    });
    transport.send({
      type: 'set-pane-subscriptions',
      deviceId: 'device-a',
      generation: 2n,
      paneIds: [],
    });

    client.reconnect();
    sockets[1]?.open();
    sockets[1]?.deliver(helloFrame({ ...HELLO_BASE, capabilities: CANONICAL }));

    const canonicalFrame = sockets[1]?.sent
      .map((frame) => wsBorsh.decodeEnvelope(frame))
      .find((frame) => frame.kind === wsBorsh.KIND_CANONICAL_COMMAND);
    if (!canonicalFrame) throw new Error('missing canonical activation');
    expect(wsBorsh.decodeCanonicalCommandPayload(canonicalFrame.payload).command).toEqual({
      SetPaneSubscriptions: { generation: 1n, activePanes: [], hotPanes: [] },
    });
    transport.disconnect();
  });

  test('does not apply a pre-ready subscription that overflowed the typed queue', () => {
    const socket = createFakeSocket({ binary: true });
    const client = new BorshWebSocketClient({
      url: 'ws://example.test/ws',
      socketFactory: () => socket,
      heartbeatIntervalMs: 60_000,
      maxPendingFrames: 1,
    });
    const transport = new WebSocketGatewayTransport(client);
    transport.connect();
    expect(transport.send({ type: 'connect-device', deviceId: 'device-a' })).toBe('queued');
    expect(
      transport.send({
        type: 'set-pane-subscriptions',
        deviceId: 'device-a',
        generation: 1n,
        paneIds: ['%overflow'],
      })
    ).toBe('overflow');
    socket.open();
    socket.deliver(helloFrame({ ...HELLO_BASE, capabilities: CANONICAL }));

    const canonicalFrame = socket.sent
      .map((frame) => wsBorsh.decodeEnvelope(frame))
      .find((frame) => frame.kind === wsBorsh.KIND_CANONICAL_COMMAND);
    if (!canonicalFrame) throw new Error('missing canonical activation');
    expect(wsBorsh.decodeCanonicalCommandPayload(canonicalFrame.payload).command).toEqual({
      SetPaneSubscriptions: { generation: 1n, activePanes: [], hotPanes: [] },
    });
    transport.disconnect();
  });

  test('canonical frames use the effective max directly and never generic CHUNK', () => {
    const { socket, client, transport } = createHarness();
    socket.open();
    socket.deliver(
      helloFrame({
        ...HELLO_BASE,
        capabilities: CANONICAL,
        maxFrameBytes: wsBorsh.CANONICAL_STATE_MAX_FRAME_BYTES,
      })
    );
    const small = wsBorsh.encodeCanonicalCommandPayload({
      SetPaneSubscriptions: { generation: 9n, activePanes: [], hotPanes: [] },
    });
    expect(client.send(wsBorsh.KIND_CANONICAL_COMMAND, small)).toBe('sent');
    const last = wsBorsh.decodeEnvelope(socket.sent.at(-1) as Uint8Array);
    expect(last.kind).toBe(wsBorsh.KIND_CANONICAL_COMMAND);
    expect(last.payload).toEqual(small);

    const oversized = new Uint8Array(wsBorsh.CANONICAL_STATE_MAX_PAYLOAD_BYTES + 1);
    expect(() => client.send(wsBorsh.KIND_CANONICAL_COMMAND, oversized)).toThrow(
      wsBorsh.WsBorshError
    );
    expect(businessKinds(socket)).not.toContain(wsBorsh.KIND_CHUNK);
    transport.disconnect();
  });

  test('尺寸命令不再走 legacy kind：没有 metadata 时排队等 canonical 目标', () => {
    const { socket, client, transport } = createHarness();
    socket.open();
    socket.deliver(helloFrame({ ...HELLO_BASE, capabilities: CANONICAL }));
    expect(client.stateFeedMode).toBe('canonical');

    // 还没收到该设备的 canonical metadata：两条尺寸命令都进 canonical 待发队列
    expect(
      transport.send({
        type: 'terminal-resize',
        deviceId: 'device-a',
        paneId: '%1',
        cols: 100,
        rows: 30,
      })
    ).toBe('queued');
    expect(
      transport.send({
        type: 'terminal-sync-size',
        deviceId: 'device-a',
        paneId: '%1',
        cols: 90,
        rows: 24,
      })
    ).toBe('queued');

    expect(businessKinds(socket)).toEqual([wsBorsh.KIND_CANONICAL_COMMAND]);
    transport.disconnect();
  });

  test('协商到的帧上限撑不起 canonical feed 时同样判定为 unsupported', () => {
    const { socket, client, transport, tooOld } = createHarness();
    socket.open();
    socket.deliver(
      helloFrame({
        ...HELLO_BASE,
        capabilities: CANONICAL,
        maxFrameBytes: wsBorsh.CANONICAL_STATE_MAX_FRAME_BYTES - 1,
      })
    );

    expect(client.stateFeedMode).toBe('unsupported');
    expect(transport.capabilities.atomicScreen).toBe(false);
    expect(tooOld).toHaveLength(1);
    expect(businessKinds(socket)).toEqual([]);
    transport.disconnect();
  });
});
