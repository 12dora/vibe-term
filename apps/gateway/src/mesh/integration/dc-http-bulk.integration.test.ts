import { afterEach, describe, expect, test } from 'bun:test';

// 真实 node-datachannel 的 ICE/DC 用例需要可用的本地网络候选；CI runner 没有，用环境变量跳过。
const describeRtc = process.env.TMEX_SKIP_RTC_TESTS === '1' ? describe.skip : describe;
import {
  FRAME_HEADER_SIZE,
  FrameOp,
  LinkMux,
  MAX_DATA_SEND_PAYLOAD,
  MAX_FRAME_PAYLOAD,
} from '@tmex/shared/link';
import { createMigratedAuthDb } from '../../auth/test-db';
import { UserStore } from '../../auth/user-store';
import { DataChannelLink } from '../rtc/data-channel-link';
import { DC_MAX_MESSAGE_BYTES, FRAGMENT_HEADER_SIZE } from '../rtc/fragmenter';
import type { DataChannelLike } from '../rtc/native';
import { copyBytes, toUint8Array } from '../rtc/native';
import { RtcPeerManager } from '../rtc/rtc-peer-manager';
import { loopbackSignaling } from '../rtc/rtc-test-fixtures';
import { createFakeNativeModule } from '../rtc/test-fakes';
import { openHttpStream } from '../stream-targets';
import { seedNodeIdentity, seedUser } from '../test-support';

const EIGHT_MIB = 8 * 1024 * 1024;
const SIXTEEN_KIB = 16 * 1024;
const TWO_MIB = 2 * 1024 * 1024;
const SLOW_DC_TICK_MS = 50;
const SLOW_DC_BYTES_PER_TICK = 64 * 1024;
const SLOW_DC_DELAY_MS = 80;
const SLOW_DC_SEND_CAP = 256 * 1024;
const SLOW_CONSUMER_BYTES_PER_SEC = 500 * 1024;

type SlowDcPair = {
  a: RateLimitedDataChannel;
  b: RateLimitedDataChannel;
  close: () => void;
};

class RateLimitedDataChannel implements DataChannelLike {
  label: string;
  open = false;
  closed = false;
  peer: RateLimitedDataChannel | null = null;
  private buffered = 0;
  private readonly maxSize = 64 * 1024;
  private lowThreshold = 0;
  private readonly queue: Uint8Array[] = [];
  private readonly inflight: Array<{ bytes: Uint8Array; at: number }> = [];
  private openCb: (() => void) | null = null;
  private closedCb: (() => void) | null = null;
  private errorCb: ((err: string) => void) | null = null;
  private lowCb: (() => void) | null = null;
  private messageCb: ((msg: string | Buffer | ArrayBuffer) => void) | null = null;
  private readonly pendingMessages: Array<string | Buffer | ArrayBuffer> = [];
  private pumpTimer: ReturnType<typeof setInterval> | null = null;
  private readonly tickMs: number;
  private readonly bytesPerTick: number;
  private readonly delayMs: number;
  private readonly sendCap: number;
  inboundDepth = 0;
  holdReceiveCallbackMs = 0;
  readonly wire: Uint8Array[] = [];

  constructor(
    label: string,
    opts: {
      tickMs: number;
      bytesPerTick: number;
      delayMs: number;
      sendCap: number;
      holdReceiveCallbackMs?: number;
    }
  ) {
    this.label = label;
    this.tickMs = opts.tickMs;
    this.bytesPerTick = opts.bytesPerTick;
    this.delayMs = opts.delayMs;
    this.sendCap = opts.sendCap;
    this.holdReceiveCallbackMs = opts.holdReceiveCallbackMs ?? 0;
  }

  getLabel(): string {
    return this.label;
  }

  pair(peer: RateLimitedDataChannel): void {
    this.peer = peer;
    peer.peer = this;
  }

  markOpen(): void {
    if (this.open || this.closed) return;
    this.open = true;
    this.ensurePump();
    this.openCb?.();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    this.stopPump();
    const peer = this.peer;
    this.peer = null;
    this.closedCb?.();
    if (peer && !peer.closed) peer.close();
  }

