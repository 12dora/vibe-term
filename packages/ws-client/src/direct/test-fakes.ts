// 直连相关测试共用的假件（不含 `.test.ts` 后缀，`bun test` 不会把它当测试文件）。

import type { DirectCarrierLike } from '../carrier-switch';
import type { RTCDataChannelLike } from './data-channel-carrier';
import type {
  DirectApiClientLike,
  DirectSignalMessage,
  DirectSignalingTransport,
  IceCandidateLike,
  RTCPeerConnectionLike,
  SessionDescriptionLike,
  StatsReportLike,
} from './rtc-types';

export const FP_NODE_VALUE =
  '11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00';
export const FP_BROWSER_VALUE =
  'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88';

export function sdpWithFingerprint(value: string, type = 'offer'): string {
  return [
    'v=0',
    'o=- 1 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    `m=application 9 UDP/DTLS/SCTP webrtc-datachannel (${type})`,
    'a=ice-ufrag:test',
    `a=fingerprint:sha-256 ${value}`,
    'a=mid:0',
  ].join('\r\n');
}

export class FakeDataChannel implements RTCDataChannelLike {
  readyState = 'connecting';
  binaryType = 'blob';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event?: unknown) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  onbufferedamountlow: ((event?: unknown) => void) | null = null;

  readonly sent: Uint8Array[] = [];
  throwOnSend = false;
  /** 第 N 条（0 起）及之后的 `send` 抛错，用于构造「整帧发到一半失败」。 */
  throwOnSendAfter: number | null = null;
  closeCount = 0;

  send(data: ArrayBufferView | ArrayBuffer | string): void {
    if (this.throwOnSend) throw new Error('send failed');
    if (this.throwOnSendAfter !== null && this.sent.length >= this.throwOnSendAfter) {
      throw new Error('send failed');
    }
    if (typeof data === 'string') {
      this.sent.push(new TextEncoder().encode(data));
      return;
    }
    const view = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    this.sent.push(view.slice());
  }

  close(): void {
    this.closeCount += 1;
    this.readyState = 'closed';
  }

  open(): void {
    this.readyState = 'open';
    this.onopen?.();
  }

  deliver(bytes: Uint8Array): void {
    this.onmessage?.({ data: bytes.slice().buffer });
  }

  simulateClose(): void {
    this.readyState = 'closed';
    this.onclose?.();
  }

  drain(): void {
    this.bufferedAmount = 0;
    this.onbufferedamountlow?.();
  }

  /** 首帧 nonce（裸 JSON，未分片）。 */
  firstMessageJson(): { nonce?: unknown } | null {
    const first = this.sent[0];
    if (!first) return null;
    try {
      return JSON.parse(new TextDecoder().decode(first)) as { nonce?: unknown };
    } catch {
      return null;
    }
  }
}

export class FakePeerConnection implements RTCPeerConnectionLike {
  localDescription: SessionDescriptionLike | null = null;
  remoteDescription: SessionDescriptionLike | null = null;
  connectionState = 'new';
  iceConnectionState = 'new';
  onicecandidate: ((event: { candidate: IceCandidateLike | null }) => void) | null = null;
  onconnectionstatechange: ((event?: unknown) => void) | null = null;
  oniceconnectionstatechange: ((event?: unknown) => void) | null = null;

  readonly channels: FakeDataChannel[] = [];
  readonly addedCandidates: IceCandidateLike[] = [];
  closeCount = 0;
  stats: StatsReportLike = { forEach: () => {} };
  localFingerprint = FP_BROWSER_VALUE;

  createDataChannel(label: string, _init?: { ordered?: boolean }): RTCDataChannelLike {
    const channel = new FakeDataChannel();
    Object.defineProperty(channel, 'label', { value: label });
    this.channels.push(channel);
    return channel;
  }

  async createOffer(): Promise<{ type: string; sdp?: string }> {
    return { type: 'offer', sdp: sdpWithFingerprint(this.localFingerprint, 'offer') };
  }

  async setLocalDescription(description?: unknown): Promise<void> {
    const desc = description as SessionDescriptionLike | undefined;
    this.localDescription = {
      type: desc?.type ?? 'offer',
      sdp: desc?.sdp ?? sdpWithFingerprint(this.localFingerprint, 'offer'),
    };
  }

  async setRemoteDescription(description: SessionDescriptionLike): Promise<void> {
    this.remoteDescription = description;
  }

  async addIceCandidate(candidate: IceCandidateLike): Promise<void> {
    this.addedCandidates.push(candidate);
  }

  async getStats(): Promise<StatsReportLike> {
    return this.stats;
  }

  close(): void {
    this.closeCount += 1;
    this.connectionState = 'closed';
  }

  get channel(): FakeDataChannel {
    const first = this.channels[0];
    if (!first) throw new Error('no data channel created');
    return first;
  }

  emitCandidate(candidate: string, sdpMid: string | null = '0'): void {
    this.onicecandidate?.({ candidate: { candidate, sdpMid } });
  }

  setConnectionState(state: string): void {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }

  setIceConnectionState(state: string): void {
    this.iceConnectionState = state;
    this.oniceconnectionstatechange?.();
  }
}

