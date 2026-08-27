import { describe, expect, it } from 'bun:test';
import type { LinkStream } from './types';
import { type WebSocketLike, WebSocketLink } from './websocket-link';

class FakeWebSocket implements WebSocketLike {
  binaryType = 'arraybuffer';
  readyState = 1;
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev?: { code?: number; reason?: string }) => void) | null = null;
  peer: FakeWebSocket | null = null;
  closed = false;

  send(data: Uint8Array): number | undefined {
    if (this.closed || !this.peer) return undefined;
    const copy = data.slice();
    this.peer.onmessage?.({ data: copy.buffer });
    return copy.byteLength;
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
      peer.onclose?.({ code: 1000, reason });
    }
    this.onclose?.({ code: 1000, reason });
  }
}

function fakeSocketPair(): [FakeWebSocket, FakeWebSocket] {
  const a = new FakeWebSocket();
  const b = new FakeWebSocket();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

describe('WebSocketLink', () => {
  it('multiplexes streams over a fake WebSocket pair', async () => {
    const [wsA, wsB] = fakeSocketPair();
    const a = new WebSocketLink(wsA, { role: 'initiator' });
    const b = new WebSocketLink(wsB, { role: 'acceptor' });
    const incomingP = new Promise<LinkStream>((resolve) => b.onStream(resolve));
    const out = await a.openStream(new TextEncoder().encode('ws-open'));
    const incoming = await incomingP;
    expect(incoming.openPayload).toEqual(new TextEncoder().encode('ws-open'));
    await out.write(new TextEncoder().encode('hello-ws'));
    out.end();
    const reader = incoming.readable.getReader();
    const chunk = await reader.read();
    expect(chunk.value).toBeDefined();
    if (!chunk.value) throw new Error('expected DATA chunk');
    expect(new TextDecoder().decode(chunk.value.bytes)).toBe('hello-ws');
    expect((await reader.read()).done).toBe(true);
    incoming.end();
    expect((await out.closed).reason).toBe('end');
    a.close('bye');
    expect((await b.closed).reason).toBeDefined();
  });

  it('queues sends until the socket opens', async () => {
    const [wsA, wsB] = fakeSocketPair();
    wsA.readyState = 0;
    const a = new WebSocketLink(wsA, { role: 'initiator' });
    const b = new WebSocketLink(wsB, { role: 'acceptor' });
    const incomingP = new Promise<LinkStream>((resolve) => b.onStream(resolve));
    const openP = a.openStream(new Uint8Array([1, 2, 3]));
    await new Promise((resolve) => setTimeout(resolve, 10));
    wsA.readyState = 1;
    wsA.onopen?.({});
    const out = await openP;
    const incoming = await incomingP;
    expect(incoming.openPayload).toEqual(new Uint8Array([1, 2, 3]));
    out.end();
    incoming.end();
    a.close();
  });
});
