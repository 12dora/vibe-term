import { describe, expect, test } from 'bun:test';
import type { ByteTransport, LinkStream } from '@vibeterm/shared/link';
import { LinkMux } from '@vibeterm/shared/link';
import { WebSocketSendGuard } from '../ws/websocket-send-guard';
import { LinkStreamCarrier } from './link-stream-carrier';

/**
 * 转发终端会话的优先通道基准。
 *
 * 用一条限速 + 单向时延的假传输把「节点 → 入口」这一跳搭出来，节点侧持续灌终端输出，
 * 中途插一帧 PONG 大小的控制帧，量它到达入口要多久。
 *
 * before（本轮之前的行为）：`LinkStreamCarrier` 没有 `sendPriority`，控制帧退回 `send()`，
 * 排在 1 MiB 在途后面，本机实测 150–180 ms。
 * after：优先队列 + mux 优先写链 + 预留信用 + 在途压到 64 KiB，本机实测 20 ms 上下，
 * 已经贴着链路本身的 15 ms 单向时延。
 */

const TICK_MS = 5;
const BYTES_PER_MS = 4096;
const ONE_WAY_DELAY_MS = 15;
const FILLER_BYTES = 4096;
const PROBE_BYTES = 48;
const BEFORE_INFLIGHT_BYTES = 1024 * 1024;
const AFTER_INFLIGHT_BYTES = 64 * 1024;
const WARMUP_MS = 400;
const PROBE_DEADLINE_MS = 1_500;

class ThrottledEnd implements ByteTransport {
  deliverToPeer: (bytes: Uint8Array) => void = () => undefined;
  private readonly dataCbs: Array<(bytes: Uint8Array) => void> = [];
  private readonly closeCbs: Array<(reason?: string) => void> = [];
  private readonly outbox: Uint8Array[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  send(bytes: Uint8Array): void {
    if (this.closed) return;
    this.outbox.push(bytes.slice());
    if (!this.timer) this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  receive(bytes: Uint8Array): void {
    if (this.closed) return;
    for (const cb of this.dataCbs) cb(bytes);
  }

  onData(cb: (bytes: Uint8Array) => void): void {
    this.dataCbs.push(cb);
  }

  onClose(cb: (reason?: string) => void): void {
    this.closeCbs.push(cb);
  }

  close(reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.stop();
    for (const cb of this.closeCbs) cb(reason);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** 每个 tick 只放行 `BYTES_PER_MS * TICK_MS` 字节，放行的部分再等单向时延才落到对端。 */
  private tick(): void {
    let budget = BYTES_PER_MS * TICK_MS;
    while (budget > 0 && this.outbox.length > 0) {
      const head = this.outbox[0];
      if (!head) break;
      const take = Math.min(budget, head.byteLength);
      const piece = head.subarray(0, take).slice();
      if (take === head.byteLength) this.outbox.shift();
      else this.outbox[0] = head.subarray(take);
      budget -= take;
      setTimeout(() => {
        if (!this.closed) this.deliverToPeer(piece);
      }, ONE_WAY_DELAY_MS);
    }
    if (this.outbox.length === 0) this.stop();
  }
}

function throttledPair(): [ThrottledEnd, ThrottledEnd] {
  const a = new ThrottledEnd();
  const b = new ThrottledEnd();
  a.deliverToPeer = (bytes) => b.receive(bytes);
  b.deliverToPeer = (bytes) => a.receive(bytes);
  return [a, b];
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function measureProbeLatency(mode: 'before' | 'after'): Promise<number> {
  const [nodeEnd, entryEnd] = throttledPair();
  const node = new LinkMux(nodeEnd, { role: 'initiator' });
  const entry = new LinkMux(entryEnd, { role: 'acceptor' });
  const incomingP = new Promise<LinkStream>((resolve) => entry.onStream(resolve));
  const out = await node.openStream(new Uint8Array([1]));
  const incoming = await incomingP;
  const carrier = new LinkStreamCarrier(out, {
    highWaterMark: mode === 'before' ? BEFORE_INFLIGHT_BYTES : AFTER_INFLIGHT_BYTES,
  });
  const guard = new WebSocketSendGuard({ timeoutMs: 60_000, onTerminate() {} });
  carrier.onDrain(() => guard.handleDrain(carrier));

  let probeSeenAt = 0;
  const reader = incoming.readable.getReader();
  const consume = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.bytes.byteLength === PROBE_BYTES && probeSeenAt === 0) {
          probeSeenAt = performance.now();
        }
      }
    } catch {
      // 链路收尾
    }
  })();

  const filler = new Uint8Array(FILLER_BYTES).fill(7);
  let running = true;
  const produce = (async () => {
    while (running) {
      // 每轮多灌几帧：生产必须快过链路，否则队列根本堆不起来，也就量不出排队时延。
      for (let i = 0; i < 64 && !guard.isBackpressured(carrier); i++) {
        guard.sendFramesStatus(carrier, [filler as unknown as BufferSource]);
      }
      await sleep(0);
    }
  })();

  await sleep(WARMUP_MS);
  const probe = new Uint8Array(PROBE_BYTES).fill(9);
  const probeAt = performance.now();
  // before：没有优先通道，控制帧只能退回普通队列，排在整段积压后面。
  if (mode === 'before') carrier.send(probe);
  else carrier.sendPriority(probe);

  const deadline = probeAt + PROBE_DEADLINE_MS;
  while (probeSeenAt === 0 && performance.now() < deadline) await sleep(5);
  running = false;
  await produce;

  const latency = probeSeenAt === 0 ? PROBE_DEADLINE_MS : probeSeenAt - probeAt;
  carrier.terminate();
  node.close('done');
  entry.close('done');
  nodeEnd.stop();
  entryEnd.stop();
  await consume;
  return latency;
}

describe('转发会话优先通道基准', () => {
  test('大流量下控制帧的单向时延贴近链路时延，而不是队列深度', async () => {
    const before = await measureProbeLatency('before');
    const after = await measureProbeLatency('after');
    console.log(
      `[bench] priority probe one-way: before=${before.toFixed(0)}ms after=${after.toFixed(0)}ms ` +
        `(link one-way ${ONE_WAY_DELAY_MS}ms, ${BYTES_PER_MS} B/ms)`
    );
    // 之前排在积压后面，至少是链路时延的十几倍；现在应当落在同一量级。
    expect(before).toBeGreaterThan(120);
    expect(after).toBeLessThan(100);
    expect(after).toBeLessThan(before / 3);
  }, 15_000);
});