/** stats 报告构造：`RTCStatsReport` 只需 `forEach`。 */
export function statsReport(entries: Array<Record<string, unknown>>): StatsReportLike {
  return {
    forEach(cb) {
      for (const entry of entries) cb(entry);
    },
  };
}

export class FakeSignaling implements DirectSignalingTransport {
  readonly sent: DirectSignalMessage[] = [];
  private readonly handlers = new Set<(signal: DirectSignalMessage) => void>();
  private readonly readyHandlers = new Set<(ready: boolean) => void>();
  private ready = true;
  /** 是否暴露 `isReady` / `onReady`（模拟不带就绪状态的老实现）。 */
  exposeReadiness = true;

  send(signal: DirectSignalMessage): boolean {
    if (!this.ready) return false;
    this.sent.push(signal);
    return true;
  }

  onSignal(cb: (signal: DirectSignalMessage) => void): () => void {
    this.handlers.add(cb);
    return () => {
      this.handlers.delete(cb);
    };
  }

  isReady(): boolean {
    return this.exposeReadiness ? this.ready : true;
  }

  onReady(cb: (ready: boolean) => void): () => void {
    if (!this.exposeReadiness) return () => {};
    this.readyHandlers.add(cb);
    return () => {
      this.readyHandlers.delete(cb);
    };
  }

  /** 模拟 `/mesh/ws` 断开 / 恢复。 */
  setReady(ready: boolean): void {
    if (this.ready === ready) return;
    this.ready = ready;
    if (!this.exposeReadiness) return;
    for (const cb of [...this.readyHandlers]) cb(ready);
  }

  get candidates(): DirectSignalMessage[] {
    return this.sent.filter((signal) => signal.candidate !== null);
  }

  get handlerCount(): number {
    return this.handlers.size;
  }

  deliver(signal: DirectSignalMessage): void {
    for (const handler of [...this.handlers]) handler(signal);
  }

  lastSdp(): string | null {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      const sdp = this.sent[i]?.sdp;
      if (sdp) return sdp;
    }
    return null;
  }
}

export interface FakeApiRoute {
  status?: number;
  body?: unknown;
}

export class FakeApiClient implements DirectApiClientLike {
  readonly calls: Array<{ path: string; body: unknown }> = [];
  readonly routes = new Map<string, FakeApiRoute>();

  constructor(routes: Record<string, FakeApiRoute> = {}) {
    for (const [path, route] of Object.entries(routes)) this.routes.set(path, route);
  }

  fetch(path: string, init?: RequestInit): Promise<Response> {
    let body: unknown = null;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body) as unknown;
      } catch {
        body = init.body;
      }
    }
    this.calls.push({ path, body });
    const route = this.routes.get(path) ?? { status: 404, body: { error: 'not_found' } };
    const status = route.status ?? 200;
    return Promise.resolve(
      new Response(JSON.stringify(route.body ?? {}), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  }
}

/**
 * 屏障的替身：`attachDirectCarrier` 之后**不会**自动切换，必须显式
 * `switchTo('direct')`（等价于屏障处理完 `CARRIER_SWITCH` 并回了 ACK）。
 */
export class FakeConnection {
  readonly attached: DirectCarrierLike[] = [];
  /** 每次挂载登记的 attempt rtcSession（与 `attached` 同序）。 */
  readonly attachedSessions: Array<string | undefined> = [];
  detachCount = 0;
  active: 'primary' | 'direct' = 'primary';
  private readonly carrierHandlers = new Set<(active: 'primary' | 'direct') => void>();

  attachDirectCarrier(carrier: DirectCarrierLike, options?: { rtcSession?: string }): void {
    this.attached.push(carrier);
    this.attachedSessions.push(options?.rtcSession);
  }

  detachDirectCarrier(): void {
    this.detachCount += 1;
    this.switchTo('primary');
  }

  onCarrierChange(handler: (active: 'primary' | 'direct') => void): () => void {
    this.carrierHandlers.add(handler);
    return () => {
      this.carrierHandlers.delete(handler);
    };
  }

  switchTo(active: 'primary' | 'direct'): void {
    if (this.active === active) return;
    this.active = active;
    for (const handler of [...this.carrierHandlers]) handler(active);
  }
}

/** 手工驱动的定时器：控制器的退避 / 超时全部走它。 */
export class ManualClock {
  private seq = 1;
  private readonly timers = new Map<number, { fn: () => void; at: number }>();
  now = 0;

  readonly setTimeoutFn = (fn: () => void, ms: number): unknown => {
    const id = this.seq++;
    this.timers.set(id, { fn, at: this.now + ms });
    return id;
  };

  readonly clearTimeoutFn = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  get pendingDelays(): number[] {
    return [...this.timers.values()].map((t) => t.at - this.now);
  }

  advance(ms: number): void {
    this.now += ms;
    for (const [id, timer] of [...this.timers]) {
      if (timer.at <= this.now) {
        this.timers.delete(id);
        timer.fn();
      }
    }
  }
}

/**
 * 让已排队的微任务与宏任务跑完。`Response.json()` 会跨若干个 tick，
 * 光排微任务不够，这里用真实 `setTimeout(0)` 让出事件循环。
 */
export function flush(times = 3): Promise<void> {
  let chain = Promise.resolve();
  for (let i = 0; i < times; i++) {
    chain = chain.then(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  }
  return chain;
}
