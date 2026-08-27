import { describe, expect, test } from 'bun:test';
import {
  DC_HIGH_WATER_BYTES,
  DC_LOW_WATER_BYTES,
  DirectDataChannelCarrier,
} from './data-channel-carrier';
import {
  FRAGMENT_HEADER_SIZE,
  FRAGMENT_PAYLOAD_SIZE,
  MAX_DC_MESSAGE_BYTES,
  MAX_FRAME_BYTES,
  fragmentFrame,
} from './fragmenter';
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

  test('send 按 65528 分片（含头恰好 64 KiB），返回 sent', () => {
    const channel = openChannel();
    const carrier = new DirectDataChannelCarrier(channel);
    const payload = new Uint8Array(FRAGMENT_PAYLOAD_SIZE + 10);
    expect(carrier.send(payload)).toBe('sent');
    expect(channel.sent.length).toBe(2);
    expect((channel.sent[0] as Uint8Array).byteLength).toBe(MAX_DC_MESSAGE_BYTES);
    expect((channel.sent[1] as Uint8Array).byteLength).toBe(FRAGMENT_HEADER_SIZE + 10);
  });

  test('对端 maxMessageSize 更小时分片跟着缩小', () => {
    const channel = openChannel();
    const carrier = new DirectDataChannelCarrier(channel, { maxMessageBytes: 16_384 });
    expect(carrier.send(new Uint8Array(20_000))).toBe('sent');
    expect((channel.sent[0] as Uint8Array).byteLength).toBe(16_384);
  });

  test('高水位以上整帧入队，bufferedamountlow 后按序写出', () => {
    const channel = openChannel();
    const carrier = new DirectDataChannelCarrier(channel);
    let drained = 0;
    carrier.onDrain(() => {
      drained += 1;
    });

    expect(carrier.send(new Uint8Array(4))).toBe('sent');
    expect(channel.sent.length).toBe(1);

    channel.bufferedAmount = DC_HIGH_WATER_BYTES + 1;
    expect(carrier.send(new Uint8Array(4))).toBe('backpressure');
    // 排队而非继续压进通道
    expect(channel.sent.length).toBe(1);
    expect(carrier.queuedBytesPending).toBe(4);
    // 队列非空时后续帧继续排队，保持顺序
    expect(carrier.send(new Uint8Array(6))).toBe('backpressure');
    expect(channel.sent.length).toBe(1);

    channel.drain();
    expect(channel.sent.length).toBe(3);
    expect(carrier.queuedBytesPending).toBe(0);
    expect(drained).toBe(1);
    expect(carrier.send(new Uint8Array(4))).toBe('sent');
  });

  test('队列超过上限时关闭载体（回落 primary 比无限攒内存好）', () => {
    const channel = openChannel();
    const reasons: string[] = [];
    const carrier = new DirectDataChannelCarrier(channel, {
      maxQueuedBytes: 1024,
      onProtocolError: (reason) => reasons.push(reason),
    });
    channel.bufferedAmount = DC_HIGH_WATER_BYTES + 1;
    expect(carrier.send(new Uint8Array(600))).toBe('backpressure');
    expect(carrier.send(new Uint8Array(600))).toBe('closed');
    expect(carrier.isClosed).toBe(true);
    expect(reasons).toEqual(['outbound queue overflow']);
  });

  test('出站帧超过 1 MiB 时关闭载体', () => {
    const channel = openChannel();
    const reasons: string[] = [];
    const carrier = new DirectDataChannelCarrier(channel, {
      onProtocolError: (reason) => reasons.push(reason),
    });
    expect(carrier.send(new Uint8Array(MAX_FRAME_BYTES + 1))).toBe('closed');
    expect(carrier.isClosed).toBe(true);
    expect(reasons[0]).toContain('outbound frame too large');
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

  test('分片中途抛异常：关闭载体而不是留一个半帧', () => {
    const channel = openChannel();
    const reasons: string[] = [];
    const carrier = new DirectDataChannelCarrier(channel, {
      onProtocolError: (reason) => reasons.push(reason),
    });
    let closed = 0;
    carrier.onClose(() => {
      closed += 1;
    });
    channel.throwOnSendAfter = 1;
    expect(carrier.send(new Uint8Array(FRAGMENT_PAYLOAD_SIZE + 1))).toBe('closed');
    expect(carrier.isClosed).toBe(true);
    expect(closed).toBe(1);
    expect(reasons).toEqual(['data channel send failed mid-frame']);
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

  test('入站协议违规（total=65535）直接关闭载体', () => {
    const channel = openChannel();
    const reasons: string[] = [];
    const carrier = new DirectDataChannelCarrier(channel, {
      onProtocolError: (reason) => reasons.push(reason),
    });
    const malicious = new Uint8Array(FRAGMENT_HEADER_SIZE + 8);
    malicious[6] = 0xff;
    malicious[7] = 0xff;
    channel.deliver(malicious);
    expect(carrier.isClosed).toBe(true);
    expect(reasons).toEqual(['inbound bad-total']);
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
