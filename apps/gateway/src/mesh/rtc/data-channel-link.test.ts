import { describe, expect, test } from 'bun:test';
import { FrameOp, LinkMux, encodeFrame, encodeWindowPayload } from '@tmex/shared/link';
import { fanoutDataChannel } from './channel-fanout';
import { DC_HIGH_WATER_BYTES } from './data-channel-carrier';
import { DataChannelLink } from './data-channel-link';
import { FRAGMENT_HEADER_SIZE, FRAGMENT_PAYLOAD_SIZE } from './fragmenter';
import { parseLivenessChunk } from './liveness';
import { FakeClock, pairDataChannels } from './test-fakes';

function muxOpFromChunk(chunk: Uint8Array): number | undefined {
  if (chunk.byteLength < FRAGMENT_HEADER_SIZE + 5) return undefined;
  return chunk[FRAGMENT_HEADER_SIZE + 4];
}

function livenessOpts(clock: FakeClock, peer = 'peer-b') {
  return {
    peer,
    intervalMs: 30,
    timeoutMs: 100,
    now: clock.now,
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
  };
}

describe('DataChannelLink', () => {
  test('is a ByteTransport that round-trips fragmented payloads', async () => {
    const [a, b] = pairDataChannels('peer');
    const left = new DataChannelLink(a);
    const right = new DataChannelLink(b);
    const got = new Promise<Uint8Array>((resolve) => right.onData(resolve));
    const payload = new Uint8Array(FRAGMENT_PAYLOAD_SIZE + 4).fill(11);
    left.send(payload);
    expect(await got).toEqual(payload);
  });

  test('carries LinkMux streams', async () => {
    const [a, b] = pairDataChannels('peer');
    const left = new LinkMux(new DataChannelLink(a), { role: 'initiator' });
    const right = new LinkMux(new DataChannelLink(b), { role: 'acceptor' });
    const incoming = new Promise<import('@tmex/shared/link').LinkStream>((resolve) =>
      right.onStream(resolve)
    );
    const open = new TextEncoder().encode('{"type":"http"}');
    const out = await left.openStream(open);
    const inn = await incoming;
    expect(inn.openPayload).toEqual(open);
    const read = inn.readable.getReader();
    await out.write(new Uint8Array([1, 2, 3]));
    const chunk = await read.read();
    expect(chunk.value?.bytes).toEqual(new Uint8Array([1, 2, 3]));
    out.end();
    inn.end();
  });

  test('close notifies the peer transport', async () => {
    const [a, b] = pairDataChannels('peer');
    const left = new DataChannelLink(a);
    const right = new DataChannelLink(b);
    const closed = new Promise<string | undefined>((resolve) => right.onClose(resolve));
    left.close('bye');
    expect(await closed).toBe('channel-closed');
  });

  test('send Promise resolves only after every fragment is accepted', async () => {
    const [a, b] = pairDataChannels('peer');
    const left = new DataChannelLink(a);
    const right = new DataChannelLink(b);
    const got = new Promise<Uint8Array>((resolve) => right.onData(resolve));
    a.succeedsBeforeBlock = 1;
    const payload = new Uint8Array(FRAGMENT_PAYLOAD_SIZE + 4).fill(11);
    let resolved = false;
    const sent = left.send(payload).then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(a.sent).toHaveLength(1);
    a.emitLow();
    await sent;
    expect(resolved).toBe(true);
    expect(await got).toEqual(payload);
  });

  test('closing rejects queued send Promises', async () => {
    const [a] = pairDataChannels('peer');
    const left = new DataChannelLink(a);
    a.blockSend = true;
    const pending = left.send(new Uint8Array([1, 2, 3]));
    left.close('bye');
    await expect(pending).rejects.toBeInstanceOf(Error);
  });

  test('frames that arrive before onData are delivered in order', async () => {
    const [a, b] = pairDataChannels('peer');
    const fanB = fanoutDataChannel(b);
    const left = new DataChannelLink(a);
    const payload = new Uint8Array([4, 5, 6]);
    const sent = left.send(payload);
    const right = new DataChannelLink(fanB);
    const got = new Promise<Uint8Array>((resolve) => right.onData(resolve));
    await sent;
    expect(await got).toEqual(payload);
  });

  test('close before onClose still notifies the later listener', async () => {
    const [a, b] = pairDataChannels('peer');
    const fanB = fanoutDataChannel(b);
    const left = new DataChannelLink(a);
    left.close('bye');
    const right = new DataChannelLink(fanB);
    const closed = new Promise<string | undefined>((resolve) => right.onClose(resolve));
    expect(await closed).toBe('channel-closed');
    expect(fanB.isOpen()).toBe(false);
  });

  test('late handshake JSON does not close the link', async () => {
    const [a, b] = pairDataChannels('peer');
    const left = new DataChannelLink(a, { liveness: false });
    const right = new DataChannelLink(b, { liveness: false });
    let linkClosedReason: string | undefined;
    right.onClose((reason) => {
      linkClosedReason = reason;
    });
    a.sendMessage(
      JSON.stringify({
        t: 'hello',
        node_id: '00'.repeat(16),
        nonce: 'A'.repeat(43),
        dtls_fingerprint: { algorithm: 'sha-256', value: '00' },
      })
    );
    b.emitMessage('{"t":"done"}');
    expect({ linkClosedReason, channelOpen: b.isOpen() }).toEqual({
      linkClosedReason: undefined,
      channelOpen: true,
    });
    const got = new Promise<Uint8Array>((resolve) => right.onData(resolve));
    await left.send(new Uint8Array([4, 5]));
    expect(await got).toEqual(new Uint8Array([4, 5]));
    left.close();
    right.close();
  });

  test('protocol violation on inbound closes the channel', () => {
    const [a, b] = pairDataChannels('peer');
    const left = new DataChannelLink(a);
    const right = new DataChannelLink(b);
    let closed = 0;
    right.onClose(() => {
      closed += 1;
    });
    const maxTotal = 18;
    const bad = new Uint8Array(8 + 1);
    bad[6] = maxTotal & 0xff;
    bad[7] = (maxTotal >>> 8) & 0xff;
    a.sendMessageBinary(Buffer.from(bad));
    expect(closed).toBe(1);
    expect(b.closed).toBe(true);
  });

  test('idle ping/pong is not delivered as application data', () => {
    const clock = new FakeClock();
    const [a, b] = pairDataChannels('peer');
    const left = new DataChannelLink(a, livenessOpts(clock, 'right'));
    const right = new DataChannelLink(b, livenessOpts(clock, 'left'));
    const app: Uint8Array[] = [];
    right.onData((bytes) => {
      app.push(bytes);
    });
    clock.advance(30);
    expect(app).toEqual([]);
    expect(a.sent.some((chunk) => parseLivenessChunk(chunk) === 'ping')).toBe(true);
    expect(b.sent.some((chunk) => parseLivenessChunk(chunk) === 'pong')).toBe(true);
    left.close();
    right.close();
  });

  test('inbound application data resets the idle ping timer', async () => {
    const clock = new FakeClock();
    const [a, b] = pairDataChannels('peer');
    const left = new DataChannelLink(a, livenessOpts(clock));
    const right = new DataChannelLink(b, livenessOpts(clock));
    const got = new Promise<Uint8Array>((resolve) => left.onData(resolve));
    clock.advance(20);
    await right.send(new Uint8Array([9, 9]));
    expect(await got).toEqual(new Uint8Array([9, 9]));
    clock.advance(20);
    expect(a.sent.some((chunk) => parseLivenessChunk(chunk) === 'ping')).toBe(false);
    left.close();
    right.close();
  });

  test('silence closes the link after the liveness timeout', () => {
    const clock = new FakeClock();
    const [a, b] = pairDataChannels('peer');
    a.dropSend = true;
    const left = new DataChannelLink(a, livenessOpts(clock, 'silenced'));
    const right = new DataChannelLink(b, livenessOpts(clock, 'peer-a'));
    let reason: string | undefined;
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      right.onClose((why) => {
        reason = why;
      });
      clock.advance(100);
      expect(reason).toBe('liveness-timeout');
      expect(b.closed).toBe(true);
      expect(a.closed).toBe(true);
      expect(
        lines.some(
          (line) =>
            line.includes('[mesh][rtc] liveness timeout') &&
            line.includes('peer=peer-a') &&
            line.includes('idle_ms=')
        )
      ).toBe(true);
    } finally {
      console.log = orig;
      left.close();
      right.close();
    }
  });

  test('round-trips a 1 MiB mux DATA frame over 64 KiB fragments', async () => {
    const [a, b] = pairDataChannels('peer');
    a.maxSize = 64 * 1024;
    b.maxSize = 64 * 1024;
    const left = new DataChannelLink(a, { liveness: false });
    const right = new DataChannelLink(b, { liveness: false });
    const muxLeft = new LinkMux(left, { role: 'initiator' });
    const muxRight = new LinkMux(right, { role: 'acceptor' });
    const incoming = new Promise<import('@tmex/shared/link').LinkStream>((resolve) =>
      muxRight.onStream(resolve)
    );
    const out = await muxLeft.openStream(new Uint8Array([1]));
    const inn = await incoming;
    const reader = inn.readable.getReader();
    const payload = new Uint8Array(1024 * 1024).fill(5);
    await out.write(payload);
    expect((await reader.read()).value?.bytes).toEqual(payload);
    out.end();
    inn.end();
  });

  test('buffers more than 32 small frames while onData is detached', async () => {
    const [a, b] = pairDataChannels('peer');
    const left = new DataChannelLink(a, { liveness: false });
    const right = new DataChannelLink(b, { liveness: false, peer: 'peer-b' });
    const sends: Array<Promise<void>> = [];
    for (let i = 0; i < 40; i++) {
      sends.push(left.send(new Uint8Array([i])));
    }
    await Promise.all(sends);
    expect(b.closed).toBe(false);
    const got: number[] = [];
    right.onData((bytes) => {
      got.push(bytes[0] ?? -1);
    });
    expect(got).toHaveLength(40);
    left.close();
    right.close();
  });

  test('closes the channel on pending-frame overflow instead of dropping', async () => {
    const [a, b] = pairDataChannels('peer');
    const left = new DataChannelLink(a);
    const right = new DataChannelLink(b, { peer: 'peer-b' });
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      const sends: Array<Promise<void>> = [];
      const chunk = new Uint8Array(1024 * 1024).fill(1);
      for (let i = 0; i < 33; i++) {
        sends.push(left.send(chunk).catch(() => undefined));
      }
      await Promise.all(sends);
      expect(b.closed).toBe(true);
      expect(
        lines.some(
          (line) =>
            line.includes('[mesh][rtc] buffer overflow') &&
            line.includes('peer=peer-b') &&
            line.includes('dropped=')
        )
      ).toBe(true);
    } finally {
      console.log = orig;
      left.close();
    }
  });

  test('WINDOW and liveness bypass a saturated data send path', async () => {
    const clock = new FakeClock();
    const [a, b] = pairDataChannels('peer');
    const left = new DataChannelLink(a, livenessOpts(clock, 'right'));
    const right = new DataChannelLink(b, livenessOpts(clock, 'left'));
    a.buffered = DC_HIGH_WATER_BYTES + 1;

    let dataResolved = false;
    const dataSent = left.send(new Uint8Array(FRAGMENT_PAYLOAD_SIZE + 4).fill(1)).then(() => {
      dataResolved = true;
    });
    await Promise.resolve();
    expect(dataResolved).toBe(false);
    expect(a.sent).toHaveLength(0);

    const windowFrame = encodeFrame({
      streamId: 1,
      op: FrameOp.WINDOW,
      payload: encodeWindowPayload(4096),
    });
    await left.send(windowFrame);
    expect(a.sent.some((chunk) => muxOpFromChunk(chunk) === FrameOp.WINDOW)).toBe(true);

    clock.advance(30);
    expect(a.sent.some((chunk) => parseLivenessChunk(chunk) === 'ping')).toBe(true);
    expect(dataResolved).toBe(false);

    a.buffered = 0;
    a.emitLow();
    await dataSent;
    expect(dataResolved).toBe(true);
    left.close();
    right.close();
  });

  test('a WINDOW frame is sent between fragments of a blocked DATA frame', async () => {
    const [a, b] = pairDataChannels('peer');
    const left = new DataChannelLink(a, { liveness: false });
    const right = new DataChannelLink(b, { liveness: false });
    a.succeedsBeforeBlock = 1;

    const dataSent = left.send(new Uint8Array(FRAGMENT_PAYLOAD_SIZE + 4).fill(9));
    await Promise.resolve();
    expect(a.sent).toHaveLength(1);
    expect(muxOpFromChunk(a.sent[0] as Uint8Array)).not.toBe(FrameOp.WINDOW);

    const windowFrame = encodeFrame({
      streamId: 1,
      op: FrameOp.WINDOW,
      payload: encodeWindowPayload(64),
    });
    const windowSent = left.send(windowFrame);
    await Promise.resolve();
    expect(a.sent).toHaveLength(1);

    a.emitLow();
    await windowSent;
    expect(muxOpFromChunk(a.sent[1] as Uint8Array)).toBe(FrameOp.WINDOW);
    await dataSent;
    expect(a.sent).toHaveLength(3);
    expect(muxOpFromChunk(a.sent[1] as Uint8Array)).toBe(FrameOp.WINDOW);
    left.close();
    right.close();
  });

  test('flush retries when send fails below the low-water threshold', async () => {
    const clock = new FakeClock();
    const [a, b] = pairDataChannels('peer');
    const left = new DataChannelLink(a, {
      liveness: false,
      now: clock.now,
      setTimeoutFn: clock.setTimeout,
      clearTimeoutFn: clock.clearTimeout,
    });
    const right = new DataChannelLink(b, { liveness: false });
    const got = new Promise<Uint8Array>((resolve) => right.onData(resolve));
    a.succeedsBeforeBlock = 0;
    a.buffered = 100;
    const payload = new Uint8Array([1, 2, 3]);
    const sent = left.send(payload);
    await Promise.resolve();
    expect(a.sent).toHaveLength(0);

    a.blockSend = false;
    a.succeedsBeforeBlock = Number.POSITIVE_INFINITY;
    clock.advance(20);
    await sent;
    expect(await got).toEqual(payload);
    left.close();
    right.close();
  });

  test('WINDOW still reopens the send window when native send from onMessage is a no-op', async () => {
    const [a, b] = pairDataChannels('peer');
    a.dropSendsFromReceiveCallback = true;
    b.dropSendsFromReceiveCallback = true;
    const left = new DataChannelLink(a, { liveness: false });
    const right = new DataChannelLink(b, { liveness: false });
    const muxA = new LinkMux(left, { role: 'initiator', streamWindow: 1024 });
    const muxB = new LinkMux(right, { role: 'acceptor', streamWindow: 1024 });
    const incoming = new Promise<import('@tmex/shared/link').LinkStream>((resolve) =>
      muxB.onStream(resolve)
    );
    const out = await muxA.openStream(new Uint8Array([1]));
    const inn = await incoming;
    const reader = inn.readable.getReader();
    const firstRead = reader.read();
    await out.write(new Uint8Array(1024).fill(1));
    expect((await firstRead).value?.bytes.byteLength).toBe(1024);

    const extraRead = reader.read();
    const extra = out.write(new Uint8Array([2]));
    const outcome = await Promise.race([
      extra.then(() => 'wrote' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 400)),
    ]);
    expect(outcome).toBe('wrote');
    expect((await extraRead).value?.bytes).toEqual(new Uint8Array([2]));
    out.end();
    inn.end();
    left.close();
    right.close();
  });
});
