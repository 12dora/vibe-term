// 浏览器 ↔ 目标 node 的直连控制器（设计 §3「直连授权」/「载体切换屏障」、§4「连接层」）。
//
// 生命周期（浏览器恒为 offerer）：
//   1. `GET /api/mesh/rtc-config` 取 ICE 配置
//   2. 建 `RTCPeerConnection`，开 `sess` 通道（ordered + reliable）
//   3. `createOffer()` + `setLocalDescription()`，从 `localDescription.sdp` 解出 `fp_browser`
//   4. `POST /api/rtc/authorize {rtcSession, fp_browser}` → `{nonce, fp_node}`
//   5. 经注入的信令通道发 offer 与 ICE 候选；收到 answer 后**核对远端 SDP 指纹 == fp_node**，
//      不一致立即放弃（这是挡失陷 hub 做 DTLS 中间人的那道绑定，绝不重试）
//   6. 通道 open → 直接在通道上写一条**未分片**的 JSON `{"nonce":"..."}`（node 侧
//      `RtcPeerManager.acceptBrowser` 在挂载载体前先读走这一条裸消息）
//   7. 用该通道建 `DirectDataChannelCarrier`，交给连接的切换屏障
//
// 失败重试：1 s 起指数退避、上限 30 s、最多 5 次，之后停在 `failed` 直到 `retry()` 或
// `online` 事件。指纹不匹配、鉴权被拒（4xx）不重试。

import type { DirectCarrierLike } from '../carrier-switch';
import { DirectDataChannelCarrier, type RTCDataChannelLike } from './data-channel-carrier';
import { fingerprintsEqual, parseSdpFingerprint } from './fingerprint';
import {
  type DirectRoute,
  type SelectedPairStats,
  deriveRoute,
  describePair,
  readSelectedPair,
} from './ice-stats';
import type {
  DirectApiClientLike,
  DirectSignalMessage,
  DirectSignalingTransport,
  IceServerLike,
  RTCPeerConnectionLike,
  RtcAuthorizeResponse,
  RtcConfigResponse,
  RtcPeerConnectionFactory,
} from './rtc-types';
import {
  type DirectDiagnostics,
  type DirectDiagnosticsSource,
  type DirectIceDiagnostics,
  PRIMARY_ONLY_DIAGNOSTICS,
} from './types';

export type DirectCarrierState = 'idle' | 'connecting' | 'active' | 'failed';

export const SESS_CHANNEL_LABEL = 'sess';
export const RTC_CONFIG_PATH = '/api/mesh/rtc-config';
export const RTC_AUTHORIZE_PATH = '/api/rtc/authorize';

export const DEFAULT_RETRY_BASE_MS = 1000;
export const DEFAULT_RETRY_MAX_MS = 30_000;
export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
export const DEFAULT_STATS_INTERVAL_MS = 2000;

/** 控制器只用到连接的这两个方法，避免与 `GatewayConnection` 循环依赖。 */
export interface GatewayConnectionLike {
  attachDirectCarrier(carrier: DirectCarrierLike): void;
  detachDirectCarrier?(): void;
}

export interface DirectCarrierControllerOptions {
  /** 目标 node id（`self` 永远不建直连，由调用方保证）。 */
  nodeId: string;
  /** 已带 `/n/<nodeId>` 前缀的 REST 客户端。 */
  apiClient: DirectApiClientLike;
  signaling: DirectSignalingTransport;
  connection: GatewayConnectionLike;
  /** 缺省 `new RTCPeerConnection(config)`。 */
  rtcFactory?: RtcPeerConnectionFactory;
  /** 缺省随机生成；node 侧按此串登记授权。 */
  rtcSession?: string;
  retryBaseMs?: number;
  retryMaxMs?: number;
  maxAttempts?: number;
  connectTimeoutMs?: number;
  statsIntervalMs?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  /** 网络变化事件源，缺省 `globalThis`（监听 `online`）。 */
  networkEvents?: {
    addEventListener(type: string, cb: () => void): void;
    removeEventListener(type: string, cb: () => void): void;
  };
  onStateChange?: (state: DirectCarrierState, reason: string | null) => void;
}

