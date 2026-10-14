import { describe, expect, test } from 'bun:test';
import {
  LINK_TRANSPORT_DRAIN_BYTES,
  LinkStreamTransport,
  attachExecChannelToLinkStream,
} from './link-transport';
import { FakeLinkStream } from './test-link-stream';
import type { ExecChannelAuth, ExecChannelInbound, ExecTransport } from './transport-types';

const bytes = (...values: number[]) => new Uint8Array(values);
const until = async (predicate: () => boolean) => {
  for (let i = 0; i < 200 && !predicate(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(predicate()).toBe(true);
};

class RecordingInbound implements ExecChannelInbound {
  readonly received: number[] = [];
  closes = 0;

  onBytes(chunk: Uint8Array): void {
    this.received.push(...chunk);
  }

  onClose(): void {
    this.closes += 1;
  }
}

function boot(closeFlushMs?: number) {
  const stream = new FakeLinkStream();
  const transport = new LinkStreamTransport(stream, closeFlushMs);
  const inbound = new RecordingInbound();
  transport.bind(inbound);
  return { stream, transport, inbound };
}

describe('LinkStreamTransport outbound', () => {
  test('frames are written sequentially in send order', async () => {
    const { stream, transport } = boot();
    transport.send(bytes(1));
    transport.send(bytes(2));
    transport.send(bytes(3));
    await until(() => stream.written.length === 3);
    expect(stream.written.map((frame) => frame[0])).toEqual([1, 2, 3]);
    expect(transport.bufferedBytes).toBe(0);
  });

  test('bufferedBytes counts queued bytes and onDrain fires once below 256 KiB', async () => {
    const { stream, transport } = boot();
    let drains = 0;
    transport.onDrain(() => {
      drains += 1;
    });
    stream.blockWrites();
    const chunk = new Uint8Array(100 * 1024);
    transport.send(chunk);
    transport.send(chunk);
    transport.send(chunk);
    expect(transport.bufferedBytes).toBe(3 * chunk.byteLength);
    expect(transport.bufferedBytes).toBeGreaterThanOrEqual(LINK_TRANSPORT_DRAIN_BYTES);
    expect(drains).toBe(0);
    stream.releaseWrites();
    await until(() => transport.bufferedBytes === 0);
    expect(drains).toBe(1);
  });

  test('onDrain stays quiet when the queue never crossed the threshold', async () => {
    const { stream, transport } = boot();
    let drains = 0;
    transport.onDrain(() => {
      drains += 1;
    });
    transport.send(bytes(1));
    await until(() => stream.written.length === 1);
    expect(drains).toBe(0);
  });

  test('close(1000) flushes queued frames then ends the stream', async () => {
    const { stream, transport } = boot();
    stream.blockWrites();
    transport.send(bytes(1));
    transport.send(bytes(2));
    transport.close(1000, 'done');
    expect(stream.ended).toBe(false);
    stream.releaseWrites();
    await until(() => stream.ended);
    expect(stream.written).toHaveLength(2);
    expect(stream.resetReason).toBeUndefined();
  });

  test('close with a signalling code flushes then resets with exec:<code>', async () => {
    const { stream, transport } = boot();
    stream.blockWrites();
    transport.send(bytes(7));
    transport.close(4409, 'taken_over');
    stream.releaseWrites();
    await until(() => stream.dead);
    expect(stream.written).toHaveLength(1);
    expect(stream.resetReason).toBe('exec:4409');
  });

  test('close after an ERROR frame (4400/4403) flushes then ends instead of resetting', async () => {
    for (const code of [4400, 4403]) {
      const { stream, transport } = boot();
      stream.blockWrites();
      transport.send(bytes(7));
      transport.close(code, 'protocol_error');
      stream.releaseWrites();
      await until(() => stream.ended);
      expect(stream.written).toHaveLength(1);
      expect(stream.dead).toBe(false);
    }
  });

  test('an ended error close resets only if the peer never ends back', async () => {
    const stream = new FakeLinkStream();
    const transport = new LinkStreamTransport(stream, 2000, 20);
    transport.bind(new RecordingInbound());
    transport.close(4400, 'protocol_error');
    await until(() => stream.ended);
    expect(stream.dead).toBe(false);
    await until(() => stream.dead);
    expect(stream.resetReason).toBe('exec:4400');
  });

  test('peer END after an ended error close cancels the fallback reset', async () => {
    const stream = new FakeLinkStream();
    const transport = new LinkStreamTransport(stream, 2000, 40);
    transport.bind(new RecordingInbound());
    transport.close(4403, 'forbidden');
    await until(() => stream.ended);
    transport.notifyInboundClosed();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(stream.dead).toBe(false);
  });

  test('close on an idle transport resets immediately', () => {
    const { stream, transport } = boot();
    transport.close(4408, 'idle');
    expect(stream.resetReason).toBe('exec:4408');
  });

  test('a stuck write is abandoned after the flush timeout', async () => {
    const { stream, transport } = boot(20);
    stream.blockWrites();
    transport.send(bytes(1));
    transport.close(4409, 'taken_over');
    expect(stream.dead).toBe(false);
    await until(() => stream.dead);
    expect(stream.resetReason).toBe('exec:4409');
  });

  test('send after close is ignored', async () => {
    const { stream, transport } = boot();
    transport.close(1000, 'done');
    transport.send(bytes(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stream.written).toHaveLength(0);
  });

  test('a rejected write resets the stream and closes inbound once', async () => {
    const { stream, transport, inbound } = boot();
    stream.writeError = new Error('boom');
    transport.send(bytes(1));
    transport.send(bytes(2));
    await until(() => stream.dead);
    expect(stream.resetReason).toBe('exec:write-failed');
    expect(inbound.closes).toBe(1);
    expect(transport.bufferedBytes).toBe(0);
  });
});

describe('attachExecChannelToLinkStream', () => {
  function attach(stream: FakeLinkStream) {
    const inbound = new RecordingInbound();
    const seen: { transport?: ExecTransport; auth?: ExecChannelAuth } = {};
    attachExecChannelToLinkStream(stream, { uid: 'u1', tokenId: null }, (transport, auth) => {
      seen.transport = transport;
      seen.auth = auth;
      return inbound;
    });
    return { inbound, seen };
  }

  test('passes auth and feeds inbound bytes in order', async () => {
    const stream = new FakeLinkStream();
    const { inbound, seen } = attach(stream);
    expect(seen.auth).toEqual({ uid: 'u1', tokenId: null });
    stream.push(bytes(1, 2));
    stream.push(bytes(3));
    await until(() => inbound.received.length === 3);
    expect(inbound.received).toEqual([1, 2, 3]);
  });

  test('peer END closes inbound once and ends our side', async () => {
    const stream = new FakeLinkStream();
    const { inbound } = attach(stream);
    stream.push(bytes(1));
    stream.peerEnd();
    await until(() => inbound.closes === 1);
    await until(() => stream.ended);
    expect(inbound.closes).toBe(1);
  });

  test('peer RST closes inbound exactly once even though two paths report it', async () => {
    const stream = new FakeLinkStream();
    const { inbound } = attach(stream);
    stream.peerReset('client-closed');
    await until(() => inbound.closes >= 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(inbound.closes).toBe(1);
  });

  test('link loss closes inbound once', async () => {
    const stream = new FakeLinkStream();
    const { inbound } = attach(stream);
    stream.linkLost();
    await until(() => inbound.closes === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(inbound.closes).toBe(1);
  });

  test('session close(1000) ends the stream and inbound hears about it once', async () => {
    const stream = new FakeLinkStream();
    const { inbound, seen } = attach(stream);
    seen.transport?.close(1000, 'done');
    await until(() => stream.ended);
    stream.peerEnd();
    await until(() => inbound.closes === 1);
    expect(inbound.closes).toBe(1);
  });
});