  sendMessage(msg: string): boolean {
    if (this.inboundDepth > 0) {
      return true;
    }
    return this.enqueue(new TextEncoder().encode(msg));
  }

  sendMessageBinary(buffer: Buffer | Uint8Array): boolean {
    if (this.inboundDepth > 0) {
      return true;
    }
    return this.enqueue(toUint8Array(buffer));
  }

  isOpen(): boolean {
    return this.open && !this.closed;
  }

  bufferedAmount(): number {
    return this.buffered;
  }

  maxMessageSize(): number {
    return this.maxSize;
  }

  setBufferedAmountLowThreshold(bytes: number): void {
    this.lowThreshold = bytes;
  }

  onBufferedAmountLow(cb: () => void): void {
    this.lowCb = cb;
  }

  onOpen(cb: () => void): void {
    this.openCb = cb;
    if (this.open) cb();
  }

  onClosed(cb: () => void): void {
    this.closedCb = cb;
  }

  onError(cb: (err: string) => void): void {
    this.errorCb = cb;
  }

  onMessage(cb: (msg: string | Buffer | ArrayBuffer) => void): void {
    this.messageCb = cb;
    while (this.pendingMessages.length > 0) {
      const next = this.pendingMessages.shift();
      if (next !== undefined) this.deliverInbound(cb, next);
    }
  }

  private deliverInbound(
    cb: (msg: string | Buffer | ArrayBuffer) => void,
    msg: string | Buffer | ArrayBuffer
  ): void {
    this.inboundDepth += 1;
    try {
      cb(msg);
    } finally {
      if (this.holdReceiveCallbackMs > 0) {
        setTimeout(() => {
          this.inboundDepth = Math.max(0, this.inboundDepth - 1);
        }, this.holdReceiveCallbackMs);
      } else {
        this.inboundDepth -= 1;
      }
    }
  }

  private enqueue(bytes: Uint8Array): boolean {
    if (this.closed || !this.open) return false;
    if (this.buffered >= this.sendCap) return false;
    const copy = copyBytes(bytes);
    this.queue.push(copy);
    this.buffered += copy.byteLength;
    this.ensurePump();
    return true;
  }

  private ensurePump(): void {
    if (this.pumpTimer || this.closed || !this.open) return;
    this.pumpTimer = setInterval(() => this.tick(), this.tickMs);
  }

  private stopPump(): void {
    if (this.pumpTimer) {
      clearInterval(this.pumpTimer);
      this.pumpTimer = null;
    }
  }

  private tick(): void {
    if (this.closed) {
      this.stopPump();
      return;
    }
    const now = Date.now();
    let budget = this.bytesPerTick;
    while (budget > 0 && this.queue.length > 0) {
      const next = this.queue[0];
      if (!next) break;
      if (next.byteLength > budget && this.inflight.length > 0) break;
      this.queue.shift();
      const prev = this.buffered;
      this.buffered = Math.max(0, this.buffered - next.byteLength);
      if (prev > this.lowThreshold && this.buffered <= this.lowThreshold) {
        this.lowCb?.();
      }
      this.wire.push(next);
      this.inflight.push({ bytes: next, at: now + this.delayMs });
      budget -= next.byteLength;
    }
    while (this.inflight.length > 0) {
      const item = this.inflight[0];
      if (!item || item.at > now) break;
      this.inflight.shift();
      const peer = this.peer;
      if (!peer || peer.closed || !peer.open) continue;
      const payload = Buffer.from(item.bytes);
      if (!peer.messageCb) peer.pendingMessages.push(payload);
      else peer.deliverInbound(peer.messageCb, payload);
    }
    if (this.queue.length === 0 && this.inflight.length === 0) this.stopPump();
  }
}