interface Attempt {
  pc: RTCPeerConnectionLike;
  channel: RTCDataChannelLike;
  carrier: DirectDataChannelCarrier | null;
  unsubscribeSignal: () => void;
  timeoutHandle: unknown;
  cancelled: boolean;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return typeof value === 'string' && value ? [value] : [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

/** `{stun, turn}` → `RTCConfiguration.iceServers`（turn 允许 string / {url|urls,…} / 数组）。 */
export function buildIceServers(config: RtcConfigResponse | null): IceServerLike[] {
  const servers: IceServerLike[] = [];
  for (const url of toStringArray(config?.stun)) servers.push({ urls: url });
  const turn = config?.turn;
  const entries = Array.isArray(turn) ? turn : turn == null ? [] : [turn];
  for (const entry of entries) {
    if (typeof entry === 'string') {
      if (entry) servers.push({ urls: entry });
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    const urls = toStringArray(rec.urls ?? rec.url);
    if (urls.length === 0) continue;
    const server: IceServerLike = { urls: urls.length === 1 ? (urls[0] as string) : urls };
    if (typeof rec.username === 'string') server.username = rec.username;
    if (typeof rec.credential === 'string') server.credential = rec.credential;
    servers.push(server);
  }
  return servers;
}

function randomSessionId(): string {
  const bytes = new Uint8Array(16);
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoObj?.getRandomValues) {
    cryptoObj.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return `br:${hex}`;
}

function defaultRtcFactory(config: { iceServers: IceServerLike[] }): RTCPeerConnectionLike {
  const ctor = (globalThis as { RTCPeerConnection?: new (cfg: unknown) => unknown })
    .RTCPeerConnection;
  if (!ctor) throw new Error('RTCPeerConnection unavailable');
  return new ctor(config) as unknown as RTCPeerConnectionLike;
}

export class DirectCarrierController {
  readonly nodeId: string;
  readonly rtcSession: string;

  private readonly options: DirectCarrierControllerOptions;
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private readonly cancelTimer: (handle: unknown) => void;

  private state: DirectCarrierState = 'idle';
  private failureReason: string | null = null;
  private attempt: Attempt | null = null;
  private attempts = 0;
  private retryHandle: unknown = null;
  private statsHandle: unknown = null;
  private started = false;
  private onlineHandler: (() => void) | null = null;

  private route: DirectRoute | null = null;
  private rttMs: number | null = null;
  private ice: DirectIceDiagnostics | null = null;
  private snapshot: DirectDiagnostics = PRIMARY_ONLY_DIAGNOSTICS;
  private readonly listeners = new Set<() => void>();

  constructor(options: DirectCarrierControllerOptions) {
    this.options = options;
    this.nodeId = options.nodeId;
    this.rtcSession = options.rtcSession ?? randomSessionId();
    this.schedule =
      options.setTimeoutFn ?? ((fn, ms) => (globalThis as typeof global).setTimeout(fn, ms));
    this.cancelTimer =
      options.clearTimeoutFn ??
      ((handle) => (globalThis as typeof global).clearTimeout(handle as never));
  }

  // ========== 对外只读状态 ==========

  getState(): DirectCarrierState {
    return this.state;
  }

  /** 由 `getStats()` 推出的网络路径；未建立直连时为 `null`。 */
  get path(): DirectRoute | null {
    return this.state === 'active' ? this.route : null;
  }

  get rtt(): number | null {
    return this.rttMs;
  }

  /** 最近一次失败原因（诊断用）。 */
  get reason(): string | null {
    return this.failureReason;
  }

  diagnostics(): DirectDiagnostics {
    return this.snapshot;
  }

  /** 供 `useSyncExternalStore` 消费；快照引用只在内容变化时更新。 */
  readonly diagnosticsSource: DirectDiagnosticsSource = {
    get: () => this.snapshot,
    subscribe: (listener: () => void) => {
      this.listeners.add(listener);
      return () => {
        this.listeners.delete(listener);
      };
    },
  };

  // ========== 生命周期 ==========

  start(): void {
    if (this.started) return;
    this.started = true;
    this.attempts = 0;
    this.installNetworkListener();
    this.connect();
  }

  /** 重置退避计数并立即重连（UI 的「重试直连」按钮 / `online` 事件）。 */
  retry(): void {
    if (!this.started) {
      this.start();
      return;
    }
    this.attempts = 0;
    this.clearRetryTimer();
    this.teardownAttempt('retry');
    this.connect();
  }

  stop(): void {
    this.started = false;
    this.clearRetryTimer();
    this.stopStatsPolling();
    this.removeNetworkListener();
    this.teardownAttempt('stopped');
    this.setState('idle', null);
  }

  // ========== 连接流程 ==========

  private connect(): void {
    if (!this.started) return;
    if (this.attempt) return;
    this.setState('connecting', null);
    void this.runAttempt().catch((err) => {
      const fatal = err instanceof DirectAuthorizeError && err.fatal;
      this.failAttempt(err instanceof Error ? err.message : String(err), !fatal);
    });
  }

  private async runAttempt(): Promise<void> {
    const config = await this.fetchRtcConfig();
    if (!this.started) return;

    const factory = this.options.rtcFactory ?? defaultRtcFactory;
    const pc = factory({ iceServers: buildIceServers(config) });
    const channel = pc.createDataChannel(SESS_CHANNEL_LABEL, { ordered: true });

    const attempt: Attempt = {
      pc,
      channel,
      carrier: null,
      unsubscribeSignal: () => {},
      timeoutHandle: null,
      cancelled: false,
    };
    this.attempt = attempt;

    attempt.timeoutHandle = this.schedule(() => {
      if (this.attempt === attempt && this.state !== 'active') {
        this.failAttempt('direct connect timeout', true);
      }
    }, this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);

    pc.onicecandidate = (event) => {
      const candidate = event.candidate;
      if (!candidate || !candidate.candidate) return;
      this.sendSignal({
        candidate: JSON.stringify({ candidate: candidate.candidate, mid: candidate.sdpMid ?? '0' }),
      });
    };
    pc.onconnectionstatechange = () => {
      this.refreshIceSnapshot();
      const s = pc.connectionState;
      if (s === 'failed' || s === 'closed') {
        if (this.attempt === attempt) this.failAttempt(`peer connection ${s}`, true);
      }
    };
    pc.oniceconnectionstatechange = () => this.refreshIceSnapshot();

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (attempt.cancelled || !this.started) return;

    const localSdp = pc.localDescription?.sdp ?? offer.sdp ?? '';
    const fpBrowser = parseSdpFingerprint(localSdp);
    if (!fpBrowser) {
      this.failAttempt('local DTLS fingerprint unavailable', true);
      return;
    }

    const granted = await this.authorize(fpBrowser);
    if (attempt.cancelled || !this.started) return;

    attempt.unsubscribeSignal = this.options.signaling.onSignal((signal) => {
      void this.handleSignal(attempt, granted.fpNode, signal);
    });

    this.sendSignal({ sdp: JSON.stringify({ type: offer.type, sdp: localSdp }) });

    channel.onopen = () => {
      if (attempt.cancelled || this.attempt !== attempt) return;
      this.activate(attempt, granted.nonce);
    };
    channel.onclose = () => {
      if (this.attempt !== attempt) return;
      this.handleCarrierGone('direct channel closed');
    };
    if (channel.readyState === 'open') this.activate(attempt, granted.nonce);
  }

  private async fetchRtcConfig(): Promise<RtcConfigResponse | null> {
    try {
      const res = await this.options.apiClient.fetch(RTC_CONFIG_PATH);
      if (!res.ok) return null;
      return (await res.json()) as RtcConfigResponse;
    } catch {
      // ICE 配置拿不到时仍尝试建连（同内网 host 候选不需要 STUN）
      return null;
    }
  }

  private async authorize(fpBrowser: {
    algorithm: string;
    value: string;
  }): Promise<{ nonce: string; fpNode: { algorithm: string; value: string } }> {
    const res = await this.options.apiClient.fetch(RTC_AUTHORIZE_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rtcSession: this.rtcSession, fp_browser: fpBrowser }),
    });
    if (!res.ok) {
      // 4xx 是配置/权限问题，重试没有意义；5xx（如 DIRECT_UNAVAILABLE）才退避重试。
      throw new DirectAuthorizeError(`authorize failed (${res.status})`, res.status < 500);
    }
    const body = (await res.json()) as RtcAuthorizeResponse;
    const fp = body.fp_node as { algorithm?: unknown; value?: unknown } | undefined;
    if (
      typeof body.nonce !== 'string' ||
      !fp ||
      typeof fp.algorithm !== 'string' ||
      typeof fp.value !== 'string'
    ) {
      throw new DirectAuthorizeError('authorize response malformed', true);
    }
    return { nonce: body.nonce, fpNode: { algorithm: fp.algorithm, value: fp.value } };
  }

