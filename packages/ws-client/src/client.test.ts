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
    let constructedWith: string | null = null;
    class SpySocket extends FakeSocket {
      constructor(url: string) {
        super();
        constructedWith = url;
      }
    }
    const restore = stubGlobalWebSocket(SpySocket);
    try {
      const client = new BorshWebSocketClient({ url: 'ws://default.test/ws' });
      client.connect();
      expect(constructedWith).toBe('ws://default.test/ws');
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
