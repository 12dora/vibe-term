import { describe, expect, test } from 'bun:test';
import { WebSocketSendGuard } from '../../ws/websocket-send-guard';
import {
  DC_HIGH_WATER_BYTES,
  DC_PRIORITY_QUEUE_CAP,
  DataChannelCarrier,
} from './data-channel-carrier';
import { FRAGMENT_HEADER_SIZE, FRAGMENT_PAYLOAD_SIZE } from './fragmenter';
import { encodeLivenessChunk, parseLivenessChunk } from './liveness';
import { pairDataChannels } from './test-fakes';

describe('DataChannelCarrier', () => {
  test('fragments outbound frames and reassembles inbound frames', () => {
    const [a, b] = pairDataChannels();
    const left = new DataChannelCarrier(a);
    const right = new DataChannelCarrier(b);
    const got: Uint8Array[] = [];
    right.onMessage((bytes) => {
      got.push(bytes);
    });

    const small = new Uint8Array([9, 8, 7]);
    expect(left.send(small)).toBe('sent');
    expect(got).toEqual([small]);

    const large = new Uint8Array(FRAGMENT_PAYLOAD_SIZE + 20).fill(3);
    expect(left.send(large)).toBe('sent');
    expect(got[1]).toEqual(large);
    expect(a.sent[0]?.byteLength).toBe(FRAGMENT_HEADER_SIZE + 3);
    expect(a.sent[1]?.byteLength).toBe(FRAGMENT_HEADER_SIZE + FRAGMENT_PAYLOAD_SIZE);
  });

  test('returns backpressure above 4 MiB without starting a frame and fires onDrain at low threshold', () => {
    const [a, b] = pairDataChannels();
    const carrier = new DataChannelCarrier(a);
    expect(a.lowThreshold).toBe(1024 * 1024);
    let drained = 0;
    carrier.onDrain(() => {
      drained += 1;
    });
    a.buffered = DC_HIGH_WATER_BYTES + 1;
    expect(carrier.hasPendingWrites()).toBe(true);
    expect(carrier.send(new Uint8Array([1]))).toBe('backpressure');
    expect(a.sent).toHaveLength(0);
    a.buffered = 10;
    expect(carrier.hasPendingWrites()).toBe(false);
    a.emitLow();
    expect(drained).toBe(1);
    b.close();
  });

  test('send after close returns closed; terminate closes the channel', () => {
    const [a] = pairDataChannels();
    const carrier = new DataChannelCarrier(a);
    let closed = 0;
    carrier.onClose(() => {
      closed += 1;
    });
    carrier.terminate();
    expect(a.closed).toBe(true);
    expect(closed).toBe(1);
    expect(carrier.send(new Uint8Array([1]))).toBe('closed');
  });

  test('keeps remaining fragments and finishes the frame after buffered-amount-low', () => {
    const [a, b] = pairDataChannels();
    const left = new DataChannelCarrier(a);
    const right = new DataChannelCarrier(b);
    const got: Uint8Array[] = [];
    right.onMessage((bytes) => {
      got.push(bytes);
    });
    a.succeedsBeforeBlock = 1;
    const large = new Uint8Array(FRAGMENT_PAYLOAD_SIZE + 20).fill(3);
    expect(left.send(large)).toBe('sent');
    expect(a.sent).toHaveLength(1);
    expect(got).toEqual([]);
    expect(left.hasPendingWrites()).toBe(true);
    expect(left.send(new Uint8Array([1]))).toBe('backpressure');
    a.emitLow();
    expect(got).toEqual([large]);
    expect(left.hasPendingWrites()).toBe(false);
  });

  test('70 KiB frame returns sent with remainder flushed on drain', () => {
    const [a, b] = pairDataChannels();
    const left = new DataChannelCarrier(a);
    const right = new DataChannelCarrier(b);
    const got: Uint8Array[] = [];
    let drained = 0;
    right.onMessage((bytes) => {
      got.push(bytes);
    });
    left.onDrain(() => {
      drained += 1;
    });
    a.succeedsBeforeBlock = 1;
    const frame = new Uint8Array(70 * 1024).fill(7);
    expect(left.send(frame)).toBe('sent');
    expect(a.sent).toHaveLength(1);
    expect(got).toEqual([]);
    expect(drained).toBe(0);
    expect(left.hasPendingWrites()).toBe(true);
    a.emitLow();
    expect(got).toEqual([frame]);
    expect(drained).toBe(1);
    expect(left.hasPendingWrites()).toBe(false);
    expect(left.send(new Uint8Array([1]))).toBe('sent');
  });

  test('closes the carrier when the channel fails mid-frame', () => {
    const [a] = pairDataChannels();
    const carrier = new DataChannelCarrier(a);
    let closed = 0;
    carrier.onClose(() => {
      closed += 1;
    });
    a.succeedsBeforeBlock = 1;
    a.closeOnBlockedSend = true;
    const large = new Uint8Array(FRAGMENT_PAYLOAD_SIZE + 20).fill(9);
    expect(carrier.send(large)).toBe('closed');
    expect(closed).toBe(1);
    expect(carrier.send(new Uint8Array([1]))).toBe('closed');
  });

  test('rejects a channel whose maxMessageSize cannot fit the fragment header', () => {
    const [a] = pairDataChannels();
    a.maxSize = 7;
    expect(() => new DataChannelCarrier(a)).toThrow();
    expect(a.closed).toBe(true);
  });

  test('closes the channel when inbound reassembly violates the 1 MiB cap', () => {
    const [a, b] = pairDataChannels();
    const right = new DataChannelCarrier(b);
    let closed = 0;
    right.onClose(() => {
      closed += 1;
    });
    const bad = new Uint8Array(FRAGMENT_HEADER_SIZE + 1);
    bad[6] = 18;
    a.sendMessageBinary(Buffer.from(bad));
    expect(closed).toBe(1);
    expect(b.closed).toBe(true);
  });

  test('replies to liveness ping without delivering it as a session frame', () => {
    const [a, b] = pairDataChannels();
    const right = new DataChannelCarrier(b);
    const got: Uint8Array[] = [];
    right.onMessage((bytes) => {
      got.push(bytes);
    });
    a.sendMessageBinary(Buffer.from(encodeLivenessChunk('ping')));
    expect(got).toEqual([]);
    expect(b.sent.some((chunk) => parseLivenessChunk(chunk) === 'pong')).toBe(true);
  });

  test('sendPriority queues a PONG ahead of a pending remainder and delivers it on drain', () => {
    const [a, b] = pairDataChannels();
    const left = new DataChannelCarrier(a);
    const right = new DataChannelCarrier(b);
    const got: Uint8Array[] = [];
    right.onMessage((bytes) => {
      got.push(bytes);
    });
    a.succeedsBeforeBlock = 1;
    const large = new Uint8Array(FRAGMENT_PAYLOAD_SIZE + 20).fill(3);
    expect(left.send(large)).toBe('sent');
    expect(got).toEqual([]);
    expect(left.hasPendingWrites()).toBe(true);

    const pong = new Uint8Array([0x70, 0x6f, 0x6e, 0x67]);
    expect(left.sendPriority(pong)).toBe('sent');
    expect(got).toEqual([]);

    a.emitLow();
    expect(got).toHaveLength(2);
    expect(got[0]).toEqual(pong);
    expect(got[1]).toEqual(large);
    expect(left.hasPendingWrites()).toBe(false);
  });

  test('sendPriority above high-water mark still delivers the PONG after drain', () => {
    const [a, b] = pairDataChannels();
    const left = new DataChannelCarrier(a);
    const right = new DataChannelCarrier(b);
    const got: Uint8Array[] = [];
    right.onMessage((bytes) => {
      got.push(bytes);
    });
    a.buffered = DC_HIGH_WATER_BYTES + 1;
    const pong = new Uint8Array([9, 9, 9]);
    expect(left.send(pong)).toBe('backpressure');
    expect(left.sendPriority(pong)).toBe('sent');
    expect(got).toEqual([]);
    expect(a.sent).toHaveLength(0);

    a.buffered = 10;
    a.emitLow();
    expect(got).toEqual([pong]);
  });

  test('sendPriority rejects when the bounded priority queue is full', () => {
    const [a] = pairDataChannels();
    const carrier = new DataChannelCarrier(a);
    a.buffered = DC_HIGH_WATER_BYTES + 1;
    for (let i = 0; i < DC_PRIORITY_QUEUE_CAP; i += 1) {
      expect(carrier.sendPriority(new Uint8Array([i]))).toBe('sent');
    }
    expect(carrier.sendPriority(new Uint8Array([255]))).toBe('rejected');
    a.close();
  });

  test('sendPriorityFrames reports sent for a queued PONG that later arrives', () => {
    const [a, b] = pairDataChannels();
    const left = new DataChannelCarrier(a);
    const right = new DataChannelCarrier(b);
    const got: Uint8Array[] = [];
    right.onMessage((bytes) => {
      got.push(bytes);
    });
    a.succeedsBeforeBlock = 1;
    const large = new Uint8Array(FRAGMENT_PAYLOAD_SIZE + 20).fill(4);
    expect(left.send(large)).toBe('sent');

    const guard = new WebSocketSendGuard({ timeoutMs: 1000, onTerminate: () => {} });
    const pong = new Uint8Array([1, 2, 3, 4]);
    expect(guard.sendPriorityFrames(left, [pong])).toBe('sent');
    expect(got).toEqual([]);
    a.emitLow();
    expect(got[0]).toEqual(pong);
    expect(got[1]).toEqual(large);
  });

  test('closes the channel on pending-frame overflow instead of dropping', () => {
    const [a, b] = pairDataChannels();
    const left = new DataChannelCarrier(a);
    const right = new DataChannelCarrier(b, { peer: 'sess-1' });
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      const chunk = new Uint8Array(1024 * 1024).fill(1);
      for (let i = 0; i < 32; i++) {
        expect(left.send(chunk)).toBe('sent');
      }
      left.send(chunk);
      expect(b.closed).toBe(true);
      expect(
        lines.some(
          (line) =>
            line.includes('[mesh][rtc] buffer overflow') &&
            line.includes('peer=sess-1') &&
            line.includes('dropped=')
        )
      ).toBe(true);
    } finally {
      console.log = orig;
    }
  });
});
