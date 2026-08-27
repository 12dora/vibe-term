import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import { BorshWebSocketClient, type WebSocketLike, defaultWsUrl } from './client';
import { createGatewayConnection } from './connection';

/** 可手工驱动的假 transport，遵循 WHATWG 的 readyState 取值。 */
class FakeSocket implements WebSocketLike {
  readyState = 0;
  binaryType: 'blob' | 'arraybuffer' = 'blob';
  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer | string }) => void) | null = null;
  onclose: ((event?: unknown) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;

  readonly sent: Array<ArrayBufferLike | ArrayBufferView | string> = [];
  closeCount = 0;

  send(data: ArrayBufferLike | ArrayBufferView | string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCount += 1;
    this.readyState = 3;
  }

  /** 模拟连接建立：先转 OPEN，再回调，顺序与浏览器一致。 */
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** 模拟对端断开：先落 CLOSED，再派发 onclose。 */
  simulateClose(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  /** 把一帧二进制投递给 onmessage。 */
  deliver(frame: Uint8Array): void {
    this.onmessage?.({ data: toArrayBuffer(frame) });
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function helloS2CFrame(capabilities: string[] = []): Uint8Array {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.HelloS2CSchema, {
    serverImpl: 'tmex-gateway',
    serverVersion: '0.1.0',
    selectedVersion: 1,
    maxFrameBytes: 1048576,
    heartbeatIntervalMs: 5000,
    capabilities,
  });
  return wsBorsh.encodeEnvelope(wsBorsh.KIND_HELLO_S2C, payload, 1);
}

function pongFrame(): Uint8Array {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.PingPongSchema, {
    nonce: 7,
    timeMs: BigInt(Date.now()),
  });
  return wsBorsh.encodeEnvelope(wsBorsh.KIND_PONG, payload, 2);
}

/** 轮询等待条件成立；用真实定时器驱动重连/心跳这类时间相关路径。 */
async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met before timeout');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** 注入最小 document 替身，用于驱动 visibilitychange 分支。 */
function stubDocument(): {
  setVisibility: (value: string) => void;
  dispatch: () => void;
  listenerCount: () => number;
  restore: () => void;
} {
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: 'visible',
    addEventListener(type: string, handler: () => void) {
      if (type === 'visibilitychange') listeners.add(handler);
    },
    removeEventListener(type: string, handler: () => void) {
      if (type === 'visibilitychange') listeners.delete(handler);
    },
  };
  const had = 'document' in globalThis;
  const previous = Reflect.get(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true, writable: true });
  return {
    setVisibility: (value) => {
      doc.visibilityState = value;
    },
    dispatch: () => {
      for (const handler of [...listeners]) handler();
    },
    listenerCount: () => listeners.size,
    restore: () => {
      if (had) {
        Object.defineProperty(globalThis, 'document', {
          value: previous,
          configurable: true,
          writable: true,
        });
      } else {
        Reflect.deleteProperty(globalThis, 'document');
      }
    },
  };
}

/** 临时替换全局 WebSocket，返回还原函数。 */
function stubGlobalWebSocket(impl: unknown): () => void {
  const original = Reflect.get(globalThis, 'WebSocket');
  Reflect.set(globalThis, 'WebSocket', impl);
  return () => Reflect.set(globalThis, 'WebSocket', original);
}