function pairRateLimitedChannels(holdReceiveCallbackMs = 0): SlowDcPair {
  const opts = {
    tickMs: SLOW_DC_TICK_MS,
    bytesPerTick: SLOW_DC_BYTES_PER_TICK,
    delayMs: SLOW_DC_DELAY_MS,
    sendCap: SLOW_DC_SEND_CAP,
    holdReceiveCallbackMs,
  };
  const a = new RateLimitedDataChannel('peer', opts);
  const b = new RateLimitedDataChannel('peer', opts);
  a.pair(b);
  a.markOpen();
  b.markOpen();
  return {
    a,
    b,
    close: () => {
      a.close();
      b.close();
    },
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = bytes.slice();
  const digest = await crypto.subtle.digest('SHA-256', copy);
  return [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, '0')).join('');
}

function muxOpFromDcChunk(chunk: Uint8Array): number | undefined {
  if (chunk.byteLength < FRAGMENT_HEADER_SIZE + 5) return undefined;
  return chunk[FRAGMENT_HEADER_SIZE + 4];
}

function fillPattern(bytes: Uint8Array, start = 0): Uint8Array {
  for (let i = 0; i < bytes.byteLength; i++) bytes[i] = (start + i) & 0xff;
  return bytes;
}

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

/** Matches Bun `Response(Uint8Array)` chunking for an 8 MiB body: 16 KiB then 2 MiB slices. */
function bunLikeChunks(bytes: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  if (bytes.byteLength === 0) return chunks;
  const first = Math.min(SIXTEEN_KIB, bytes.byteLength);
  chunks.push(bytes.subarray(0, first));
  for (let offset = first; offset < bytes.byteLength; offset += TWO_MIB) {
    chunks.push(bytes.subarray(offset, Math.min(bytes.byteLength, offset + TWO_MIB)));
  }
  return chunks;
}

