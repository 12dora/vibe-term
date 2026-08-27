import { describe, expect, it } from 'bun:test';
import { FrameDecoder, encodeFrame, encodeFrameHeader } from './codec';
import { createBytePipe, createInMemoryLinkPair } from './in-memory-link';
import { LinkMux } from './mux';
import { FrameOp } from './types';
import {
  INITIAL_STREAM_WINDOW,
  type LinkStream,
  MAX_FRAME_PAYLOAD,
  MAX_LINK_UNACKED,
} from './types';

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function readAll(stream: LinkStream): Promise<Uint8Array> {
  const reader = stream.readable.getReader();
  const parts: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) parts.push(value.bytes);
  }
  return concatChunks(parts);
}

describe('link mux', () => {
  it('assigns odd stream ids to initiator and even ids to acceptor', async () => {
    const [initiator, acceptor] = createInMemoryLinkPair();
    const a1 = await initiator.openStream(new Uint8Array([1]));
    const a2 = await initiator.openStream(new Uint8Array([2]));
    const b1 = await acceptor.openStream(new Uint8Array([3]));
    const b2 = await acceptor.openStream(new Uint8Array([4]));
    expect(a1.id % 2).toBe(1);
    expect(a2.id).toBe(a1.id + 2);
    expect(b1.id % 2).toBe(0);
    expect(b2.id).toBe(b1.id + 2);
    expect(a1.id).not.toBe(b1.id);
    initiator.close();
  });

  it('blocks a writer at 1 MiB until WINDOW arrives after the peer consumes', async () => {
    const [a, b] = createInMemoryLinkPair();
    const incomingP = new Promise<LinkStream>((resolve) => b.onStream(resolve));
    const out = await a.openStream(new Uint8Array([9]));
    const incoming = await incomingP;
    const first = new Uint8Array(INITIAL_STREAM_WINDOW).fill(7);
    await out.write(first);

    let resolved = false;
    const pending = out.write(new Uint8Array([8])).then(() => {
      resolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resolved).toBe(false);

    const reader = incoming.readable.getReader();
    const chunk = await reader.read();
    expect(chunk.value?.bytes.byteLength).toBe(INITIAL_STREAM_WINDOW);
    await pending;
    expect(resolved).toBe(true);
    a.close();
  });

  it('closes the link on an oversize frame', async () => {
    const [t1, t2] = createBytePipe();
    const mux = new LinkMux(t1, { role: 'initiator' });
    t2.send(encodeFrameHeader(1, FrameOp.DATA, 0, MAX_FRAME_PAYLOAD + 1));
    const info = await mux.closed;
    expect(info.reason).toContain('exceeds');
  });

  it('closes the link when unacked outbound exceeds 32 MiB', async () => {
    const [a, b] = createInMemoryLinkPair();
    b.onStream(() => undefined);
    const chunk = new Uint8Array(INITIAL_STREAM_WINDOW).fill(3);
    for (let i = 0; i < 32; i++) {
      const stream = await a.openStream(new Uint8Array([i]));
      await stream.write(chunk);
    }
    const extra = await a.openStream(new Uint8Array([99]));
    const writeP = extra.write(new Uint8Array([1]));
    const info = await a.closed;
    expect(info.reason).toContain('unacked');
    await expect(writeP).rejects.toBeInstanceOf(Error);
    expect(MAX_LINK_UNACKED).toBe(32 * 1024 * 1024);
  });

  it('half-closes each direction independently and finishes on bilateral END', async () => {
    const [a, b] = createInMemoryLinkPair();
    const incomingP = new Promise<LinkStream>((resolve) => b.onStream(resolve));
    const out = await a.openStream(new TextEncoder().encode('open'));
    const incoming = await incomingP;
    expect(incoming.openPayload).toEqual(new TextEncoder().encode('open'));

    await out.write(new TextEncoder().encode('req'), { head: true });
    out.end();

    const reader = incoming.readable.getReader();
    const first = await reader.read();
    expect(first.value).toBeDefined();
    if (!first.value) throw new Error('expected DATA chunk');
    expect(first.value.head).toBe(true);
    expect(new TextDecoder().decode(first.value.bytes)).toBe('req');
    const done = await reader.read();
    expect(done.done).toBe(true);

    await incoming.write(new TextEncoder().encode('res'));
    incoming.end();
    expect(await readAll(out)).toEqual(new TextEncoder().encode('res'));
    expect((await out.closed).reason).toBe('end');
    expect((await incoming.closed).reason).toBe('end');
  });

  it('propagates RST to onAbort and rejects pending writes', async () => {
    const [a, b] = createInMemoryLinkPair();
    const incomingP = new Promise<LinkStream>((resolve) => b.onStream(resolve));
    const out = await a.openStream(new Uint8Array(0));
    const incoming = await incomingP;
    let aborted = false;
    out.onAbort(() => {
      aborted = true;
    });
    await out.write(new Uint8Array(INITIAL_STREAM_WINDOW).fill(1));
    const pending = out.write(new Uint8Array([2]));
    incoming.reset('gone');
    await expect(pending).rejects.toBeInstanceOf(Error);
    expect(aborted).toBe(true);
    const info = await out.closed;
    expect(info.reason).toBe('rst');
    expect(info.message).toBe('gone');
  });

  it('sends RST when DATA arrives on an unknown stream', () => {
    const [t1, t2] = createBytePipe();
    new LinkMux(t1, { role: 'initiator' });
    const captured: Uint8Array[] = [];
    t2.onData((bytes) => captured.push(bytes.slice()));
    t2.send(encodeFrame({ streamId: 99, op: FrameOp.DATA, payload: new Uint8Array([1, 2]) }));
    const frames = new FrameDecoder().push(concatChunks(captured));
    const rst = frames.find((frame) => frame.op === FrameOp.RST && frame.streamId === 99);
    expect(rst).toBeDefined();
  });

  it('never allows END or RST on the ctl stream', async () => {
    const [t1, t2] = createBytePipe();
    const mux = new LinkMux(t1, { role: 'initiator' });
    t2.send(encodeFrame({ streamId: 0, op: FrameOp.END }));
    const info = await mux.closed;
    expect(info.reason).toContain('ctl');
  });

  it('keeps ctl open for DATA in both directions', async () => {
    const [a, b] = createInMemoryLinkPair();
    const got = new Promise<Uint8Array>((resolve) => b.ctl.onMessage(resolve));
    a.ctl.send(new TextEncoder().encode('{"t":"ping"}'));
    expect(new TextDecoder().decode(await got)).toBe('{"t":"ping"}');
    const back = new Promise<Uint8Array>((resolve) => a.ctl.onMessage(resolve));
    b.ctl.send(new TextEncoder().encode('{"t":"pong"}'));
    expect(new TextDecoder().decode(await back)).toBe('{"t":"pong"}');
    a.close('done');
    expect((await a.closed).reason).toBe('done');
  });
});