describe('socketFactory', () => {
  test('注入的工厂被调用一次，并拿到解析后的 URL', () => {
    const urls: string[] = [];
    const socket = new FakeSocket();
    const client = new BorshWebSocketClient({
      url: 'ws://example.test/ws',
      socketFactory: (url) => {
        urls.push(url);
        return socket;
      },
    });

    client.connect();

    expect(urls).toEqual(['ws://example.test/ws']);
    expect(socket.binaryType).toBe('arraybuffer');
    expect(client.getState()).toBe('WS_CONNECTING');
    client.disconnect();
  });

  test('缺省 url 时工厂收到 defaultWsUrl() 的推导结果', () => {
    const urls: string[] = [];
    const client = new BorshWebSocketClient({
      socketFactory: (url) => {
        urls.push(url);
        return new FakeSocket();
      },
    });

    client.connect();

    expect(urls).toEqual([defaultWsUrl()]);
    client.disconnect();
  });

  test('注入 socket 的 open 事件驱动握手并发出 Hello', () => {
    const socket = new FakeSocket();
    const client = new BorshWebSocketClient({
      url: 'ws://example.test/ws',
      socketFactory: () => socket,
    });
    const states: string[] = [];
    client.onStateChange((s) => states.push(s));

    client.connect();
    socket.open();

    expect(socket.sent.length).toBe(1);
    expect(client.getState()).toBe('HELLO_NEGOTIATING');
    expect(states).toContain('HELLO_NEGOTIATING');
    client.disconnect();
  });

  test('socket 已 OPEN 时 connect() 幂等，不重复建连', () => {
    let created = 0;
    const socket = new FakeSocket();
    const client = new BorshWebSocketClient({
      url: 'ws://example.test/ws',
      socketFactory: () => {
        created += 1;
        return socket;
      },
    });

    client.connect();
    socket.open();
    client.connect();

    expect(created).toBe(1);
    client.disconnect();
  });

  test('disconnect() 关闭注入的 socket', () => {
    const socket = new FakeSocket();
    const client = new BorshWebSocketClient({
      url: 'ws://example.test/ws',
      socketFactory: () => socket,
    });

    client.connect();
    socket.open();
    client.disconnect();

    expect(socket.closeCount).toBe(1);
    expect(client.getState()).toBe('CLOSED');
  });

  test('缺省时使用全局 WebSocket 构造器，URL 原样传入', () => {
    const constructedWith: string[] = [];
    class SpySocket extends FakeSocket {
      constructor(url: string) {
        super();
        constructedWith.push(url);
      }
    }
    const restore = stubGlobalWebSocket(SpySocket);
    try {
      const client = new BorshWebSocketClient({ url: 'ws://default.test/ws' });
      client.connect();
      expect(constructedWith).toEqual(['ws://default.test/ws']);
      client.disconnect();
    } finally {
      restore();
    }
  });

  /**
   * readyState 的比较必须用本地常量。若仍读 `WebSocket.OPEN`，在没有全局 WebSocket 的宿主里
   * 注入自定义 transport 会直接 ReferenceError。
   */
  test('全局 WebSocket 不存在时，注入的 transport 仍然可用', () => {
    const restore = stubGlobalWebSocket(undefined);
    try {
      const socket = new FakeSocket();
      const client = new BorshWebSocketClient({
        url: 'ws://example.test/ws',
        socketFactory: () => socket,
      });

      client.connect();
      socket.open();

      expect(socket.sent.length).toBe(1);
      expect(client.getState()).toBe('HELLO_NEGOTIATING');

      client.disconnect();
      expect(socket.closeCount).toBe(1);
    } finally {
      restore();
    }
  });

  test('createGatewayConnection 把 socketFactory 透传给客户端', () => {
    const socket = new FakeSocket();
    const urls: string[] = [];
    const conn = createGatewayConnection({
      wsUrl: 'ws://tunnel.test/ws',
      socketFactory: (url) => {
        urls.push(url);
        return socket;
      },
    });

    conn.client.connect();

    expect(urls).toEqual(['ws://tunnel.test/ws']);
    conn.dispose();
    expect(socket.closeCount).toBe(1);
  });

  test('createGatewayConnection 顶层 maxFrameBytes 进入 HELLO 协商', () => {
    const socket = new FakeSocket();
    const conn = createGatewayConnection({
      wsUrl: 'ws://tunnel.test/ws',
      socketFactory: () => socket,
      maxFrameBytes: 192 * 1024,
    });

    conn.client.connect();
    socket.open();
    const sent = socket.sent[0];
    if (typeof sent === 'string' || sent === undefined) {
      throw new Error('expected binary hello');
    }
    const bytes = ArrayBuffer.isView(sent)
      ? new Uint8Array(sent.buffer, sent.byteOffset, sent.byteLength)
      : new Uint8Array(sent);
    const envelope = wsBorsh.decodeEnvelope(bytes);
    const hello = wsBorsh.decodePayload(wsBorsh.schema.HelloC2SSchema, envelope.payload);
    expect(hello.maxFrameBytes).toBe(192 * 1024);
    conn.dispose();
  });

  test('每个合法 chunk 都报告进展，供上层刷新无进展 deadline', () => {
    const socket = new FakeSocket();
    const client = new BorshWebSocketClient({
      url: 'ws://example.test/ws',
      socketFactory: () => socket,
    });
    const progress: number[] = [];
    const messages: Uint8Array[] = [];
    client.onChunkProgress((event) => progress.push(event.chunkIndex));
    client.onMessage((message) => messages.push(message.payload));
    client.connect();
    socket.open();

    const payload = new Uint8Array(256).fill(7);
    const split = wsBorsh.splitPayloadIntoChunks(payload, wsBorsh.KIND_TERM_HISTORY, 9, {
      maxFrameBytes: 96,
      chunkStreamId: 3,
    });
    for (const chunk of split.chunks) {
      const encoded = wsBorsh.encodeChunk(chunk, chunk.chunkIndex + 1);
      socket.onmessage?.({
        data: encoded.buffer.slice(
          encoded.byteOffset,
          encoded.byteOffset + encoded.byteLength
        ) as ArrayBuffer,
      });
    }

    expect(progress).toEqual(split.chunks.map((chunk) => chunk.chunkIndex));
    expect(messages).toEqual([payload]);
    client.disconnect();
  });
});