  private async handleSignal(
    attempt: Attempt,
    fpNode: { algorithm: string; value: string },
    signal: DirectSignalMessage
  ): Promise<void> {
    if (attempt.cancelled || this.attempt !== attempt) return;
    if (signal.rtcSession !== this.rtcSession || signal.from !== 'node') return;
    try {
      if (signal.sdp) {
        const parsed = JSON.parse(signal.sdp) as { type?: unknown; sdp?: unknown };
        if (typeof parsed.sdp !== 'string') return;
        const type = typeof parsed.type === 'string' ? parsed.type : 'answer';
        // 指纹绑定：先核对再 setRemoteDescription，不一致就不让 DTLS 起来。
        const fpRemote = parseSdpFingerprint(parsed.sdp);
        if (!fingerprintsEqual(fpRemote, fpNode)) {
          this.failAttempt('node DTLS fingerprint mismatch', false);
          return;
        }
        await attempt.pc.setRemoteDescription({ type, sdp: parsed.sdp });
        return;
      }
      if (signal.candidate) {
        const parsed = JSON.parse(signal.candidate) as { candidate?: unknown; mid?: unknown };
        if (typeof parsed.candidate !== 'string' || !parsed.candidate) return;
        await attempt.pc.addIceCandidate({
          candidate: parsed.candidate,
          sdpMid: typeof parsed.mid === 'string' ? parsed.mid : '0',
        });
      }
    } catch {
      // 单条畸形信令不该拖垮整次尝试；超时兜底会收敛。
    }
  }

