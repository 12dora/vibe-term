import { describe, expect, it } from 'bun:test';
import { FrameDecoder, encodeFrame, encodeFrameHeader, encodeWindowPayload } from './codec';
import { createBytePipe, createInMemoryLinkPair } from './in-memory-link';
import { LinkMux } from './mux';
import { FrameOp } from './types';
import {
  type ByteTransport,
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

  it('enqueues END behind in-flight writes and returns a promise', async () => {
    const [a, b] = createInMemoryLinkPair();
    const incomingP = new Promise<LinkStream>((resolve) => b.onStream(resolve));
    const out = await a.openStream(new Uint8Array([1]));
    const incoming = await incomingP;
    const body = new Uint8Array([9, 8, 7]);
    const writeP = out.write(body);
    const endP = out.end();
    expect(endP).toBeInstanceOf(Promise);
    await endP;
    await writeP;
    await expect(out.write(new Uint8Array([1]))).rejects.toMatchObject({
      code: 'closed',
    });
    const reader = incoming.readable.getReader();
    const chunk = await reader.read();
    expect(chunk.value?.bytes).toEqual(body);
    expect((await reader.read()).done).toBe(true);
    incoming.end();
    a.close();
  });

  it('closes the link on WINDOW that is not 0 < delta <= outstanding', async () => {
    const [t1, t2] = createBytePipe();
    const mux = new LinkMux(t1, {
      role: 'initiator',
      streamWindow: 100,
      maxLinkUnacked: 400,
    });
    t2.send(
      encodeFrame({ streamId: 0, op: FrameOp.WINDOW, payload: encodeWindowPayload(0xffffffff) })
    );
    const info = await mux.closed;
    expect(info.reason.toLowerCase()).toContain('window');
  });

  it('accepts WINDOW only up to outstanding and decrements global unacked by the same delta', async () => {
    const [t1, t2] = createBytePipe();
    const a = new LinkMux(t1, {
      role: 'initiator',
      streamWindow: 100,
      maxLinkUnacked: 200,
    });
    const out = await a.openStream(new Uint8Array([1]));
    await out.write(new Uint8Array(100).fill(1));
    t2.send(
      encodeFrame({
        streamId: out.id,
        op: FrameOp.WINDOW,
        payload: encodeWindowPayload(40),
      })
    );
    await out.write(new Uint8Array(40).fill(2));
    let extraResolved = false;
    const extra = out.write(new Uint8Array([3])).then(() => {
      extraResolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(extraResolved).toBe(false);
    t2.send(
      encodeFrame({
        streamId: out.id,
        op: FrameOp.WINDOW,
        payload: encodeWindowPayload(200),
      })
    );
    const info = await a.closed;
    expect(info.reason.toLowerCase()).toContain('window');
    await expect(extra).rejects.toBeInstanceOf(Error);
  });

  it('releases remaining outstanding on RST so later streams can send', async () => {
    const [t1, t2] = createBytePipe();
    const initiator = new LinkMux(t1, {
      role: 'initiator',
      streamWindow: 10,
      maxLinkUnacked: 30,
    });
    const acceptor = new LinkMux(t2, {
      role: 'acceptor',
      streamWindow: 10,
      maxLinkUnacked: 30,
    });
    const remote: LinkStream[] = [];
    acceptor.onStream((stream) => remote.push(stream));
    for (let i = 0; i < 3; i++) {
      const out = await initiator.openStream(new Uint8Array([i]));
      await out.write(new Uint8Array(10).fill(i));
      const incoming = remote[i];
      expect(incoming).toBeDefined();
      incoming?.reset('stop');
      expect((await out.closed).reason).toBe('rst');
    }
    const extra = await initiator.openStream(new Uint8Array([9]));
    await extra.write(new Uint8Array(10).fill(9));
    extra.end();
    initiator.close();
  });

  it('releases remaining outstanding on local RST', async () => {
    const [t1, t2] = createBytePipe();
    const initiator = new LinkMux(t1, {
      role: 'initiator',
      streamWindow: 10,
      maxLinkUnacked: 10,
    });
    new LinkMux(t2, { role: 'acceptor', streamWindow: 10, maxLinkUnacked: 10 });
    const out = await initiator.openStream(new Uint8Array([1]));
    await out.write(new Uint8Array(10).fill(1));
    out.reset('local');
    expect((await out.closed).reason).toBe('rst');
    const extra = await initiator.openStream(new Uint8Array([2]));
    await extra.write(new Uint8Array(10).fill(2));
    extra.end();
    initiator.close();
  });

  it('ignores a late WINDOW after RST instead of double-counting credit', async () => {
    const [t1, t2] = createBytePipe();
    const a = new LinkMux(t1, {
      role: 'initiator',
      streamWindow: 100,
      maxLinkUnacked: 200,
    });
    const b = new LinkMux(t2, {
      role: 'acceptor',
      streamWindow: 100,
      maxLinkUnacked: 200,
    });
    const remote: LinkStream[] = [];
    b.onStream((stream) => remote.push(stream));
    const first = await a.openStream(new Uint8Array([1]));
    await first.write(new Uint8Array(100).fill(1));
    const second = await a.openStream(new Uint8Array([2]));
    await second.write(new Uint8Array(100).fill(2));
    remote[0]?.reset('gone');
    expect((await first.closed).reason).toBe('rst');
    t2.send(
      encodeFrame({
        streamId: first.id,
        op: FrameOp.WINDOW,
        payload: encodeWindowPayload(100),
      })
    );
    const third = await a.openStream(new Uint8Array([3]));
    await third.write(new Uint8Array(100).fill(3));
    const fourth = await a.openStream(new Uint8Array([4]));
    const extra = fourth.write(new Uint8Array([4]));
    const info = await a.closed;
    expect(info.reason).toContain('unacked');
    await expect(extra).rejects.toBeInstanceOf(Error);
    b.close();
  });

  it('rejects remote OPEN with the local role parity instead of overwriting the id', async () => {
    const [t1, t2] = createBytePipe();
    const mux = new LinkMux(t1, { role: 'initiator' });
    t2.send(encodeFrame({ streamId: 1, op: FrameOp.OPEN, payload: new Uint8Array([7]) }));
    const info = await mux.closed;
    expect(info.reason.toLowerCase()).toMatch(/parity|open/);
    await expect(mux.openStream(new Uint8Array([1]))).rejects.toBeInstanceOf(Error);
  });

  it('rejects remote OPEN that is not strictly increasing', async () => {
    const [t1, t2] = createBytePipe();
    const mux = new LinkMux(t1, { role: 'initiator' });
    const incoming: LinkStream[] = [];
    mux.onStream((stream) => incoming.push(stream));
    t2.send(encodeFrame({ streamId: 4, op: FrameOp.OPEN, payload: new Uint8Array([1]) }));
    t2.send(encodeFrame({ streamId: 2, op: FrameOp.OPEN, payload: new Uint8Array([2]) }));
    const info = await mux.closed;
    expect(info.reason.toLowerCase()).toMatch(/increas|open/);
    expect(incoming).toHaveLength(1);
    expect(incoming[0]?.id).toBe(4);
  });

  it('closes the mux when transport.send rejects without firing onClose', async () => {
    const transport: ByteTransport = {
      send() {
        return Promise.reject(new Error('send-failed'));
      },
      onData() {},
      onClose() {},
      close() {},
    };
    const mux = new LinkMux(transport, { role: 'initiator' });
    await expect(mux.sendFrame({ streamId: 1, op: FrameOp.RST })).rejects.toThrow('send-failed');
    const state = await Promise.race([
      mux.closed.then(() => 'closed' as const),
      new Promise<'still-open'>((resolve) => setTimeout(() => resolve('still-open'), 50)),
    ]);
    expect(state).toBe('closed');
  });

  it('closes the transport once on send rejection and drops post-close chunks', async () => {
    let closeCalls = 0;
    let onData: ((bytes: Uint8Array) => void) | undefined;
    const transport: ByteTransport = {
      send() {
        return Promise.reject(new Error('send-failed'));
      },
      onData(cb) {
        onData = cb;
      },
      onClose() {},
      close() {
        closeCalls += 1;
      },
    };
    const mux = new LinkMux(transport, { role: 'initiator' });
    await expect(mux.sendFrame({ streamId: 1, op: FrameOp.RST })).rejects.toThrow('send-failed');
    expect(closeCalls).toBe(1);
    expect(onData).toBeDefined();
    for (let i = 0; i < 100; i++) {
      onData?.(encodeFrame({ streamId: 2, op: FrameOp.OPEN, payload: new Uint8Array([i]) }));
    }
    expect((mux as unknown as { pendingChunks: Uint8Array[] }).pendingChunks).toHaveLength(0);
    mux.close('again');
    expect(closeCalls).toBe(1);
  });

  it('closes the link when pending incoming streams exceed the hard cap', async () => {
    const [t1, t2] = createBytePipe();
    const mux = new LinkMux(t1, { role: 'initiator' });
    for (let i = 0; i < 65; i++) {
      t2.send(
        encodeFrame({
          streamId: (i + 1) * 2,
          op: FrameOp.OPEN,
          payload: new Uint8Array([i]),
        })
      );
    }
    const info = await mux.closed;
    expect(info.reason.toLowerCase()).toMatch(/pending|cap|overflow|too many/);
  });

  it('defers CTL WINDOW until a promise-returning onMessage settles', async () => {
    const [t1, t2] = createBytePipe();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sender = new LinkMux(t1, { role: 'initiator', streamWindow: 8 });
    const receiver = new LinkMux(t2, { role: 'acceptor', streamWindow: 8 });
    const received: number[] = [];
    receiver.ctl.onMessage((bytes) => {
      received.push(bytes[0] ?? -1);
      return gate;
    });
    sender.ctl.send(new Uint8Array(8).fill(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toEqual([1]);
    sender.ctl.send(new Uint8Array(8).fill(2));
    await new Promise((r) => setTimeout(r, 20));
    expect(received).toEqual([1]);
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(received).toEqual([1, 2]);
    sender.close();
  });

  it('closes the link when the ctl inbox exceeds the hard cap', async () => {
    const [a, b] = createInMemoryLinkPair();
    for (let i = 0; i < 65; i++) {
      b.ctl.send(new Uint8Array([i]));
    }
    const info = await a.closed;
    expect(info.reason.toLowerCase()).toMatch(/ctl|cap|overflow|too many/);
  });
});
