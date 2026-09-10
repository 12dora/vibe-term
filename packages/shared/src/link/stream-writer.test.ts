import { describe, expect, it } from 'bun:test';
import { FrameDecoder } from './codec';
import { createBytePipe } from './in-memory-link';
import { LinkMux } from './mux';
import {
  FLAG_HEAD,
  FrameOp,
  type LinkStream,
  MAX_DATA_SEND_PAYLOAD,
  PRIORITY_SEND_RESERVE,
} from './types';

const WINDOW = 64 * 1024;

type Pair = {
  out: LinkStream;
  incoming: LinkStream;
  sender: LinkMux;
  receiver: LinkMux;
};

async function openPair(streamWindow = WINDOW): Promise<Pair> {
  const [t1, t2] = createBytePipe();
  const sender = new LinkMux(t1, { role: 'initiator', streamWindow });
  const receiver = new LinkMux(t2, { role: 'acceptor', streamWindow });
  const incomingP = new Promise<LinkStream>((resolve) => receiver.onStream(resolve));
  const out = await sender.openStream(new Uint8Array([1]));
  const incoming = await incomingP;
  return { out, incoming, sender, receiver };
}

function tag(bytes: Uint8Array): number {
  return bytes[0] ?? -1;
}

describe('StreamWriter 优先写', () => {
  it('优先写插到已排队的普通写之前，并动用预留信用', async () => {
    const { out, incoming, sender } = await openPair();
    out.reservePriorityCredit?.();
    // 窗口 64 KiB、预留 16 KiB：普通写只能用 48 KiB，第 4 块开始排队等信用。
    const normals: Promise<void>[] = [];
    for (let i = 0; i < 6; i++) {
      const chunk = new Uint8Array(16 * 1024).fill(i + 1);
      normals.push(out.write(chunk).catch(() => undefined));
    }
    await new Promise((resolve) => setTimeout(resolve, 10));

    const probe = new Uint8Array([0xfe, 0xed]);
    const probeSent = out.write(probe, { priority: true });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const reader = incoming.readable.getReader();
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      const { value } = await reader.read();
      if (!value) break;
      seen.push(tag(value.bytes));
    }
    // 前三块普通数据吃满 48 KiB，第四条到达的是优先帧，而不是排在它前面的第 4 块。
    expect(seen).toEqual([1, 2, 3, 0xfe]);
    await probeSent;
    const drain = (async () => {
      try {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      } catch {
        // 流被 close 掐断
      }
    })();
    await Promise.all(normals);
    sender.close();
    await drain;
  });

  it('没 arm 预留时普通写可以用满整个窗口', async () => {
    const { out, incoming, sender } = await openPair();
    await out.write(new Uint8Array(WINDOW).fill(7));
    const reader = incoming.readable.getReader();
    const { value } = await reader.read();
    expect(value?.bytes.byteLength).toBe(WINDOW);
    sender.close();
  });

  it('arm 之后普通写只能用到窗口减预留', async () => {
    const { out, incoming, sender } = await openPair();
    out.reservePriorityCredit?.();
    let done = false;
    void out.write(new Uint8Array(WINDOW).fill(7)).then(
      () => {
        done = true;
      },
      () => undefined
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(done).toBe(false);
    const reader = incoming.readable.getReader();
    const { value } = await reader.read();
    expect(value?.bytes.byteLength).toBe(WINDOW - PRIORITY_SEND_RESERVE);
    sender.close();
  });

  it('信用只剩零头时不把消息切碎：整条消息一帧到达', async () => {
    const { out, incoming, sender } = await openPair();
    // 先吃掉 60 KiB，只剩 4 KiB 信用；下一条 16 KiB 的消息必须等够信用再整条发。
    await out.write(new Uint8Array(WINDOW - 4 * 1024).fill(1));
    const second = out.write(new Uint8Array(16 * 1024).fill(2));
    const reader = incoming.readable.getReader();
    const first = await reader.read();
    expect(first.value?.bytes.byteLength).toBe(WINDOW - 4 * 1024);
    const next = await reader.read();
    expect(next.value?.bytes.byteLength).toBe(16 * 1024);
    expect(tag(next.value?.bytes ?? new Uint8Array())).toBe(2);
    await second;
    sender.close();
  });

  it('优先帧不会挤进一条多片消息的分片中间', async () => {
    const captured: Uint8Array[] = [];
    const [t1, t2] = createBytePipe();
    t2.onData((bytes) => captured.push(bytes.slice()));
    const sender = new LinkMux(t1, { role: 'initiator', streamWindow: 1024 * 1024 });
    const receiver = new LinkMux(t2, { role: 'acceptor', streamWindow: 1024 * 1024 });
    const incomingP = new Promise<LinkStream>((resolve) => receiver.onStream(resolve));
    const out = await sender.openStream(new Uint8Array([1]));
    const incoming = await incomingP;
    out.reservePriorityCredit?.();
    const bulk = out.write(new Uint8Array(3 * MAX_DATA_SEND_PAYLOAD).fill(9));
    const probe = out.write(new Uint8Array([0xfe]), { priority: true });
    const drain = (async () => {
      const reader = incoming.readable.getReader();
      try {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      } catch {
        // 流被 close 掐断
      }
    })();
    await bulk;
    await probe;
    await out.end();
    await drain;

    const frames = new FrameDecoder().push(concat(captured));
    const data = frames.filter((f) => f.op === FrameOp.DATA && f.streamId === out.id);
    const probeIndex = data.findIndex((f) => f.payload.byteLength === 1);
    expect(probeIndex).toBeGreaterThanOrEqual(0);
    // 三片 256 KiB 的大消息必须连续，优先帧只能落在整条消息之前或之后。
    const bigBefore = data.slice(0, probeIndex).filter((f) => f.payload.byteLength > 1).length;
    expect(bigBefore === 0 || bigBefore === 3).toBe(true);
    expect(data[0] && (data[0].flags & FLAG_HEAD) === 0).toBe(true);
    sender.close();
  });
});

function concat(chunks: Uint8Array[]): Uint8Array {
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
