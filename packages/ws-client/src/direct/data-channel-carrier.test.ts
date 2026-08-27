import { describe, expect, test } from 'bun:test';
import {
  DC_HIGH_WATER_BYTES,
  DC_LOW_WATER_BYTES,
  DirectDataChannelCarrier,
} from './data-channel-carrier';
import { FRAGMENT_HEADER_SIZE, FRAGMENT_PAYLOAD_SIZE, fragmentFrame } from './fragmenter';
import { FakeDataChannel } from './test-fakes';

function openChannel(): FakeDataChannel {
  const channel = new FakeDataChannel();
  channel.readyState = 'open';
  return channel;
}

describe('DirectDataChannelCarrier', () => {
  test('构造时设 arraybuffer + 低水位 1 MiB', () => {
    const channel = openChannel();
    new DirectDataChannelCarrier(channel);
    expect(channel.binaryType).toBe('arraybuffer');
    expect(channel.bufferedAmountLowThreshold).toBe(DC_LOW_WATER_BYTES);
  });

  test('send 按 64 KiB 分片，返回 sent', () => {
    const channel = openChannel();
    const carrier = new DirectDataChannelCarrier(channel);
    const payload = new Uint8Array(FRAGMENT_PAYLOAD_SIZE + 10);
    expect(carrier.send(payload)).toBe('sent');
    expect(channel.sent.length).toBe(2);
    expect((channel.sent[0] as Uint8Array).byteLength).toBe(
      FRAGMENT_HEADER_SIZE + FRAGMENT_PAYLOAD_SIZE
    );
    expect((channel.sent[1] as Uint8Array).byteLength).toBe(FRAGMENT_HEADER_SIZE + 10);
  });

  test('bufferedAmount 超过 4 MiB 高水位后返回 backpressure，drain 回调在 bufferedamountlow 触发', () => {
    const channel = openChannel();
    const carrier = new DirectDataChannelCarrier(channel);
    let drained = 0;
    carrier.onDrain(() => {
      drained += 1;
    });

    expect(carrier.send(new Uint8Array(4))).toBe('sent');
    channel.bufferedAmount = DC_HIGH_WATER_BYTES + 1;
    expect(carrier.send(new Uint8Array(4))).toBe('backpressure');
    expect(carrier.bufferedAmount()).toBe(DC_HIGH_WATER_BYTES + 1);

    channel.drain();
    expect(drained).toBe(1);
    expect(carrier.send(new Uint8Array(4))).toBe('sent');
  });

  test('通道未 open 或已关闭时 send 返回 closed', () => {
    const channel = new FakeDataChannel();
    const carrier = new DirectDataChannelCarrier(channel);
    expect(carrier.send(new Uint8Array(1))).toBe('closed');

    channel.readyState = 'open';
    expect(carrier.send(new Uint8Array(1))).toBe('sent');
    channel.simulateClose();
    expect(carrier.send(new Uint8Array(1))).toBe('closed');
  });

  test('send 抛异常但通道仍 open 时视为背压', () => {
    const channel = openChannel();
    const carrier = new DirectDataChannelCarrier(channel);
    channel.throwOnSend = true;
    expect(carrier.send(new Uint8Array(1))).toBe('backpressure');
  });

  test('入站分片重组后才回调 onMessage', () => {
    const channel = openChannel();
    const carrier = new DirectDataChannelCarrier(channel);
    const received: Uint8Array[] = [];
    carrier.onMessage((bytes) => received.push(bytes));

    const original = new Uint8Array(FRAGMENT_PAYLOAD_SIZE + 3).fill(7);
    const parts = fragmentFrame(1, original);
    channel.deliver(parts[0] as Uint8Array);
    expect(received.length).toBe(0);
    channel.deliver(parts[1] as Uint8Array);
    expect(received.length).toBe(1);
    expect((received[0] as Uint8Array).byteLength).toBe(original.byteLength);
  });

  test('onClose 只回调一次（close() 与对端关闭都收敛到同一处）', () => {
    const channel = openChannel();
    const carrier = new DirectDataChannelCarrier(channel);
    let closed = 0;
    carrier.onClose(() => {
      closed += 1;
    });
    carrier.close();
    channel.simulateClose();
    expect(closed).toBe(1);
    expect(channel.closeCount).toBe(1);
    expect(carrier.isClosed).toBe(true);
  });
});