describe('陈旧 socket 的事件隔离', () => {
  test('旧 socket 迟到的 onclose 不清分片状态、不安排重连', () => {
    const sockets: FakeSocket[] = [];
    const client = new BorshWebSocketClient({
      url: 'ws://example.test/ws',
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      reconnectDelayMs: 1,
      maxReconnectAttempts: 5,
    });

    client.connect();
    const stale = sockets[0] as FakeSocket;
    stale.open();

    // 旧 socket 已 CLOSED，但 onclose 尚未派发；此时新建连接。
    stale.readyState = 3;
    client.connect();
    expect(sockets.length).toBe(2);
    const fresh = sockets[1] as FakeSocket;
    fresh.open();

    const messages: Uint8Array[] = [];
    const states: string[] = [];
    client.onMessage((message) => messages.push(message.payload));
    client.onStateChange((state) => states.push(state));

    const payload = new Uint8Array(256).fill(5);
    const split = wsBorsh.splitPayloadIntoChunks(payload, wsBorsh.KIND_TERM_HISTORY, 11, {
      maxFrameBytes: 96,
      chunkStreamId: 8,
    });
    expect(split.chunks.length).toBeGreaterThan(1);

    const [first, ...rest] = split.chunks;
    fresh.deliver(wsBorsh.encodeChunk(first as (typeof split.chunks)[number], 1));

    // 迟到的旧 onclose：不得停心跳、不得清分片、不得排重连。
    stale.onclose?.();

    expect(states).toEqual([]);
    expect(client.getState()).toBe('HELLO_NEGOTIATING');

    for (const [index, chunk] of rest.entries()) {
      fresh.deliver(wsBorsh.encodeChunk(chunk, index + 2));
    }

    expect(messages).toEqual([payload]);
    client.disconnect();
  });

  test('旧 socket 迟到的 onmessage / onerror 被忽略', () => {
    const sockets: FakeSocket[] = [];
    const errors: string[] = [];
    const client = new BorshWebSocketClient({
      url: 'ws://example.test/ws',
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    client.onError((error) => errors.push(error.message));

    client.connect();
    const stale = sockets[0] as FakeSocket;
    stale.open();
    stale.readyState = 3;
    client.connect();
    const fresh = sockets[1] as FakeSocket;
    fresh.open();

    stale.deliver(helloS2CFrame(['stale-cap']));
    stale.onerror?.();

    expect(client.getState()).toBe('HELLO_NEGOTIATING');
    expect(client.serverCapabilities).toEqual([]);
    expect(errors).toEqual([]);

    fresh.deliver(helloS2CFrame(['fresh-cap']));
    expect(client.getState()).toBe('READY');
    expect(client.serverCapabilities).toEqual(['fresh-cap']);
    client.disconnect();
  });
});

// 退避/上限/重置的细节在 reconnect-controller.test.ts，这里只验证 client 确实接上了控制器
describe('重连接线', () => {
  test('断开后进入退避并重新建连', async () => {
    const sockets: FakeSocket[] = [];
    const client = new BorshWebSocketClient({
      url: 'ws://example.test/ws',
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      reconnectDelayMs: 1,
      maxReconnectAttempts: 2,
    });

    client.connect();
    (sockets[0] as FakeSocket).simulateClose();
    expect(client.getState()).toBe('RECONNECT_BACKOFF');

    await until(() => sockets.length === 2);
    client.disconnect();
  });
});

// PING 节奏、PONG 超时与 RTT 计算的细节在 heartbeat-controller.test.ts
describe('心跳接线', () => {
  test('READY 后发出 PING，收到 PONG 上报 latency', () => {
    const socket = new FakeSocket();
    const latencies: number[] = [];
    const client = new BorshWebSocketClient({
      url: 'ws://example.test/ws',
      socketFactory: () => socket,
      heartbeatIntervalMs: 10_000,
      pongTimeoutMs: 10_000,
    });
    client.onLatency((ms) => latencies.push(ms));

    client.connect();
    socket.open();
    expect(socket.sent.length).toBe(1);

    socket.deliver(helloS2CFrame());
    expect(client.getState()).toBe('READY');
    expect(socket.sent.length).toBe(2);

    socket.deliver(pongFrame());
    expect(latencies.length).toBe(1);
    expect(client.latencyMs).toBeGreaterThanOrEqual(0);

    client.disconnect();
  });
});

describe('visibilitychange', () => {
  test('页面可见时，退避中的重连立即执行', () => {
    const doc = stubDocument();
    try {
      const sockets: FakeSocket[] = [];
      const client = new BorshWebSocketClient({
        url: 'ws://example.test/ws',
        socketFactory: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
        reconnectDelayMs: 60_000,
        maxReconnectAttempts: 5,
      });

      client.connect();
      (sockets[0] as FakeSocket).simulateClose();
      expect(client.getState()).toBe('RECONNECT_BACKOFF');

      doc.dispatch();
      expect(sockets.length).toBe(2);
      expect(client.getState()).toBe('WS_CONNECTING');

      client.disconnect();
      expect(doc.listenerCount()).toBe(0);
    } finally {
      doc.restore();
    }
  });

  test('页面不可见时不触发任何动作', () => {
    const doc = stubDocument();
    try {
      const sockets: FakeSocket[] = [];
      const client = new BorshWebSocketClient({
        url: 'ws://example.test/ws',
        socketFactory: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
        reconnectDelayMs: 60_000,
      });

      client.connect();
      (sockets[0] as FakeSocket).simulateClose();
      doc.setVisibility('hidden');
      doc.dispatch();

      expect(sockets.length).toBe(1);
      expect(client.getState()).toBe('RECONNECT_BACKOFF');
      client.disconnect();
    } finally {
      doc.restore();
    }
  });

  test('CLOSED 状态下按节流重连，5s 内不重复建连', () => {
    const doc = stubDocument();
    try {
      const sockets: FakeSocket[] = [];
      const client = new BorshWebSocketClient({
        url: 'ws://example.test/ws',
        socketFactory: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
        maxReconnectAttempts: 0,
      });

      client.connect();
      (sockets[0] as FakeSocket).simulateClose();
      expect(client.getState()).toBe('CLOSED');

      doc.dispatch();
      expect(sockets.length).toBe(2);

      (sockets[1] as FakeSocket).simulateClose();
      expect(client.getState()).toBe('CLOSED');
      doc.dispatch();
      expect(sockets.length).toBe(2);

      client.disconnect();
    } finally {
      doc.restore();
    }
  });

  test('READY 状态下补发一次 PING', () => {
    const doc = stubDocument();
    try {
      const socket = new FakeSocket();
      const client = new BorshWebSocketClient({
        url: 'ws://example.test/ws',
        socketFactory: () => socket,
        heartbeatIntervalMs: 10_000,
        pongTimeoutMs: 10_000,
      });

      client.connect();
      socket.open();
      socket.deliver(helloS2CFrame());
      expect(socket.sent.length).toBe(2);

      doc.dispatch();
      expect(socket.sent.length).toBe(3);

      client.disconnect();
    } finally {
      doc.restore();
    }
  });
});

describe('建连同步失败', () => {
  test('socketFactory 同步抛出时不卡在 WS_CONNECTING，并安排重连', async () => {
    let calls = 0;
    const errors: string[] = [];
    const client = new BorshWebSocketClient({
      url: 'ws://example.test/ws',
      socketFactory: () => {
        calls += 1;
        throw new Error('factory boom');
      },
      reconnectDelayMs: 1,
      maxReconnectAttempts: 1,
    });
    client.onError((error) => errors.push(error.message));

    client.connect();

    expect(calls).toBe(1);
    expect(client.getState()).toBe('RECONNECT_BACKOFF');
    expect(errors).toContain('factory boom');

    await until(() => calls === 2);
    expect(client.getState()).toBe('CLOSED');
    expect(errors).toContain('Max reconnection attempts reached');

    client.disconnect();
  });

  test('重连预算为 0 时同步失败直接落 CLOSED', () => {
    const errors: string[] = [];
    const client = new BorshWebSocketClient({
      url: 'ws://example.test/ws',
      socketFactory: () => {
        throw new Error('factory boom');
      },
      reconnectDelayMs: 1,
      maxReconnectAttempts: 0,
    });
    client.onError((error) => errors.push(error.message));

    client.connect();

    expect(client.getState()).toBe('CLOSED');
    expect(errors).toEqual(['factory boom', 'Max reconnection attempts reached']);

    client.disconnect();
  });

  test('同步失败后 connect() 可再次建连，不被残留 ws 挡住', () => {
    let fail = true;
    const sockets: FakeSocket[] = [];
    const client = new BorshWebSocketClient({
      url: 'ws://example.test/ws',
      socketFactory: () => {
        if (fail) throw new Error('factory boom');
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      reconnectDelayMs: 60_000,
      maxReconnectAttempts: 5,
    });

    client.connect();
    expect(client.getState()).toBe('RECONNECT_BACKOFF');

    fail = false;
    client.connect();
    expect(sockets.length).toBe(1);
    (sockets[0] as FakeSocket).open();
    expect(client.getState()).toBe('HELLO_NEGOTIATING');

    client.disconnect();
  });
});
