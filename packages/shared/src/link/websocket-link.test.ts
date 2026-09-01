import { describe, expect, it } from 'bun:test';
import type { ByteTransport, LinkStream } from './types';
import {
  type ServerSocketAdapter,
  WebSocketLink,
  createClientWebSocketTransport,
  createServerSocketTransport,
} from './websocket-link';

/** Compile-time: the real DOM/Bun `WebSocket` must be assignable to the client adapter. */
const _clientTransportAcceptsWebSocket: (ws: WebSocket) => ByteTransport =
  createClientWebSocketTransport;
void _clientTransportAcceptsWebSocket;

class FakeServerSocket implements ServerSocketAdapter {
  peer: FakeServerSocket | null = null;
  closed = false;
  sendImpl: ((bytes: Uint8Array) => number) | null = null;
  bufferedAmount?: () => number;
  private readonly messageCbs: Array<(bytes: Uint8Array) => void> = [];
  private readonly closeCbs: Array<(reason?: string) => void> = [];
  private readonly drainCbs: Array<() => void> = [];

  deliverIncoming(bytes: Uint8Array): void {
    const copy = bytes.slice();
    for (const cb of this.messageCbs) cb(copy);
  }

  send(bytes: Uint8Array): number {
    if (this.sendImpl) return this.sendImpl(bytes);
    if (this.closed || !this.peer) return 0;
    this.peer.deliverIncoming(bytes);
    return bytes.byteLength;
  }

  close(_code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    const peer = this.peer;
    this.peer = null;
    if (peer && !peer.closed) {
      peer.closed = true;
      peer.peer = null;
      for (const cb of peer.closeCbs) cb(reason);
    }
    for (const cb of this.closeCbs) cb(reason);
  }

  onMessage(cb: (bytes: Uint8Array) => void): void {
    this.messageCbs.push(cb);
  }

  onClose(cb: (reason?: string) => void): void {
    this.closeCbs.push(cb);
  }

  onDrain(cb: () => void): void {
    this.drainCbs.push(cb);
  }

  emitDrain(): void {
    for (const cb of this.drainCbs) cb();
  }
}

