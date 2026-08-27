import { describe, expect, test } from 'bun:test';
import {
  BULK_FRAME_SIZE,
  type BulkChannelSource,
  BulkClient,
  BulkTransferError,
  bulkChannelLabel,
  clearBulkClients,
  getBulkClient,
  iterateBulkFrames,
  registerBulkClient,
} from './bulk-client';
import type { RTCDataChannelLike } from './data-channel-carrier';

class FakeBulkChannel implements RTCDataChannelLike {
  readyState = 'connecting';
  binaryType = 'blob';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event?: unknown) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  onbufferedamountlow: ((event?: unknown) => void) | null = null;

  readonly label: string;
  readonly control: Array<Record<string, unknown>> = [];
  readonly data: Uint8Array[] = [];
  closeCount = 0;
  /** 每次 send 二进制后累加到 bufferedAmount，用来制造背压。 */
  bufferedPerFrame = 0;

  constructor(label: string) {
    this.label = label;
  }

  send(data: ArrayBufferView | ArrayBuffer | string): void {
    if (typeof data === 'string') {
      this.control.push(JSON.parse(data) as Record<string, unknown>);
      return;
    }
    const view = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    this.data.push(view.slice());
    this.bufferedAmount += this.bufferedPerFrame;
  }

  close(): void {
    this.closeCount += 1;
    this.readyState = 'closed';
  }

  open(): void {
    this.readyState = 'open';
    this.onopen?.();
  }

  deliverControl(value: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(value) });
  }

  deliverData(bytes: Uint8Array): void {
    this.onmessage?.({ data: bytes.slice().buffer });
  }

  drain(): void {
    this.bufferedAmount = 0;
    this.onbufferedamountlow?.();
  }

  simulateClose(): void {
    this.readyState = 'closed';
    this.onclose?.();
  }

  get sentBytes(): number {
    return this.data.reduce((sum, frame) => sum + frame.byteLength, 0);
  }
}

class FakeSource implements BulkChannelSource {
  state = 'active';
  readonly channels: FakeBulkChannel[] = [];
  /** 通道创建后自动 open（默认开）；关掉可测 open 超时/竞态。 */
  autoOpen = true;
  /** 新通道的初始 `bufferedPerFrame`，用于从第一帧起就制造背压。 */
  bufferedPerFrame = 0;

  getState(): string {
    return this.state;
  }

  createDataChannel(label: string): RTCDataChannelLike {
    const channel = new FakeBulkChannel(label);
    channel.bufferedPerFrame = this.bufferedPerFrame;
    this.channels.push(channel);
    if (this.autoOpen) queueMicrotask(() => channel.open());
    return channel;
  }

  get channel(): FakeBulkChannel {
    const first = this.channels[0];
    if (!first) throw new Error('no bulk channel created');
    return first;
  }
}

function bytes(n: number, fill = 7): Uint8Array<ArrayBuffer> {
  return new Uint8Array(n).fill(fill);
}

function blobOf(size: number): Blob {
  return new Blob([bytes(size)]);
}

function flush(times = 4): Promise<void> {
  let chain = Promise.resolve();
  for (let i = 0; i < times; i++) {
    chain = chain.then(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  }
  return chain;
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

describe('iterateBulkFrames', () => {
  test('Blob 切成恰好 frameSize 的帧，末帧可短', async () => {
    const frames: number[] = [];
    for await (const frame of iterateBulkFrames(blobOf(1000), 400)) frames.push(frame.byteLength);
    expect(frames).toEqual([400, 400, 200]);
  });

  test('ReadableStream 按 frameSize 重新分帧（跨 chunk 合并）', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes(300));
        controller.enqueue(new Uint8Array(0));
        controller.enqueue(bytes(300));
        controller.enqueue(bytes(50));
        controller.close();
      },
    });
    const frames: number[] = [];
    for await (const frame of iterateBulkFrames(stream, 256)) frames.push(frame.byteLength);
    expect(frames).toEqual([256, 256, 138]);
  });

  test('空 Blob 不产帧', async () => {
    const frames: number[] = [];
    for await (const frame of iterateBulkFrames(blobOf(0), 64)) frames.push(frame.byteLength);
    expect(frames).toEqual([]);
  });
});