describeRtc('HTTP-style bulk over PeerManager DataChannel', () => {
  const fixtures: Array<{ close: () => void }> = [];
  afterEach(() => {
    while (fixtures.length) fixtures.pop()?.close();
  });

  function setup() {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const a = seedNodeIdentity(store, 'user-1');
    const b = seedNodeIdentity(store, 'user-1');
    const fake = createFakeNativeModule();
    const ice = () => ({ stun: [] as string[], turn: null });
    const left = new RtcPeerManager({
      loadNative: async () => fake.module,
      iceConfigProvider: ice,
      identity: a,
      userStore: store,
      handshakeTimeoutMs: 2_000,
      liveness: false,
    });
    const right = new RtcPeerManager({
      loadNative: async () => fake.module,
      iceConfigProvider: ice,
      identity: b,
      userStore: store,
      handshakeTimeoutMs: 2_000,
      liveness: false,
    });
    fixtures.push({ close: () => left.close() });
    fixtures.push({ close: () => right.close() });
    return { a, b, left, right };
  }

  test('8 MiB HTTP-style body arrives in order; mux window throttles instead of truncating', async () => {
    const { left, right, a, b } = setup();
    const [sigA, sigB] = loopbackSignaling();
    const [la, lb] = await Promise.all([
      left.connectToPeer(b.nodeId, sigA),
      right.connectToPeer(a.nodeId, sigB),
    ]);
    expect(la.link.channel.maxMessageSize()).toBeGreaterThanOrEqual(DC_MAX_MESSAGE_BYTES);

    const muxA = new LinkMux(la.link, { role: la.role });
    const muxB = new LinkMux(lb.link, { role: lb.role });
    const incomingP = new Promise<import('@tmex/shared/link').LinkStream>((resolve) =>
      muxB.onStream(resolve)
    );
    const open = new TextEncoder().encode('{"type":"http"}');
    const out = await muxA.openStream(open);
    const inn = await incomingP;
    expect(inn.openPayload).toEqual(open);

    const reader = inn.readable.getReader();
    const head = new TextEncoder().encode(
      '{"status":200,"headers":{"content-type":"application/octet-stream"}}'
    );
    await out.write(head, { head: true });
    const headChunk = await reader.read();
    expect(headChunk.value?.head).toBe(true);
    expect(headChunk.value?.bytes).toEqual(head);

    const body = fillPattern(new Uint8Array(EIGHT_MIB));
    let writeDone = false;
    let writeErr: unknown = null;
    const writeP = (async () => {
      for (const chunk of bunLikeChunks(body)) {
        await out.write(chunk);
      }
      await out.end();
      writeDone = true;
    })().catch((err) => {
      writeErr = err;
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(writeDone).toBe(false);
    expect(writeErr).toBeNull();

    const got: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) got.push(value.bytes);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await writeP;
    expect(writeErr).toBeNull();
    expect(writeDone).toBe(true);
    const received = concatChunks(got);
    expect(received.byteLength).toBe(EIGHT_MIB);
    expect(received).toEqual(body);

    inn.end();
    la.pc.close();
    lb.pc.close();
  });

  test('8 MiB with a keeping-up consumer (full 1 MiB mux frames) is not truncated', async () => {
    const { left, right, a, b } = setup();
    const [sigA, sigB] = loopbackSignaling();
    const [la, lb] = await Promise.all([
      left.connectToPeer(b.nodeId, sigA),
      right.connectToPeer(a.nodeId, sigB),
    ]);
    const muxA = new LinkMux(la.link, { role: la.role });
    const muxB = new LinkMux(lb.link, { role: lb.role });
    const incomingP = new Promise<import('@tmex/shared/link').LinkStream>((resolve) =>
      muxB.onStream(resolve)
    );
    const out = await muxA.openStream(new TextEncoder().encode('{"type":"http"}'));
    const inn = await incomingP;
    const reader = inn.readable.getReader();
    const head = new TextEncoder().encode('{"status":200}');
    await out.write(head, { head: true });
    expect((await reader.read()).value?.head).toBe(true);

    const body = fillPattern(new Uint8Array(EIGHT_MIB));
    const got: Uint8Array[] = [];
    const readP = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) got.push(value.bytes);
      }
    })();
    for (const chunk of bunLikeChunks(body)) {
      await out.write(chunk);
    }
    await out.end();
    await readP;
    const received = concatChunks(got);
    expect(received.byteLength).toBe(EIGHT_MIB);
    expect(received).toEqual(body);
    inn.end();
    la.pc.close();
    lb.pc.close();
  });

  test('openHttpStream errors the HTTP body when the DC dies mid-body (not a silent short 200)', async () => {
    const { left, right, a, b } = setup();
    const [sigA, sigB] = loopbackSignaling();
    const [la, lb] = await Promise.all([
      left.connectToPeer(b.nodeId, sigA),
      right.connectToPeer(a.nodeId, sigB),
    ]);
    const muxA = new LinkMux(la.link, { role: la.role });
    const muxB = new LinkMux(lb.link, { role: lb.role });
    const peerReady = Promise.withResolvers<import('@tmex/shared/link').LinkStream>();
    muxB.onStream(async (stream) => {
      const head = new TextEncoder().encode(
        `{"status":200,"headers":{"content-type":"application/octet-stream","content-length":"${EIGHT_MIB}"}}`
      );
      await stream.write(head, { head: true });
      await stream.write(fillPattern(new Uint8Array(64 * 1024)));
      peerReady.resolve(stream);
    });
    const res = await openHttpStream(muxA, {
      type: 'http',
      method: 'GET',
      path: '/api/files/raw',
      origin: 'http://entry',
      auth: null,
    });
    expect(res.status).toBe(200);
    const body = res.body;
    expect(body).toBeDefined();
    if (!body) throw new Error('missing response body');
    const reader = body.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect((first.value?.byteLength ?? 0) > 0).toBe(true);

    const peer = await peerReady.promise;
    const rest = (async () => {
      let received = first.value?.byteLength ?? 0;
      while (true) {
        const next = await reader.read();
        if (next.done) return { received, done: true as const };
        received += next.value?.byteLength ?? 0;
      }
    })();
    la.link.close('channel-closed');
    peer.reset('channel-closed');
    let outcome: { received: number; done: true } | { error: unknown };
    try {
      outcome = await rest;
    } catch (err) {
      outcome = { error: err };
    }
    expect('error' in outcome).toBe(true);
    if (!('error' in outcome)) {
      expect(outcome.received).toBeLessThan(EIGHT_MIB);
    }

    lb.pc.close();
  });

  test('a stalled/closed DC stream errors the readable instead of a silent EOF', async () => {
    const { left, right, a, b } = setup();
    const [sigA, sigB] = loopbackSignaling();
    const [la, lb] = await Promise.all([
      left.connectToPeer(b.nodeId, sigA),
      right.connectToPeer(a.nodeId, sigB),
    ]);
    const muxA = new LinkMux(la.link, { role: la.role });
    const muxB = new LinkMux(lb.link, { role: lb.role });
    const incomingP = new Promise<import('@tmex/shared/link').LinkStream>((resolve) =>
      muxB.onStream(resolve)
    );
    const out = await muxA.openStream(new TextEncoder().encode('{"type":"http"}'));
    const inn = await incomingP;
    const reader = inn.readable.getReader();
    await out.write(new Uint8Array([1, 2, 3]), { head: true });
    expect((await reader.read()).value?.bytes).toEqual(new Uint8Array([1, 2, 3]));

    la.link.close('channel-closed');
    await expect(reader.read()).rejects.toBeDefined();
    const closed = await inn.closed;
    expect(closed.reason).not.toBe('end');

    lb.pc.close();
  });

  test('max mux DATA frame (1 MiB payload + header) reassembles over 64 KiB DC fragments', async () => {
    const { left, right, a, b } = setup();
    const [sigA, sigB] = loopbackSignaling();
    const [la, lb] = await Promise.all([
      left.connectToPeer(b.nodeId, sigA),
      right.connectToPeer(a.nodeId, sigB),
    ]);
    const muxA = new LinkMux(la.link, { role: la.role });
    const muxB = new LinkMux(lb.link, { role: lb.role });
    const incomingP = new Promise<import('@tmex/shared/link').LinkStream>((resolve) =>
      muxB.onStream(resolve)
    );
    const out = await muxA.openStream(new Uint8Array([1]));
    const inn = await incomingP;
    const reader = inn.readable.getReader();
    const payload = fillPattern(new Uint8Array(MAX_FRAME_PAYLOAD));
    await out.write(payload);
    // 发送端按 ≤256 KiB 切帧（避免撑爆网关 1 MiB WS 背压上限），收端按到达顺序拼回整段。
    const received = new Uint8Array(MAX_FRAME_PAYLOAD);
    let offset = 0;
    while (offset < MAX_FRAME_PAYLOAD) {
      const chunk = await reader.read();
      if (chunk.done || !chunk.value) break;
      expect(chunk.value.bytes.byteLength).toBeLessThanOrEqual(MAX_DATA_SEND_PAYLOAD);
      received.set(chunk.value.bytes, offset);
      offset += chunk.value.bytes.byteLength;
    }
    expect(offset).toBe(MAX_FRAME_PAYLOAD);
    expect(Buffer.from(received).equals(Buffer.from(payload))).toBe(true);
    expect(MAX_FRAME_PAYLOAD + FRAME_HEADER_SIZE).toBeGreaterThan(1024 * 1024);
    out.end();
    inn.end();
    la.pc.close();
    lb.pc.close();
  });

  test(
    '8 MiB over a rate-limited DC with a slow consumer completes without abort',
    async () => {
      const pair = pairRateLimitedChannels();
      fixtures.push({ close: pair.close });
      const left = new DataChannelLink(pair.a, {
        peer: 'hub',
        intervalMs: 3_000,
        timeoutMs: 10_000,
      });
      const right = new DataChannelLink(pair.b, {
        peer: 'node-a',
        intervalMs: 3_000,
        timeoutMs: 10_000,
      });
      let leftClose: string | undefined;
      let rightClose: string | undefined;
      left.onClose((reason) => {
        leftClose = reason;
      });
      right.onClose((reason) => {
        rightClose = reason;
      });
      fixtures.push({ close: () => left.close() });
      fixtures.push({ close: () => right.close() });

      const muxA = new LinkMux(left, { role: 'initiator' });
      const muxB = new LinkMux(right, { role: 'acceptor' });
      const incomingP = new Promise<import('@tmex/shared/link').LinkStream>((resolve) =>
        muxB.onStream(resolve)
      );
      const out = await muxA.openStream(new TextEncoder().encode('{"type":"http"}'));
      const inn = await incomingP;
      const reader = inn.readable.getReader();
      const head = new TextEncoder().encode(
        '{"status":200,"headers":{"content-type":"application/octet-stream"}}'
      );
      await out.write(head, { head: true });
      expect((await reader.read()).value?.head).toBe(true);

      const body = fillPattern(new Uint8Array(EIGHT_MIB));
      const expectedHash = await sha256Hex(body);
      let writeErr: unknown = null;
      let aborted = false;
      inn.onAbort(() => {
        aborted = true;
      });
      const writeP = (async () => {
        for (const chunk of bunLikeChunks(body)) {
          await out.write(chunk);
        }
        await out.end();
      })().catch((err) => {
        writeErr = err;
      });

      const got: Uint8Array[] = [];
      const readP = (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          got.push(value.bytes);
          const delayMs = Math.ceil((value.bytes.byteLength / SLOW_CONSUMER_BYTES_PER_SEC) * 1000);
          if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      })();

      await Promise.all([writeP, readP]);
      expect(writeErr).toBeNull();
      expect(aborted).toBe(false);
      await inn.end();
      expect((await inn.closed).reason).toBe('end');
      expect((await out.closed).reason).toBe('end');

      const received = concatChunks(got);
      expect(received.byteLength).toBe(EIGHT_MIB);
      expect(await sha256Hex(received)).toBe(expectedHash);

      expect(pair.b.wire.some((chunk) => muxOpFromDcChunk(chunk) === FrameOp.WINDOW)).toBe(true);
      expect(pair.a.closed).toBe(false);
      expect(pair.b.closed).toBe(false);
      expect(leftClose).toBeUndefined();
      expect(rightClose).toBeUndefined();
    },
    { timeout: 60_000 }
  );

  test(
    '8 MiB with a keeping-up consumer on a delayed DC still credits WINDOW after onMessage',
    async () => {
      const pair = pairRateLimitedChannels(1);
      fixtures.push({ close: pair.close });
      const left = new DataChannelLink(pair.a, {
        peer: 'hub',
        intervalMs: 3_000,
        timeoutMs: 10_000,
      });
      const right = new DataChannelLink(pair.b, {
        peer: 'node-a',
        intervalMs: 3_000,
        timeoutMs: 10_000,
      });
      let leftClose: string | undefined;
      let rightClose: string | undefined;
      left.onClose((reason) => {
        leftClose = reason;
      });
      right.onClose((reason) => {
        rightClose = reason;
      });
      fixtures.push({ close: () => left.close() });
      fixtures.push({ close: () => right.close() });

      const muxA = new LinkMux(left, { role: 'initiator' });
      const muxB = new LinkMux(right, { role: 'acceptor' });
      const incomingP = new Promise<import('@tmex/shared/link').LinkStream>((resolve) =>
        muxB.onStream(resolve)
      );
      const out = await muxA.openStream(new TextEncoder().encode('{"type":"http"}'));
      const inn = await incomingP;
      const reader = inn.readable.getReader();
      const head = new TextEncoder().encode(
        '{"status":200,"headers":{"content-type":"application/octet-stream"}}'
      );
      await out.write(head, { head: true });
      expect((await reader.read()).value?.head).toBe(true);

      const body = fillPattern(new Uint8Array(EIGHT_MIB));
      const expectedHash = await sha256Hex(body);
      let writeErr: unknown = null;
      let aborted = false;
      inn.onAbort(() => {
        aborted = true;
      });
      const writeP = (async () => {
        for (const chunk of bunLikeChunks(body)) {
          await out.write(chunk);
        }
        await out.end();
      })().catch((err) => {
        writeErr = err;
      });

      const got: Uint8Array[] = [];
      const readP = (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) got.push(value.bytes);
        }
      })();

      await Promise.all([writeP, readP]);
      expect(writeErr).toBeNull();
      expect(aborted).toBe(false);
      await inn.end();
      expect((await inn.closed).reason).toBe('end');
      expect((await out.closed).reason).toBe('end');

      const received = concatChunks(got);
      expect(received.byteLength).toBe(EIGHT_MIB);
      expect(await sha256Hex(received)).toBe(expectedHash);
      expect(pair.b.wire.some((chunk) => muxOpFromDcChunk(chunk) === FrameOp.WINDOW)).toBe(true);
      expect(leftClose).toBeUndefined();
      expect(rightClose).toBeUndefined();
    },
    { timeout: 60_000 }
  );

  test(
    '8 MiB immediately after a DC re-dial completes without aborting at one mux window',
    async () => {
      const first = pairRateLimitedChannels(1);
      fixtures.push({ close: first.close });
      const left0 = new DataChannelLink(first.a, { liveness: false });
      const right0 = new DataChannelLink(first.b, { liveness: false });
      fixtures.push({ close: () => left0.close() });
      fixtures.push({ close: () => right0.close() });
      const muxA0 = new LinkMux(left0, { role: 'initiator' });
      const muxB0 = new LinkMux(right0, { role: 'acceptor' });
      const incoming0 = new Promise<import('@tmex/shared/link').LinkStream>((resolve) =>
        muxB0.onStream(resolve)
      );
      const probe = await muxA0.openStream(new TextEncoder().encode('{"type":"http"}'));
      const inn0 = await incoming0;
      await probe.write(new TextEncoder().encode('{"status":200}'), { head: true });
      const r0 = inn0.readable.getReader();
      expect((await r0.read()).value?.head).toBe(true);
      await probe.end();
      await inn0.end();
      left0.close();
      right0.close();
      first.close();

      const pair = pairRateLimitedChannels(1);
      fixtures.push({ close: pair.close });
      const left = new DataChannelLink(pair.a, {
        peer: 'hub',
        intervalMs: 3_000,
        timeoutMs: 10_000,
      });
      const right = new DataChannelLink(pair.b, {
        peer: 'node-a',
        intervalMs: 3_000,
        timeoutMs: 10_000,
      });
      let leftClose: string | undefined;
      let rightClose: string | undefined;
      left.onClose((reason) => {
        leftClose = reason;
      });
      right.onClose((reason) => {
        rightClose = reason;
      });
      fixtures.push({ close: () => left.close() });
      fixtures.push({ close: () => right.close() });

      const muxA = new LinkMux(left, { role: 'initiator' });
      const muxB = new LinkMux(right, { role: 'acceptor' });
      const incomingP = new Promise<import('@tmex/shared/link').LinkStream>((resolve) =>
        muxB.onStream(resolve)
      );
      const out = await muxA.openStream(new TextEncoder().encode('{"type":"http"}'));
      const inn = await incomingP;
      const reader = inn.readable.getReader();
      const head = new TextEncoder().encode(
        '{"status":200,"headers":{"content-type":"application/octet-stream"}}'
      );
      await out.write(head, { head: true });
      expect((await reader.read()).value?.head).toBe(true);

      const body = fillPattern(new Uint8Array(EIGHT_MIB));
      const expectedHash = await sha256Hex(body);
      let writeErr: unknown = null;
      let aborted = false;
      inn.onAbort(() => {
        aborted = true;
      });
      const writeP = (async () => {
        for (const chunk of bunLikeChunks(body)) {
          await out.write(chunk);
        }
        await out.end();
      })().catch((err) => {
        writeErr = err;
      });
      const got: Uint8Array[] = [];
      const readP = (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) got.push(value.bytes);
        }
      })();
      await Promise.all([writeP, readP]);
      expect(writeErr).toBeNull();
      expect(aborted).toBe(false);
      const received = concatChunks(got);
      expect(received.byteLength).toBe(EIGHT_MIB);
      expect(await sha256Hex(received)).toBe(expectedHash);
      expect(pair.b.wire.some((chunk) => muxOpFromDcChunk(chunk) === FrameOp.WINDOW)).toBe(true);
      expect(leftClose).toBeUndefined();
      expect(rightClose).toBeUndefined();
    },
    { timeout: 60_000 }
  );
});
