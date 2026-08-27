import { describe, expect, test } from 'bun:test';
import { DC_HIGH_WATER_BYTES, DataChannelCarrier } from './data-channel-carrier';
import { FRAGMENT_HEADER_SIZE, FRAGMENT_PAYLOAD_SIZE } from './fragmenter';
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

  test('returns backpressure above 4 MiB and fires onDrain at low threshold', () => {
    const [a, b] = pairDataChannels();
    const carrier = new DataChannelCarrier(a);
    expect(a.lowThreshold).toBe(1024 * 1024);
    let drained = 0;
    carrier.onDrain(() => {
      drained += 1;
    });
    a.buffered = DC_HIGH_WATER_BYTES + 1;
    expect(carrier.send(new Uint8Array([1]))).toBe('backpressure');
    a.buffered = 10;
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

  test('sendMessageBinary uses Buffer and rejects when the channel refuses', () => {
    const [a] = pairDataChannels();
    const carrier = new DataChannelCarrier(a);
    a.failNextSend = true;
    expect(carrier.send(new Uint8Array([1, 2]))).toBe('backpressure');
  });
});