describe('BulkClient.isAvailable', () => {
  test('仅 active 可用', () => {
    const source = new FakeSource();
    const client = new BulkClient(source);
    expect(client.isAvailable()).toBe(true);
    source.state = 'connecting';
    expect(client.isAvailable()).toBe(false);
    source.state = 'failed';
    expect(client.isAvailable()).toBe(false);
  });

  test('未 active 时 upload 直接回 unavailable，且不开通道', async () => {
    const source = new FakeSource();
    source.state = 'idle';
    const client = new BulkClient(source);
    await expect(client.upload({ transferId: 't1', size: 4, source: blobOf(4) })).resolves.toEqual({
      ok: false,
      code: 'unavailable',
    });
    expect(source.channels).toHaveLength(0);
  });
});

describe('BulkClient.upload', () => {
  test('happy path：put → 64 KiB 整帧 → done → {ok:true}，进度逐帧上报', async () => {
    const source = new FakeSource();
    const client = new BulkClient(source, { frameSize: 1024 });
    const progress: Array<[number, number]> = [];
    const size = 1024 * 2 + 300;
    const pending = client.upload({
      transferId: 'up-1',
      size,
      source: blobOf(size),
      onProgress: (sent, total) => progress.push([sent, total]),
    });
    await flush();
    const channel = source.channel;
    expect(channel.label).toBe(bulkChannelLabel('up-1'));
    expect(channel.control[0]).toEqual({ op: 'put', transferId: 'up-1', size });
    expect(channel.data.map((f) => f.byteLength)).toEqual([1024, 1024, 300]);
    expect(channel.control[1]).toEqual({ op: 'done' });
    channel.deliverControl({ ok: true });
    await expect(pending).resolves.toEqual({ ok: true });
    expect(progress).toEqual([
      [0, size],
      [1024, size],
      [2048, size],
      [size, size],
    ]);
    expect(channel.closeCount).toBe(1);
  });

  test('默认帧长为 64 KiB', async () => {
    const source = new FakeSource();
    const client = new BulkClient(source);
    const size = BULK_FRAME_SIZE + 5;
    const pending = client.upload({ transferId: 'up-2', size, source: blobOf(size) });
    await flush();
    expect(source.channel.data.map((f) => f.byteLength)).toEqual([BULK_FRAME_SIZE, 5]);
    source.channel.deliverControl({ ok: true });
    await pending;
  });

  test('背压：超高水位后暂停，drain 后继续', async () => {
    const source = new FakeSource();
    source.bufferedPerFrame = 200; // 首帧发完就越过高水位
    const client = new BulkClient(source, {
      frameSize: 100,
      highWaterBytes: 150,
      lowWaterBytes: 50,
    });
    const size = 500;
    const pending = client.upload({ transferId: 'up-3', size, source: blobOf(size) });
    await flush();
    const channel = source.channel;
    expect(channel.bufferedAmountLowThreshold).toBe(50);
    expect(channel.data.length).toBe(1);
    await flush();
    expect(channel.data.length).toBe(1); // 仍卡在背压上
    channel.bufferedPerFrame = 0;
    channel.drain();
    await flush();
    expect(channel.sentBytes).toBe(size);
    expect(channel.control.at(-1)).toEqual({ op: 'done' });
    channel.deliverControl({ ok: true });
    await expect(pending).resolves.toEqual({ ok: true });
  });

  test('node 回 {ok:false, code} 时 resolve 该结果（供调用方回落 REST）', async () => {
    const source = new FakeSource();
    const client = new BulkClient(source, { frameSize: 1024 });
    const pending = client.upload({ transferId: 'up-4', size: 10, source: blobOf(10) });
    await flush();
    source.channel.deliverControl({ ok: false, code: 'permission_denied' });
    await expect(pending).resolves.toEqual({ ok: false, code: 'permission_denied' });
    expect(source.channel.closeCount).toBe(1);
  });

  test('传输途中 node 报错：停止发送并回该结果', async () => {
    const source = new FakeSource();
    source.bufferedPerFrame = 100; // 首帧后立刻背压，卡住发送循环
    const client = new BulkClient(source, {
      frameSize: 100,
      highWaterBytes: 10,
      lowWaterBytes: 5,
    });
    const size = 1000;
    const pending = client.upload({ transferId: 'up-5', size, source: blobOf(size) });
    await flush();
    const channel = source.channel;
    const before = channel.data.length;
    channel.deliverControl({ ok: false, code: 'too_large' });
    channel.drain();
    await expect(pending).resolves.toEqual({ ok: false, code: 'too_large' });
    expect(channel.data.length).toBe(before);
    expect(channel.control.some((c) => c.op === 'done')).toBe(false);
  });

  test('中途 abort：发 {op:abort}、关通道并抛 AbortError', async () => {
    const source = new FakeSource();
    source.bufferedPerFrame = 100;
    const client = new BulkClient(source, {
      frameSize: 100,
      highWaterBytes: 10,
      lowWaterBytes: 5,
    });
    const controller = new AbortController();
    const pending = client.upload({
      transferId: 'up-6',
      size: 1000,
      source: blobOf(1000),
      signal: controller.signal,
    });
    await flush();
    const channel = source.channel;
    expect(channel.data.length).toBe(1);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(channel.control.some((c) => c.op === 'abort')).toBe(true);
    expect(channel.closeCount).toBe(1);
  });

  test('已 abort 的 signal：不开通道直接抛', async () => {
    const source = new FakeSource();
    const client = new BulkClient(source);
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.upload({ transferId: 'up-7', size: 1, source: blobOf(1), signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(source.channels).toHaveLength(0);
  });

  test('通道中途关闭：reject closed', async () => {
    const source = new FakeSource();
    const client = new BulkClient(source, { frameSize: 1024 });
    const pending = client.upload({ transferId: 'up-8', size: 4096, source: blobOf(4096) });
    await flush();
    source.channel.simulateClose();
    await expect(pending).rejects.toBeInstanceOf(BulkTransferError);
  });

  test('通道打不开：open 超时后 reject', async () => {
    const source = new FakeSource();
    source.autoOpen = false;
    const client = new BulkClient(source, { openTimeoutMs: 5 });
    const pending = client.upload({ transferId: 'up-9', size: 4, source: blobOf(4) });
    await expect(pending).rejects.toMatchObject({ code: 'timeout' });
    expect(source.channel.control.some((c) => c.op === 'put')).toBe(false);
  });

  test('oversize 守卫：源字节多于声明的 size 时 abort 并抛', async () => {
    const source = new FakeSource();
    const client = new BulkClient(source, { frameSize: 100 });
    const pending = client.upload({ transferId: 'up-10', size: 150, source: blobOf(400) });
    await expect(pending).rejects.toMatchObject({ code: 'too_large' });
    expect(source.channel.control.some((c) => c.op === 'abort')).toBe(true);
    expect(source.channel.sentBytes).toBeLessThanOrEqual(150);
  });

  test('ReadableStream 源：分帧与 Blob 一致', async () => {
    const source = new FakeSource();
    const client = new BulkClient(source, { frameSize: 64 });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes(100));
        controller.enqueue(bytes(60));
        controller.close();
      },
    });
    const pending = client.upload({ transferId: 'up-11', size: 160, source: stream });
    await flush();
    expect(source.channel.data.map((f) => f.byteLength)).toEqual([64, 64, 32]);
    source.channel.deliverControl({ ok: true });
    await expect(pending).resolves.toEqual({ ok: true });
  });
});

