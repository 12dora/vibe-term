import { describe, expect, test } from 'bun:test';
import { GATEWAY_CAPABILITY_CANONICAL_STATE_V1, wsBorsh } from '@tmex/shared';
import { BorshWebSocketClient, type WebSocketLike } from './client';
import { WebSocketGatewayTransport } from './websocket-transport';

class FakeSocket implements WebSocketLike {
  readyState = 0;
  binaryType: 'blob' | 'arraybuffer' = 'blob';
  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer | string }) => void) | null = null;
  onclose: ((event?: unknown) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  readonly sent: Uint8Array[] = [];

  send(data: ArrayBufferLike | ArrayBufferView | string): void {
    if (typeof data === 'string') throw new Error('unexpected text frame');
    this.sent.push(
      ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()
        : new Uint8Array(data).slice()
    );
  }

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  deliver(frame: Uint8Array): void {
    this.onmessage?.({ data: frame.slice().buffer });
  }
}

function hello(capabilities: string[], maxFrameBytes = 1024 * 1024): Uint8Array {
  return wsBorsh.encodeEnvelope(
    wsBorsh.KIND_HELLO_S2C,
    wsBorsh.encodePayload(wsBorsh.schema.HelloS2CSchema, {
      serverImpl: 'tmex-gateway',
      serverVersion: '1.2.0',
      selectedVersion: 1,
      maxFrameBytes,
      heartbeatIntervalMs: 60_000,
      capabilities,
    }),
    1
  );
}

function createHarness(canonicalStateEnabled = true) {
  const socket = new FakeSocket();
  const client = new BorshWebSocketClient({
    url: 'ws://example.test/ws',
    socketFactory: () => socket,
    heartbeatIntervalMs: 60_000,
    canonicalStateEnabled,
  });
  const transport = new WebSocketGatewayTransport(client);
  const events: string[] = [];
  transport.onEvent((event) => {
    if (event.type === 'state-feed-mode') events.push(event.mode);
  });
  transport.connect();
  return { socket, client, transport, events };
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

function businessKinds(socket: FakeSocket): number[] {
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
    socket.deliver(hello([GATEWAY_CAPABILITY_CANONICAL_STATE_V1]));

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
    expect(businessKinds(socket)).not.toContain(wsBorsh.KIND_TMUX_SUBSCRIBE_PANES);
    transport.disconnect();
  });

  test('keeps the legacy subscription path when the capability is absent', () => {
    const { socket, client, transport, events } = createHarness();
    transport.send({
      type: 'set-pane-subscriptions',
      deviceId: 'device-a',
      generation: 1n,
      paneIds: ['%1'],
    });
    socket.open();
    socket.deliver(hello([]));

    expect(client.stateFeedMode).toBe('legacy');
    expect(transport.capabilities.atomicScreen).toBe(false);
    expect(events).toEqual(['legacy']);
    expect(businessKinds(socket)).toEqual([wsBorsh.KIND_TMUX_SUBSCRIBE_PANES]);
    transport.disconnect();
  });

  test('the client option forces legacy even when the server advertises canonical state', () => {
    const { socket, client, transport } = createHarness(false);
    transport.send({
      type: 'set-pane-subscriptions',
      deviceId: 'device-a',
      generation: 1n,
      paneIds: ['%1'],
    });
    socket.open();
    socket.deliver(hello([GATEWAY_CAPABILITY_CANONICAL_STATE_V1]));

    expect(client.stateFeedMode).toBe('legacy');
    expect(businessKinds(socket)).toEqual([wsBorsh.KIND_TMUX_SUBSCRIBE_PANES]);
    transport.disconnect();
  });

  test('keeps the latest legacy subscription intent when a reconnect upgrades to canonical', () => {
    const sockets = [new FakeSocket(), new FakeSocket()];
    let socketIndex = 0;
    const client = new BorshWebSocketClient({
      url: 'ws://example.test/ws',
      socketFactory: () => sockets[socketIndex++] as FakeSocket,
      heartbeatIntervalMs: 60_000,
    });
    const transport = new WebSocketGatewayTransport(client);
    transport.connect();
    sockets[0]?.open();
    sockets[0]?.deliver(hello([]));
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
    sockets[1]?.deliver(hello([GATEWAY_CAPABILITY_CANONICAL_STATE_V1]));

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
    const socket = new FakeSocket();
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
    socket.deliver(hello([GATEWAY_CAPABILITY_CANONICAL_STATE_V1]));

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
      hello([GATEWAY_CAPABILITY_CANONICAL_STATE_V1], wsBorsh.CANONICAL_STATE_MAX_FRAME_BYTES)
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

  test('canonical mode still emits TERM_RESIZE / TERM_SYNC_SIZE so sync stays distinct from resize', () => {
    const { socket, client, transport } = createHarness();
    socket.open();
    socket.deliver(hello([GATEWAY_CAPABILITY_CANONICAL_STATE_V1]));
    expect(client.stateFeedMode).toBe('canonical');

    expect(
      transport.send({
        type: 'terminal-resize',
        deviceId: 'device-a',
        paneId: '%1',
        cols: 100,
        rows: 30,
      })
    ).toBe('sent');
    expect(
      transport.send({
        type: 'terminal-sync-size',
        deviceId: 'device-a',
        paneId: '%1',
        cols: 90,
        rows: 24,
      })
    ).toBe('sent');

    expect(businessKinds(socket)).toEqual([
      wsBorsh.KIND_CANONICAL_COMMAND,
      wsBorsh.KIND_TERM_RESIZE,
      wsBorsh.KIND_TERM_SYNC_SIZE,
    ]);
    transport.disconnect();
  });

  test('falls back to legacy when the negotiated frame limit cannot sustain a canonical feed', () => {
    const { socket, client, transport } = createHarness();
    socket.open();
    socket.deliver(
      hello([GATEWAY_CAPABILITY_CANONICAL_STATE_V1], wsBorsh.CANONICAL_STATE_MAX_FRAME_BYTES - 1)
    );

    expect(client.stateFeedMode).toBe('legacy');
    expect(transport.capabilities.atomicScreen).toBe(false);
    expect(businessKinds(socket)).toEqual([]);
    transport.disconnect();
  });
});