  private activate(attempt: Attempt, nonce: string): void {
    if (attempt.carrier) return;
    // 首帧 nonce 必须是**裸的**未分片 JSON：node 在挂载载体前先读走这一条。
    try {
      attempt.channel.send(new TextEncoder().encode(JSON.stringify({ nonce })));
    } catch (err) {
      this.failAttempt(err instanceof Error ? err.message : 'nonce send failed', true);
      return;
    }
    const carrier = new DirectDataChannelCarrier(attempt.channel);
    attempt.carrier = carrier;
    carrier.onClose(() => {
      if (this.attempt !== attempt) return;
      this.handleCarrierGone('direct channel closed');
    });
    this.options.connection.attachDirectCarrier(carrier);
    this.attempts = 0;
    this.clearAttemptTimeout(attempt);
    this.setState('active', null);
    this.startStatsPolling();
  }

  // ========== 失败与退避 ==========

  private failAttempt(reason: string, retryable: boolean): void {
    this.teardownAttempt(reason);
    this.stopStatsPolling();
    this.route = null;
    this.rttMs = null;
    this.setState('failed', reason);
    if (!retryable || !this.started) return;
    this.scheduleRetry();
  }

  /** 直连载体没了（通道关闭 / primary 断开导致屏障关掉直连）：退避重连。 */
  private handleCarrierGone(reason: string): void {
    this.teardownAttempt(reason);
    this.stopStatsPolling();
    this.route = null;
    this.rttMs = null;
    this.setState('failed', reason);
    if (this.started) this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.retryHandle != null) return;
    const maxAttempts = this.options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    if (this.attempts >= maxAttempts) return; // 停在 failed，等 retry() / online
    const base = this.options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    const max = this.options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
    const delay = Math.min(max, base * 2 ** this.attempts);
    this.attempts += 1;
    this.retryHandle = this.schedule(() => {
      this.retryHandle = null;
      if (!this.started) return;
      this.connect();
    }, delay);
  }

  /** 第 `attempt` 次重试（从 0 起）的等待时长；供测试与诊断。 */
  retryDelay(attempt: number): number {
    const base = this.options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    const max = this.options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
    return Math.min(max, base * 2 ** Math.max(0, attempt));
  }

  private clearRetryTimer(): void {
    if (this.retryHandle == null) return;
    this.cancelTimer(this.retryHandle);
    this.retryHandle = null;
  }

  private clearAttemptTimeout(attempt: Attempt): void {
    if (attempt.timeoutHandle == null) return;
    this.cancelTimer(attempt.timeoutHandle);
    attempt.timeoutHandle = null;
  }

  private teardownAttempt(_reason: string): void {
    const attempt = this.attempt;
    if (!attempt) return;
    this.attempt = null;
    attempt.cancelled = true;
    this.clearAttemptTimeout(attempt);
    try {
      attempt.unsubscribeSignal();
    } catch {
      // 信令已注销
    }
    attempt.channel.onopen = null;
    attempt.channel.onclose = null;
    attempt.pc.onicecandidate = null;
    attempt.pc.onconnectionstatechange = null;
    attempt.pc.oniceconnectionstatechange = null;
    try {
      attempt.carrier?.close();
    } catch {
      // 已关闭
    }
    try {
      attempt.pc.close();
    } catch {
      // 已关闭
    }
    this.options.connection.detachDirectCarrier?.();
  }

  // ========== 诊断 ==========

  private startStatsPolling(): void {
    this.stopStatsPolling();
    const interval = this.options.statsIntervalMs ?? DEFAULT_STATS_INTERVAL_MS;
    const tick = () => {
      this.statsHandle = null;
      if (this.state !== 'active' || !this.attempt) return;
      void this.pollStats().finally(() => {
        if (this.state === 'active' && this.attempt) {
          this.statsHandle = this.schedule(tick, interval);
        }
      });
    };
    void this.pollStats();
    this.statsHandle = this.schedule(tick, interval);
  }

  private stopStatsPolling(): void {
    if (this.statsHandle == null) return;
    this.cancelTimer(this.statsHandle);
    this.statsHandle = null;
  }

  /** 立即抓一次 stats（测试用；正常由轮询驱动）。 */
  async pollStats(): Promise<void> {
    const attempt = this.attempt;
    if (!attempt) return;
    let pair: SelectedPairStats | null = null;
    try {
      pair = readSelectedPair(await attempt.pc.getStats());
    } catch {
      pair = null;
    }
    if (this.attempt !== attempt) return;
    this.route = deriveRoute(pair);
    this.rttMs = pair?.rttMs ?? null;
    this.ice = {
      connectionState: attempt.pc.connectionState || null,
      iceConnectionState: attempt.pc.iceConnectionState || null,
      localCandidateType: pair?.localCandidateType ?? null,
      remoteCandidateType: pair?.remoteCandidateType ?? null,
      selectedPair: describePair(pair),
    };
    this.publish();
  }

  private refreshIceSnapshot(): void {
    const attempt = this.attempt;
    if (!attempt) return;
    this.ice = {
      connectionState: attempt.pc.connectionState || null,
      iceConnectionState: attempt.pc.iceConnectionState || null,
      localCandidateType: this.ice?.localCandidateType ?? null,
      remoteCandidateType: this.ice?.remoteCandidateType ?? null,
      selectedPair: this.ice?.selectedPair ?? null,
    };
    this.publish();
  }

  private publish(): void {
    const next: DirectDiagnostics = {
      path: this.state === 'active' ? 'direct' : 'primary',
      rtt: this.state === 'active' ? this.rttMs : null,
      ice: this.state === 'active' || this.state === 'connecting' ? this.ice : null,
    };
    const prev = this.snapshot;
    if (
      prev.path === next.path &&
      prev.rtt === next.rtt &&
      sameIce(prev.ice ?? null, next.ice ?? null)
    ) {
      return;
    }
    this.snapshot = next;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // 订阅者异常不得影响其他订阅者
      }
    }
  }

  // ========== 状态与网络事件 ==========

  private setState(state: DirectCarrierState, reason: string | null): void {
    if (this.state === state && this.failureReason === reason) return;
    this.state = state;
    this.failureReason = reason;
    if (state !== 'active') {
      this.route = null;
      if (state !== 'connecting') this.ice = null;
    }
    this.publish();
    this.options.onStateChange?.(state, reason);
  }

  private sendSignal(part: { sdp?: string; candidate?: string }): void {
    try {
      this.options.signaling.send({
        rtcSession: this.rtcSession,
        from: 'browser',
        to: this.nodeId,
        sdp: part.sdp ?? null,
        candidate: part.candidate ?? null,
      });
    } catch {
      // 信令通道断开时丢弃；重连后由新一次尝试重来
    }
  }

  private installNetworkListener(): void {
    if (this.onlineHandler) return;
    const target =
      this.options.networkEvents ??
      (globalThis as unknown as DirectCarrierControllerOptions['networkEvents']);
    if (!target?.addEventListener) return;
    const handler = () => {
      if (!this.started) return;
      this.retry();
    };
    target.addEventListener('online', handler);
    this.onlineHandler = handler;
  }

  private removeNetworkListener(): void {
    const handler = this.onlineHandler;
    if (!handler) return;
    this.onlineHandler = null;
    const target =
      this.options.networkEvents ??
      (globalThis as unknown as DirectCarrierControllerOptions['networkEvents']);
    target?.removeEventListener?.('online', handler);
  }
}

class DirectAuthorizeError extends Error {
  constructor(
    message: string,
    readonly fatal: boolean
  ) {
    super(message);
    this.name = 'DirectAuthorizeError';
  }
}

function sameIce(a: DirectIceDiagnostics | null, b: DirectIceDiagnostics | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.connectionState === b.connectionState &&
    a.iceConnectionState === b.iceConnectionState &&
    a.localCandidateType === b.localCandidateType &&
    a.remoteCandidateType === b.remoteCandidateType &&
    a.selectedPair === b.selectedPair
  );
}