function serverSocketPair(): [FakeServerSocket, FakeServerSocket] {
  const a = new FakeServerSocket();
  const b = new FakeServerSocket();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

class FakeClientSocket {
  binaryType: 'arraybuffer' | 'nodebuffer' = 'arraybuffer';
  readyState = 1;
  bufferedAmount = 0;
  peer: FakeClientSocket | null = null;
  closed = false;
  private readonly listeners = new Map<string, Array<(ev: unknown) => void>>();

  send(data: Uint8Array): void {
    if (this.closed || !this.peer) return;
    this.bufferedAmount += data.byteLength;
    const copy = data.slice();
    this.peer.dispatch('message', { data: copy.buffer });
  }

  close(_code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    const peer = this.peer;
    this.peer = null;
    if (peer && !peer.closed) {
      peer.closed = true;
      peer.readyState = 3;
      peer.peer = null;
      peer.dispatch('close', { code: 1000, reason });
    }
    this.dispatch('close', { code: 1000, reason });
  }

  addEventListener(type: string, listener: (ev: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  dispatch(type: string, ev: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(ev);
  }
}

function clientSocketPair(): [FakeClientSocket, FakeClientSocket] {
  const a = new FakeClientSocket();
  const b = new FakeClientSocket();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

describe('WebSocketLink', () => {
  it('multiplexes streams over a fake server socket pair', async () => {
    const [wsA, wsB] = serverSocketPair();
    const a = new WebSocketLink(wsA, { role: 'initiator' });
    const b = new WebSocketLink(wsB, { role: 'acceptor' });
    const incomingP = new Promise<LinkStream>((resolve) => b.onStream(resolve));
    const out = await a.openStream(new TextEncoder().encode('ws-open'));
    const incoming = await incomingP;
    expect(incoming.openPayload).toEqual(new TextEncoder().encode('ws-open'));
    await out.write(new TextEncoder().encode('hello-ws'));
    await out.end();
    const reader = incoming.readable.getReader();
    const chunk = await reader.read();
    expect(chunk.value).toBeDefined();
    if (!chunk.value) throw new Error('expected DATA chunk');
    expect(new TextDecoder().decode(chunk.value.bytes)).toBe('hello-ws');
    expect((await reader.read()).done).toBe(true);
    await incoming.end();
    expect((await out.closed).reason).toBe('end');
    a.close('bye');
    expect((await b.closed).reason).toBeDefined();
  });

  it('queues sends until the client socket opens and flushes through the send path', async () => {
    const [wsA, wsB] = clientSocketPair();
    wsA.readyState = 0;
    const a = new WebSocketLink(wsA as unknown as WebSocket, { role: 'initiator' });
    const b = new WebSocketLink(wsB as unknown as WebSocket, { role: 'acceptor' });
    const incomingP = new Promise<LinkStream>((resolve) => b.onStream(resolve));
    const openP = a.openStream(new Uint8Array([1, 2, 3]));
    await new Promise((resolve) => setTimeout(resolve, 10));
    wsA.readyState = 1;
    wsA.dispatch('open', {});
    const out = await openP;
    const incoming = await incomingP;
    expect(incoming.openPayload).toEqual(new Uint8Array([1, 2, 3]));
    await out.end();
    await incoming.end();
    a.close();
  });

  it('pauses the server send queue on -1 and resumes on drain', async () => {
    const [wsA, wsB] = serverSocketPair();
    const results: number[] = [];
    wsA.sendImpl = (bytes) => {
      const peer = wsA.peer;
      if (peer && !wsA.closed) peer.deliverIncoming(bytes);
      const result = results.length === 1 ? -1 : bytes.byteLength;
      results.push(result);
      return result;
    };
    const a = new WebSocketLink(wsA, { role: 'initiator' });
    const b = new WebSocketLink(wsB, { role: 'acceptor' });
    const incomingP = new Promise<LinkStream>((resolve) => b.onStream(resolve));
    const out = await a.openStream(new Uint8Array([1]));
    const incoming = await incomingP;
    let secondDone = false;
    const first = out.write(new Uint8Array([1]));
    const second = out.write(new Uint8Array([2])).then(() => {
      secondDone = true;
    });
    await first;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondDone).toBe(false);
    wsA.emitDrain();
    await second;
    expect(secondDone).toBe(true);
    await out.end();
    await incoming.end();
    a.close();
  });

  it('pauses before the server socket would exceed the 1 MiB backpressure limit', async () => {
    const [wsA, wsB] = serverSocketPair();
    let buffered = 0;
    let dropped = 0;
    wsA.sendImpl = (bytes) => {
      if (buffered + bytes.byteLength > 1024 * 1024) {
        dropped += 1;
        return 0;
      }
      buffered += bytes.byteLength;
      wsA.peer?.deliverIncoming(bytes);
      const n = bytes.byteLength;
      queueMicrotask(() => {
        buffered = Math.max(0, buffered - n);
        if (buffered === 0) wsA.emitDrain();
      });
      return n;
    };
    const a = new WebSocketLink(wsA, { role: 'initiator' });
    const b = new WebSocketLink(wsB, { role: 'acceptor' });
    const incomingP = new Promise<LinkStream>((resolve) => b.onStream(resolve));
    const out = await a.openStream(new Uint8Array([1]));
    const incoming = await incomingP;
    const reader = incoming.readable.getReader();
    const consume = (async () => {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    })();
    const chunk = new Uint8Array(64 * 1024).fill(9);
    const pending: Promise<void>[] = [];
    for (let i = 0; i < 24; i += 1) {
      pending.push(out.write(chunk));
    }
    await Promise.all(pending);
    expect(dropped).toBe(0);
    await out.end();
    await consume;
    await incoming.end();
    a.close();
  });

  it('resumes a proactive server pause via bufferedAmount poll when drain never fires', async () => {
    const [wsA, wsB] = serverSocketPair();
    let buffered = 0;
    let drainEmitted = 0;
    wsA.bufferedAmount = () => buffered;
    wsA.sendImpl = (bytes) => {
      buffered += bytes.byteLength;
      wsA.peer?.deliverIncoming(bytes);
      return bytes.byteLength;
    };
    const origEmit = wsA.emitDrain.bind(wsA);
    wsA.emitDrain = () => {
      drainEmitted += 1;
      origEmit();
    };
    const a = new WebSocketLink(wsA, { role: 'initiator' });
    const b = new WebSocketLink(wsB, { role: 'acceptor' });
    const incomingP = new Promise<LinkStream>((resolve) => b.onStream(resolve));
    const out = await a.openStream(new Uint8Array([1]));
    const incoming = await incomingP;
    const reader = incoming.readable.getReader();
    const consume = (async () => {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    })();
    const chunk = new Uint8Array(64 * 1024).fill(9);
    const pending: Promise<void>[] = [];
    for (let i = 0; i < 24; i += 1) {
      pending.push(out.write(chunk));
    }
    let allDone = false;
    const allP = Promise.all(pending).then(() => {
      allDone = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(allDone).toBe(false);
    expect(buffered).toBeGreaterThan(512 * 1024);
    expect(drainEmitted).toBe(0);
    buffered = 0;
    const resumed = await Promise.race([
      allP.then(() => 'resumed' as const),
      new Promise<'stuck'>((resolve) => setTimeout(() => resolve('stuck'), 200)),
    ]);
    expect(resumed).toBe('resumed');
    expect(allDone).toBe(true);
    expect(drainEmitted).toBe(0);
    await out.end();
    await consume;
    await incoming.end();
    a.close();
  });

  it('closes the LinkSession when the server socket send returns 0', async () => {
    const [wsA, wsB] = serverSocketPair();
    let sends = 0;
    wsA.sendImpl = (bytes) => {
      sends += 1;
      if (sends === 1) {
        wsA.peer?.deliverIncoming(bytes);
        return bytes.byteLength;
      }
      return 0;
    };
    const a = new WebSocketLink(wsA, { role: 'initiator' });
    new WebSocketLink(wsB, { role: 'acceptor' });
    const out = await a.openStream(new Uint8Array([1]));
    const writeP = out.write(new Uint8Array([2]));
    const info = await a.closed;
    expect(info.reason.length).toBeGreaterThan(0);
    await expect(writeP).rejects.toBeInstanceOf(Error);
  });

  it('throttles client sends when bufferedAmount is above 4 MiB and resumes below 1 MiB', async () => {
    const [wsA, wsB] = clientSocketPair();
    const a = new WebSocketLink(wsA as unknown as WebSocket, { role: 'initiator' });
    const b = new WebSocketLink(wsB as unknown as WebSocket, { role: 'acceptor' });
    const incomingP = new Promise<LinkStream>((resolve) => b.onStream(resolve));
    const out = await a.openStream(new Uint8Array([1]));
    await incomingP;
    wsA.bufferedAmount = 4 * 1024 * 1024 + 8;
    let secondDone = false;
    const first = out.write(new Uint8Array([1]));
    const second = out.write(new Uint8Array([2])).then(() => {
      secondDone = true;
    });
    await first;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(secondDone).toBe(false);
    wsA.bufferedAmount = 512 * 1024;
    await second;
    expect(secondDone).toBe(true);
    a.close();
  });

  it('createClientWebSocketTransport type-checks against a structural fake', () => {
    const fake = new FakeClientSocket();
    const transport = createClientWebSocketTransport(fake as unknown as WebSocket);
    expect(typeof transport.send).toBe('function');
  });

  it('createServerSocketTransport type-checks against a structural fake', () => {
    const fake = new FakeServerSocket();
    const transport = createServerSocketTransport(fake);
    expect(typeof transport.send).toBe('function');
  });
});
