import { describe, expect, test } from 'bun:test';
import { LinkMux } from '@tmex/shared/link';
import { fanoutDataChannel } from './channel-fanout';
import { DataChannelLink } from './data-channel-link';
import { FRAGMENT_PAYLOAD_SIZE } from './fragmenter';
import { parseLivenessChunk } from './liveness';
import { FakeClock, pairDataChannels } from './test-fakes';

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
      for (let i = 0; i < 33; i++) {
        sends.push(left.send(new Uint8Array([i])).catch(() => undefined));
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
});