describe('BulkClient.download', () => {
  test('get → 帧 → eof：流按序产出内容', async () => {
    const source = new FakeSource();
    const client = new BulkClient(source, { frameSize: 64 });
    const progress: number[] = [];
    const stream = client.download({
      transferId: 'dl-1',
      onProgress: (received) => progress.push(received),
    });
    const pending = readAll(stream);
    await flush();
    const channel = source.channel;
    expect(channel.label).toBe(bulkChannelLabel('dl-1'));
    expect(channel.control[0]).toEqual({ op: 'get' });
    channel.deliverData(bytes(64, 1));
    channel.deliverData(bytes(10, 2));
    channel.deliverControl({ op: 'eof' });
    const out = await pending;
    expect(out.byteLength).toBe(74);
    expect(out[0]).toBe(1);
    expect(out[64]).toBe(2);
    expect(progress).toEqual([64, 74]);
    expect(channel.closeCount).toBe(1);
  });

  test('node 回 {ok:false} 时 error 流', async () => {
    const source = new FakeSource();
    const client = new BulkClient(source);
    const stream = client.download({ transferId: 'dl-2' });
    const pending = readAll(stream);
    await flush();
    source.channel.deliverControl({ ok: false, code: 'not_found' });
    await expect(pending).rejects.toMatchObject({ code: 'not_found' });
  });

  test('未 active 时 error 流且不开通道', async () => {
    const source = new FakeSource();
    source.state = 'failed';
    const client = new BulkClient(source);
    await expect(readAll(client.download({ transferId: 'dl-3' }))).rejects.toMatchObject({
      code: 'unavailable',
    });
    expect(source.channels).toHaveLength(0);
  });

  test('oversize 守卫：超 frameSize 的帧 error 流并 abort', async () => {
    const source = new FakeSource();
    const client = new BulkClient(source, { frameSize: 64 });
    const pending = readAll(client.download({ transferId: 'dl-4' }));
    await flush();
    source.channel.deliverData(bytes(65));
    await expect(pending).rejects.toMatchObject({ code: 'too_large' });
    expect(source.channel.control.some((c) => c.op === 'abort')).toBe(true);
  });

  test('eof 之前通道关闭：error 流', async () => {
    const source = new FakeSource();
    const client = new BulkClient(source, { frameSize: 64 });
    const pending = readAll(client.download({ transferId: 'dl-5' }));
    await flush();
    source.channel.deliverData(bytes(8));
    source.channel.simulateClose();
    await expect(pending).rejects.toMatchObject({ code: 'closed' });
  });

  test('消费方 cancel：向 node 发 abort 并关通道', async () => {
    const source = new FakeSource();
    const client = new BulkClient(source, { frameSize: 64 });
    const stream = client.download({ transferId: 'dl-6' });
    const reader = stream.getReader();
    await flush();
    await reader.cancel();
    expect(source.channel.control.some((c) => c.op === 'abort')).toBe(true);
    expect(source.channel.closeCount).toBe(1);
  });

  test('signal abort：error 流并 abort 通道', async () => {
    const source = new FakeSource();
    const client = new BulkClient(source, { frameSize: 64 });
    const controller = new AbortController();
    const pending = readAll(client.download({ transferId: 'dl-7', signal: controller.signal }));
    await flush();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(source.channel.control.some((c) => c.op === 'abort')).toBe(true);
  });
});

describe('bulk client registry', () => {
  test('登记 / 取用 / 注销', () => {
    clearBulkClients();
    const client = new BulkClient(new FakeSource());
    expect(getBulkClient('node-a')).toBeNull();
    registerBulkClient('node-a', client);
    expect(getBulkClient('node-a')).toBe(client);
    registerBulkClient('node-a', null);
    expect(getBulkClient('node-a')).toBeNull();
    registerBulkClient('', client);
    expect(getBulkClient('')).toBeNull();
    clearBulkClients();
  });
});
