// 浏览器 ↔ 目标 node 的直连控制器（设计 §3「直连授权」/「载体切换屏障」、§4「连接层」）。
//
// 生命周期（浏览器恒为 offerer）；**每次尝试都是一代全新的 attempt**：新的 generation、
// 新的 `rtcSession`、新的 `AbortController`、新的 `RTCPeerConnection`：
//   0. `GET /api/mesh/connection` 取本标签页 Gateway WS 的 `connectionId`（每次尝试都重取）
//   1. `GET /api/mesh/rtc-config` 取 ICE 配置
//   2. 建 `RTCPeerConnection`，开 `sess` 通道（ordered + reliable）
//   3. `createOffer()` + `setLocalDescription()`，从 `localDescription.sdp` 解出 `fp_browser`
//   4. `POST /api/rtc/authorize {rtcSession, fp_browser, connectionId}`（同时带
//      `x-tmex-connection` 头）→ `{nonce, fp_node}`；node 据 connectionId 把直连挂到
//      本标签页那条 Gateway WS 上（同 sid 多标签时不带它会 409）
//   5. 经注入的信令通道发 offer，随后才放本地 ICE 候选出去（entry 要先见到本 rtcSession
//      的 offer 才认候选）；收到 answer 后**核对远端 SDP 指纹 == fp_node**，
//      不一致立即放弃（这是挡失陷 hub 做 DTLS 中间人的那道绑定，绝不重试）
//   6. 通道 open → 直接在通道上写一条**未分片**的 JSON `{"nonce":"..."}`（node 侧
//      `RtcPeerManager.acceptBrowser` 在挂载载体前先读走这一条裸消息）
//   7. 用该通道建 `DirectDataChannelCarrier`，交给连接的切换屏障；**此时仍是 `connecting`**，
//      直到屏障处理完 `CARRIER_SWITCH{to:'direct'}` 并回了 ACK（`onCarrierChange('direct')`）
//      才置 `active`、清零重试计数、开始 stats 轮询。
//
// 关键的几条时序约束（都被 f3-1 评审点名过）：
// - attempt 在**任何 await 之前**就登记好，回调 / catch / teardown 一律先比对 generation；
//   被替换的 attempt 必定 `pc.close()`，REST 请求带 `AbortSignal`。
// - 每次尝试换新的 `rtcSession`：node 侧按它缓存 BrowserRecord / PeerConnection，
//   复用旧值会取回已关闭或 `used=true` 的记录，重连永远起不来。
// - 信令严格串行：本地候选在 offer 发出前排队，远端候选在 `setRemoteDescription` 完成前排队。
// - 信令通道（`/mesh/ws`）未就绪时不开 attempt、信令入队；恢复时重置退避并立刻重试。
//
// 失败重试：1 s 起指数退避、上限 30 s、最多 5 次，之后停在 `failed` 直到 `retry()` /
// `online` / `navigator.connection` 变化 / 信令恢复。指纹不匹配、鉴权被拒（4xx）不重试。
// `NO_CONNECTION` / `MULTIPLE_CONNECTIONS` 例外：退避解决不了，改成挂在 primary 状态上等
// 它连上 / 重连过再重来一轮，且不消耗重试次数。

import type { DirectCarrierLike } from '../carrier-switch';
import { DirectDataChannelCarrier, type RTCDataChannelLike } from './data-channel-carrier';
import { type DtlsFingerprint, fingerprintsEqual, parseSdpFingerprint } from './fingerprint';
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
  IceCandidateLike,
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
export const MESH_CONNECTION_PATH = '/api/mesh/connection';
export const X_TMEX_CONNECTION_HEADER = 'x-tmex-connection';

export const DEFAULT_RETRY_BASE_MS = 1000;
export const DEFAULT_RETRY_MAX_MS = 30_000;
export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
export const DEFAULT_STATS_INTERVAL_MS = 2000;
/** `iceConnectionState === 'disconnected'` 的宽限期：撑过短暂抖动，超时就回落 primary。 */
export const DEFAULT_ICE_DISCONNECT_GRACE_MS = 5000;
/** `navigator.connection` 的 `change` 抖动很密，去抖后再重连。 */
export const DEFAULT_NETWORK_CHANGE_DEBOUNCE_MS = 800;

/**
 * primary（Gateway WS）的状态源。`BorshWebSocketClient` 结构上即满足，
 * 宿主把整个 `GatewayConnection` 传进来时自动可用。
 *
 * 控制器只在「connectionId 取不到」时用它：node 侧的 `connectionId` 是**每条 Gateway WS**
 * 一个身份，primary 没连上（404）或同 sid 有多条（409）时，只有 primary 重新连过才可能变。
 */
export interface PrimaryStatusLike {
  isReady?(): boolean;
  onStateChange?(handler: (state: string) => void): () => void;
}

/** 控制器只用到连接的这几个成员，避免与 `GatewayConnection` 循环依赖。 */
export interface GatewayConnectionLike {
  attachDirectCarrier(carrier: DirectCarrierLike, options?: { rtcSession?: string }): void;
  detachDirectCarrier?(): void;
  /** 屏障完成切换（并已回 ACK）后才通知；控制器据此才认为直连真正生效。 */
  onCarrierChange?(handler: (active: 'primary' | 'direct') => void): () => void;
  /** primary WS 客户端；缺省时 connectionId 相关的等待退化成普通退避重试。 */
  readonly client?: PrimaryStatusLike;
}

/** 事件源的最小结构子集（`window` / `navigator.connection` 都满足）。 */
export interface EventTargetLike {
  addEventListener(type: string, cb: () => void): void;
  removeEventListener(type: string, cb: () => void): void;
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
  /**
   * 固定 rtcSession（仅测试用）。生产环境**必须**每次尝试换新值，
   * 传了这里就等于所有重试共用一个 session id。
   */
  rtcSession?: string;
  retryBaseMs?: number;
  retryMaxMs?: number;
  maxAttempts?: number;
  connectTimeoutMs?: number;
  statsIntervalMs?: number;
  iceDisconnectGraceMs?: number;
  networkChangeDebounceMs?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  /** `online` 事件源，缺省 `globalThis`。 */
  networkEvents?: EventTargetLike;
  /** Network Information API（`navigator.connection`）的 `change` 事件源；缺省自动探测。 */
  connectionEvents?: EventTargetLike | null;
  onStateChange?: (state: DirectCarrierState, reason: string | null) => void;
}

type SignalPart = { sdp?: string; candidate?: string };

interface Attempt {
  /** 单调递增的代号：所有回调都靠它判断自己是不是当代。 */
  readonly id: number;
  readonly rtcSession: string;
  readonly abort: AbortController;
  /** 本次尝试绑定的 Gateway WS 身份；老 node 没有该路由时为 `null`（退化成旧行为）。 */
  connectionId: string | null;
  pc: RTCPeerConnectionLike | null;
  channel: RTCDataChannelLike | null;
  carrier: DirectDataChannelCarrier | null;
  nonce: string | null;
  fpNode: DtlsFingerprint | null;
  unsubscribeSignal: () => void;
  timeoutHandle: unknown;
  iceGraceHandle: unknown;
  cancelled: boolean;
  /** offer 已排进 outbox：此后本地候选才能跟着排（entry 要先见到 offer）。 */
  offerQueued: boolean;
  /** `setRemoteDescription` 已完成：此前远端候选只排队。 */
  remoteReady: boolean;
  /** offer 之前就产生的本地候选。 */
  pendingLocalCandidates: SignalPart[];
  pendingRemoteCandidates: IceCandidateLike[];
  /** 出站信令队列：FIFO，送不出去就留在队头，等信令 ready 再泵。 */
  outbox: SignalPart[];
  pumping: boolean;
  /** 串行化入站信令处理（answer 与紧随其后的候选不能并发）。 */
  chain: Promise<void>;
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

function defaultConnectionEvents(): EventTargetLike | null {
  const nav = (globalThis as { navigator?: { connection?: unknown } }).navigator;
  const conn = nav?.connection as Partial<EventTargetLike> | undefined;
  if (!conn || typeof conn.addEventListener !== 'function') return null;
  return conn as EventTargetLike;
}

export class DirectCarrierController {
  readonly nodeId: string;

  private readonly options: DirectCarrierControllerOptions;
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private readonly cancelTimer: (handle: unknown) => void;

  private state: DirectCarrierState = 'idle';
  private failureReason: string | null = null;
  private attempt: Attempt | null = null;
  private generation = 0;
  private attempts = 0;
  private retryHandle: unknown = null;
  private statsHandle: unknown = null;
  private networkDebounceHandle: unknown = null;
  private started = false;
  private onlineHandler: (() => void) | null = null;
  private connectionChangeHandler: (() => void) | null = null;
  private unsubscribeSignalingReady: (() => void) | null = null;
  private unsubscribeCarrierChange: (() => void) | null = null;
  private unsubscribePrimaryWait: (() => void) | null = null;

  private route: DirectRoute | null = null;
  private rttMs: number | null = null;
  private ice: DirectIceDiagnostics | null = null;
  private snapshot: DirectDiagnostics = PRIMARY_ONLY_DIAGNOSTICS;
  private readonly listeners = new Set<() => void>();

  constructor(options: DirectCarrierControllerOptions) {
    this.options = options;
    this.nodeId = options.nodeId;
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

  /** 当前 attempt 的 rtcSession（每次尝试都会换）。 */
  get rtcSession(): string | null {
    return this.attempt?.rtcSession ?? null;
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

  /**
   * 在**已鉴权**的 PC 上再开一条通道（`bulk:<transferId>` 走这里，见 `bulk-client.ts`）。
   * 只有 `active` 才允许——鉴权与指纹绑定是在 `sess` 通道建立时完成的，未 active 时
   * PC 要么不存在要么还没通过绑定校验。
   */
  createDataChannel(label: string, init?: { ordered?: boolean }): RTCDataChannelLike {
    const pc = this.attempt?.pc;
    if (this.state !== 'active' || !pc) {
      throw new Error('direct carrier not active');
    }
    return pc.createDataChannel(label, init);
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
    this.installNetworkListeners();
    this.installSignalingReadyListener();
    this.connect();
  }

  /** 重置退避计数并立即重连（UI 的「重试直连」按钮 / 网络或信令恢复）。 */
  retry(): void {
    if (!this.started) {
      this.start();
      return;
    }
    this.attempts = 0;
    this.clearRetryTimer();
    this.clearPrimaryWait();
    this.teardownAttempt('retry');
    this.connect();
  }

  stop(): void {
    this.started = false;
    this.clearRetryTimer();
    this.clearPrimaryWait();
    this.stopStatsPolling();
    this.removeNetworkListeners();
    this.removeSignalingReadyListener();
    this.teardownAttempt('stopped');
    this.setState('idle', null);
  }

  // ========== 连接流程 ==========

  private connect(): void {
    if (!this.started) return;
    if (this.attempt) return;
    // 信令没通就别浪费一次 attempt：offer 发不出去，只会走到超时再退避。
    if (!this.signalingReady()) {
      this.setState('failed', 'signaling not ready');
      return;
    }
    this.clearPrimaryWait();
    this.setState('connecting', null);
    const attempt = this.beginAttempt();
    void this.runAttempt(attempt).catch((err) => {
      if (this.attempt !== attempt) return;
      if (err instanceof DirectPrimaryWaitError) {
        this.failWaitingPrimary(err.message, err.mode);
        return;
      }
      const fatal = err instanceof DirectAuthorizeError && err.fatal;
      this.failAttempt(err instanceof Error ? err.message : String(err), !fatal);
    });
  }

  /** 在**任何 await 之前**登记 attempt：否则并发 `retry()` 会开出两条 PeerConnection。 */
  private beginAttempt(): Attempt {
    this.generation += 1;
    const attempt: Attempt = {
      id: this.generation,
      rtcSession: this.options.rtcSession ?? randomSessionId(),
      abort: new AbortController(),
      connectionId: null,
      pc: null,
      channel: null,
      carrier: null,
      nonce: null,
      fpNode: null,
      unsubscribeSignal: () => {},
      timeoutHandle: null,
      iceGraceHandle: null,
      cancelled: false,
      offerQueued: false,
      remoteReady: false,
      pendingLocalCandidates: [],
      pendingRemoteCandidates: [],
      outbox: [],
      pumping: false,
      chain: Promise.resolve(),
    };
    this.attempt = attempt;
    attempt.timeoutHandle = this.schedule(() => {
      attempt.timeoutHandle = null;
      if (this.stale(attempt)) return;
      this.failAttempt('direct connect timeout', true);
    }, this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
    attempt.unsubscribeSignal = this.options.signaling.onSignal((signal) => {
      this.enqueueSignal(attempt, signal);
    });
    return attempt;
  }

  private stale(attempt: Attempt): boolean {
    return attempt.cancelled || this.attempt !== attempt || !this.started;
  }

  private async runAttempt(attempt: Attempt): Promise<void> {
    // 先定位本标签页的 Gateway WS：拿不到就根本不该建 PeerConnection（省一次 ICE 收集）。
    attempt.connectionId = await this.fetchConnectionId(attempt);
    if (this.stale(attempt)) return;

    const config = await this.fetchRtcConfig(attempt);
    if (this.stale(attempt)) return;

    const factory = this.options.rtcFactory ?? defaultRtcFactory;
    const pc = factory({ iceServers: buildIceServers(config) });
    if (this.stale(attempt)) {
      // 这一代已被替换：新建的 PC 必须就地关掉，否则泄漏
      closeQuietly(pc);
      return;
    }
    attempt.pc = pc;
    const channel = pc.createDataChannel(SESS_CHANNEL_LABEL, { ordered: true });
    attempt.channel = channel;

    pc.onicecandidate = (event) => {
      if (this.stale(attempt)) return;
      const candidate = event.candidate;
      if (!candidate || !candidate.candidate) return;
      const part: SignalPart = {
        candidate: JSON.stringify({ candidate: candidate.candidate, mid: candidate.sdpMid ?? '0' }),
      };
      // offer 还没排上队时先攒着：entry 要先见到本 rtcSession 的 offer 才认候选。
      if (!attempt.offerQueued) {
        attempt.pendingLocalCandidates.push(part);
        return;
      }
      this.queueSignal(attempt, part);
    };
    pc.onconnectionstatechange = () => {
      if (this.stale(attempt)) return;
      this.refreshIceSnapshot();
      const s = pc.connectionState;
      if (s === 'failed' || s === 'closed') this.failAttempt(`peer connection ${s}`, true);
    };
    pc.oniceconnectionstatechange = () => {
      if (this.stale(attempt)) return;
      this.refreshIceSnapshot();
      this.handleIceConnectionState(attempt, pc.iceConnectionState);
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (this.stale(attempt)) return;

    const localSdp = pc.localDescription?.sdp ?? offer.sdp ?? '';
    // 本地 SDP 用同一个严格解析器：`m=application` 段生效的那条 sha-256。
    const fpBrowser = parseSdpFingerprint(localSdp);
    if (!fpBrowser) {
      this.failAttempt('local DTLS fingerprint unavailable', true);
      return;
    }

    const granted = await this.authorize(attempt, fpBrowser);
    if (this.stale(attempt)) return;
    attempt.nonce = granted.nonce;
    attempt.fpNode = granted.fpNode;

    // outbox 是 FIFO：offer 先入队，之后的候选自然排在它后面，不会插队到 offer 前。
    this.queueSignal(attempt, { sdp: JSON.stringify({ type: offer.type, sdp: localSdp }) });
    attempt.offerQueued = true;
    for (const part of attempt.pendingLocalCandidates.splice(0)) this.queueSignal(attempt, part);

    channel.onopen = () => {
      if (this.stale(attempt)) return;
      this.mountCarrier(attempt);
    };
    channel.onclose = () => {
      if (this.stale(attempt)) return;
      this.handleCarrierGone('direct channel closed');
    };
    if (channel.readyState === 'open') this.mountCarrier(attempt);
  }

  private async fetchRtcConfig(attempt: Attempt): Promise<RtcConfigResponse | null> {
    try {
      const res = await this.options.apiClient.fetch(RTC_CONFIG_PATH, {
        signal: attempt.abort.signal,
      });
      if (!res.ok) return null;
      return (await res.json()) as RtcConfigResponse;
    } catch {
      // ICE 配置拿不到时仍尝试建连（同内网 host 候选不需要 STUN）
      return null;
    }
  }

  /**
   * `GET /api/mesh/connection`：取本标签页那条 Gateway WS 在目标 node 上的 `connectionId`。
   * **每次尝试都要重取**——primary 重连会换一条 WS，缓存下来的旧值会把直连挂到已死的会话上。
   *
   * 浏览器的 `WebSocket` 构造函数不能带自定义请求头，也读不到 upgrade 响应头，
   * HELLO 帧（Borsh）在 B2-10 里也明确不改，所以拿 `connectionId` 只有这一条 REST 路径。
   *
   * - `404 NO_CONNECTION`：primary 还没在 node 上登记（刚开页面 / 刚断线）→ 等 primary 连上再来。
   * - `409 MULTIPLE_CONNECTIONS`：同 sid 多条 live WS，node 无法定位到本标签页 → 这段时间
   *   直连建不了，等 primary 重连过再试（届时 sid 上的连接分布会变）。
   * - 其它非 2xx（老 node 上该路由返回 405、5xx 等）：5xx 退避重试，其余退化成不带
   *   connectionId 的旧行为——单连接时 node 侧照样能唯一定位。
   */
  private async fetchConnectionId(attempt: Attempt): Promise<string | null> {
    let res: Response;
    try {
      res = await this.options.apiClient.fetch(MESH_CONNECTION_PATH, {
        signal: attempt.abort.signal,
      });
    } catch (err) {
      if (this.stale(attempt)) return null;
      throw new DirectAuthorizeError(
        err instanceof Error
          ? `connection lookup failed: ${err.message}`
          : 'connection lookup failed',
        false
      );
    }
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as { connectionId?: unknown } | null;
      if (typeof body?.connectionId === 'string' && body.connectionId) return body.connectionId;
      throw new DirectAuthorizeError('connection lookup response malformed', true);
    }
    const code = await readErrorCode(res);
    const wait = primaryWaitFor(res.status, code);
    if (wait) throw new DirectPrimaryWaitError(`connection lookup: ${code}`, wait);
    if (res.status >= 500) {
      throw new DirectAuthorizeError(`connection lookup failed (${res.status})`, false);
    }
    return null;
  }

  private async authorize(
    attempt: Attempt,
    fpBrowser: DtlsFingerprint
  ): Promise<{ nonce: string; fpNode: DtlsFingerprint }> {
    const connectionId = attempt.connectionId;
    const res = await this.options.apiClient.fetch(RTC_AUTHORIZE_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(connectionId ? { [X_TMEX_CONNECTION_HEADER]: connectionId } : {}),
      },
      body: JSON.stringify({
        rtcSession: attempt.rtcSession,
        fp_browser: fpBrowser,
        ...(connectionId ? { connectionId } : {}),
      }),
      signal: attempt.abort.signal,
    });
    if (!res.ok) {
      // connectionId 在 GET 与 authorize 之间失效（primary 重连 / 又开了一个标签页）：
      // 这不是配置错误，按「等 primary」处理，别当成 4xx 永久失败卡死在 failed。
      const code = await readErrorCode(res);
      const wait = primaryWaitFor(res.status, code);
      if (wait) throw new DirectPrimaryWaitError(`authorize: ${code}`, wait);
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

  // ========== 信令 ==========

  private signalingReady(): boolean {
    const signaling = this.options.signaling;
    return signaling.isReady ? signaling.isReady() : true;
  }

  /** 逐条串行处理：answer 与紧随其后的候选并发时会丢候选。 */
  private enqueueSignal(attempt: Attempt, signal: DirectSignalMessage): void {
    if (this.stale(attempt)) return;
    if (signal.rtcSession !== attempt.rtcSession || signal.from !== 'node') return;
    attempt.chain = attempt.chain.then(async () => {
      if (this.stale(attempt)) return;
      try {
        await this.processSignal(attempt, signal);
      } catch {
        // 单条畸形信令不该拖垮整次尝试；超时兜底会收敛。
      }
    });
  }

  private async processSignal(attempt: Attempt, signal: DirectSignalMessage): Promise<void> {
    const pc = attempt.pc;
    if (!pc) return;
    if (signal.sdp) {
      const parsed = JSON.parse(signal.sdp) as { type?: unknown; sdp?: unknown };
      if (typeof parsed.sdp !== 'string') return;
      const type = typeof parsed.type === 'string' ? parsed.type : 'answer';
      // 指纹绑定：先核对再 setRemoteDescription，不一致就不让 DTLS 起来。
      const fpRemote = parseSdpFingerprint(parsed.sdp);
      if (!fingerprintsEqual(fpRemote, attempt.fpNode)) {
        this.failAttempt('node DTLS fingerprint mismatch', false);
        return;
      }
      await pc.setRemoteDescription({ type, sdp: parsed.sdp });
      if (this.stale(attempt)) return;
      attempt.remoteReady = true;
      const queued = attempt.pendingRemoteCandidates.splice(0);
      for (const candidate of queued) {
        try {
          await pc.addIceCandidate(candidate);
        } catch {
          // 单条候选失败不影响其余
        }
        if (this.stale(attempt)) return;
      }
      return;
    }
    if (!signal.candidate) return;
    const parsed = JSON.parse(signal.candidate) as { candidate?: unknown; mid?: unknown };
    if (typeof parsed.candidate !== 'string' || !parsed.candidate) return;
    const candidate: IceCandidateLike = {
      candidate: parsed.candidate,
      sdpMid: typeof parsed.mid === 'string' ? parsed.mid : '0',
    };
    // `setRemoteDescription` 没完成时 `addIceCandidate` 会抛，候选就永久丢了。
    if (!attempt.remoteReady) {
      attempt.pendingRemoteCandidates.push(candidate);
      return;
    }
    await pc.addIceCandidate(candidate);
  }

  private queueSignal(attempt: Attempt, part: SignalPart): void {
    attempt.outbox.push(part);
    void this.pumpOutbox(attempt);
  }

  /**
   * 按序泵出 outbox：送不出去（`/mesh/ws` 断开返回 `false`）就把这条留在队头，
   * 等 `onReady` 再泵。丢一条候选就可能让本可建立的直连一路超时。
   */
  private async pumpOutbox(attempt: Attempt): Promise<void> {
    if (attempt.pumping) return;
    attempt.pumping = true;
    try {
      while (!this.stale(attempt) && attempt.outbox.length > 0) {
        if (!this.signalingReady()) return;
        const part = attempt.outbox[0];
        if (!part) return;
        let ok = false;
        try {
          ok = await this.options.signaling.send({
            rtcSession: attempt.rtcSession,
            from: 'browser',
            to: this.nodeId,
            sdp: part.sdp ?? null,
            candidate: part.candidate ?? null,
          });
        } catch {
          ok = false;
        }
        if (this.stale(attempt) || !ok) return;
        attempt.outbox.shift();
      }
    } finally {
      attempt.pumping = false;
    }
  }

  private installSignalingReadyListener(): void {
    const signaling = this.options.signaling;
    if (!signaling.onReady || this.unsubscribeSignalingReady) return;
    this.unsubscribeSignalingReady = signaling.onReady((ready) => {
      if (!this.started || !ready) return;
      // mesh WS 恢复：退避重来一轮，别停在 failed 等用户刷新页面。
      this.attempts = 0;
      const attempt = this.attempt;
      if (attempt && !attempt.cancelled) {
        void this.pumpOutbox(attempt);
        return;
      }
      this.clearRetryTimer();
      this.connect();
    });
  }

  private removeSignalingReadyListener(): void {
    const unsubscribe = this.unsubscribeSignalingReady;
    this.unsubscribeSignalingReady = null;
    try {
      unsubscribe?.();
    } catch {
      // 已注销
    }
  }

  // ========== 载体挂载与激活 ==========

  /**
   * 通道 open：发首帧 nonce、建载体挂进屏障。**不置 active**——node 可能因为 nonce /
   * session 绑定失败立刻关掉通道，此时若已清零重试计数，退避永远从 1 s 重来、
   * 也永远到不了上限；诊断还会长期显示「direct」而实际仍走 primary。
   */
  private mountCarrier(attempt: Attempt): void {
    if (attempt.carrier) return;
    const channel = attempt.channel;
    const nonce = attempt.nonce;
    if (!channel || nonce == null) return;
    // 首帧 nonce 必须是**裸的**未分片 JSON：node 在挂载载体前先读走这一条。
    try {
      channel.send(new TextEncoder().encode(JSON.stringify({ nonce })));
    } catch (err) {
      this.failAttempt(err instanceof Error ? err.message : 'nonce send failed', true);
      return;
    }
    // 分片层的协议违规会自毁载体，随后走同一条 onClose；原因单独记下来供诊断。
    const failure: { reason: string | null } = { reason: null };
    const carrier = new DirectDataChannelCarrier(channel, {
      maxMessageBytes: attempt.pc?.sctp?.maxMessageSize,
      onProtocolError: (reason) => {
        failure.reason = reason;
      },
    });
    attempt.carrier = carrier;
    carrier.onClose(() => {
      if (this.stale(attempt)) return;
      this.handleCarrierGone(
        failure.reason ? `direct protocol violation: ${failure.reason}` : 'direct channel closed'
      );
    });
    this.subscribeCarrierChange(attempt);
    // 登记本次 attempt 的 rtcSession：屏障据此丢弃上一次 attempt 迟到的切换帧。
    this.options.connection.attachDirectCarrier(carrier, { rtcSession: attempt.rtcSession });
    // 没有 onCarrierChange 的宿主（老测试桩）退化成「挂上即生效」。
    if (!this.options.connection.onCarrierChange) this.activate(attempt);
  }

  private subscribeCarrierChange(attempt: Attempt): void {
    const subscribe = this.options.connection.onCarrierChange;
    if (!subscribe) return;
    this.unsubscribeCarrierChange?.();
    this.unsubscribeCarrierChange = subscribe.call(this.options.connection, (active) => {
      if (this.stale(attempt)) return;
      if (active === 'direct') {
        this.activate(attempt);
        return;
      }
      // 切回 primary：这条直连已经不承载业务了，按载体失效处理（退避后重来）。
      if (this.state === 'active') this.handleCarrierGone('switched back to primary');
    });
  }

  /** 屏障已切换并回过 ACK：这时候才算真的 active。 */
  private activate(attempt: Attempt): void {
    if (this.stale(attempt) || !attempt.carrier) return;
    if (this.state === 'active') return;
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

  /**
   * connectionId 定位不到本标签页：这不是退避能解决的问题（多标签时重试多少次都是 409），
   * 所以**不消耗重试次数**，挂在 primary 的状态上等它重连过再来一轮。
   */
  private failWaitingPrimary(reason: string, mode: PrimaryWaitMode): void {
    this.teardownAttempt(reason);
    this.stopStatsPolling();
    this.route = null;
    this.rttMs = null;
    this.setState('failed', reason);
    if (!this.started) return;
    this.waitForPrimary(mode);
  }

  /**
   * `open`：等 primary 进入 READY（已经 READY 说明只是登记竞态，退避重试即可）。
   * `reconnect`：必须先看到 primary 掉出 READY 再回到 READY——同 sid 的连接分布只有
   * 这时才可能变。宿主没给状态源（老测试桩）时退回普通退避，绝不静默卡死。
   */
  private waitForPrimary(mode: PrimaryWaitMode): void {
    const status = this.options.connection.client;
    const subscribe = status?.onStateChange;
    if (!status || !subscribe) {
      this.scheduleRetry();
      return;
    }
    const ready = status.isReady?.() ?? false;
    if (mode === 'open' && ready) {
      this.scheduleRetry();
      return;
    }
    this.clearPrimaryWait();
    let sawDown = !ready;
    this.unsubscribePrimaryWait = subscribe.call(status, (state) => {
      if (!this.started) return;
      if (state !== PRIMARY_READY_STATE) {
        sawDown = true;
        return;
      }
      if (!sawDown) return;
      this.clearPrimaryWait();
      this.attempts = 0;
      this.clearRetryTimer();
      this.connect();
    });
  }

  private clearPrimaryWait(): void {
    const unsubscribe = this.unsubscribePrimaryWait;
    this.unsubscribePrimaryWait = null;
    try {
      unsubscribe?.();
    } catch {
      // 已注销
    }
  }

  /** 直连载体没了（通道关闭 / primary 断开导致屏障关掉直连）：退避重连。 */
  private handleCarrierGone(reason: string): void {
    this.failAttempt(reason, true);
  }

  /**
   * ICE 状态机：`disconnected` 只是「暂时收不到对端」，给 5 s 宽限；持续到期就当断了，
   * 立刻回落 primary 并以全新 attempt / rtcSession 重来——Wi-Fi 切蜂窝往往不产生
   * `online` 事件，干等浏览器宣告 failed 期间的输入全部丢在废通道上。
   */
  private handleIceConnectionState(attempt: Attempt, state: string): void {
    if (state === 'disconnected') {
      if (attempt.iceGraceHandle != null) return;
      attempt.iceGraceHandle = this.schedule(() => {
        attempt.iceGraceHandle = null;
        if (this.stale(attempt)) return;
        this.failAttempt('ice disconnected', true);
      }, this.options.iceDisconnectGraceMs ?? DEFAULT_ICE_DISCONNECT_GRACE_MS);
      return;
    }
    if (attempt.iceGraceHandle != null && (state === 'connected' || state === 'completed')) {
      this.cancelTimer(attempt.iceGraceHandle);
      attempt.iceGraceHandle = null;
    }
    if (state === 'failed' || state === 'closed') {
      this.failAttempt(`ice ${state}`, true);
    }
  }

  private scheduleRetry(): void {
    if (this.retryHandle != null) return;
    const maxAttempts = this.options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    if (this.attempts >= maxAttempts) return; // 停在 failed，等 retry() / 网络或信令恢复
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
    if (attempt.iceGraceHandle != null) {
      this.cancelTimer(attempt.iceGraceHandle);
      attempt.iceGraceHandle = null;
    }
    try {
      attempt.abort.abort();
    } catch {
      // AbortController 不会抛，保险起见
    }
    try {
      attempt.unsubscribeSignal();
    } catch {
      // 信令已注销
    }
    try {
      this.unsubscribeCarrierChange?.();
    } catch {
      // 已注销
    }
    this.unsubscribeCarrierChange = null;
    if (attempt.channel) {
      attempt.channel.onopen = null;
      attempt.channel.onclose = null;
    }
    if (attempt.pc) {
      attempt.pc.onicecandidate = null;
      attempt.pc.onconnectionstatechange = null;
      attempt.pc.oniceconnectionstatechange = null;
    }
    try {
      attempt.carrier?.close();
    } catch {
      // 已关闭
    }
    if (attempt.pc) closeQuietly(attempt.pc);
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
    const pc = attempt?.pc;
    if (!attempt || !pc) return;
    let pair: SelectedPairStats | null = null;
    try {
      pair = readSelectedPair(await pc.getStats());
    } catch {
      pair = null;
    }
    if (this.attempt !== attempt) return;
    this.route = deriveRoute(pair);
    this.rttMs = pair?.rttMs ?? null;
    this.ice = {
      connectionState: pc.connectionState || null,
      iceConnectionState: pc.iceConnectionState || null,
      localCandidateType: pair?.localCandidateType ?? null,
      remoteCandidateType: pair?.remoteCandidateType ?? null,
      selectedPair: describePair(pair),
    };
    this.publish();
  }

  private refreshIceSnapshot(): void {
    const pc = this.attempt?.pc;
    if (!pc) return;
    this.ice = {
      connectionState: pc.connectionState || null,
      iceConnectionState: pc.iceConnectionState || null,
      localCandidateType: this.ice?.localCandidateType ?? null,
      remoteCandidateType: this.ice?.remoteCandidateType ?? null,
      selectedPair: this.ice?.selectedPair ?? null,
    };
    this.publish();
  }

  private publish(): void {
    const active = this.state === 'active';
    const next: DirectDiagnostics = {
      path: active ? 'direct' : 'primary',
      route: active ? this.route : null,
      rtt: active ? this.rttMs : null,
      ice: active || this.state === 'connecting' ? this.ice : null,
    };
    const prev = this.snapshot;
    if (
      prev.path === next.path &&
      prev.route === next.route &&
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

  private installNetworkListeners(): void {
    const online = this.resolveNetworkEvents();
    if (online?.addEventListener && !this.onlineHandler) {
      const handler = () => this.handleNetworkChange(0);
      online.addEventListener('online', handler);
      this.onlineHandler = handler;
    }
    // Wi-Fi ↔ 蜂窝切换通常不触发 `online`，只有 Network Information API 的 change。
    const conn = this.resolveConnectionEvents();
    if (conn?.addEventListener && !this.connectionChangeHandler) {
      const handler = () =>
        this.handleNetworkChange(
          this.options.networkChangeDebounceMs ?? DEFAULT_NETWORK_CHANGE_DEBOUNCE_MS
        );
      conn.addEventListener('change', handler);
      this.connectionChangeHandler = handler;
    }
  }

  private handleNetworkChange(debounceMs: number): void {
    if (!this.started) return;
    if (this.networkDebounceHandle != null) {
      this.cancelTimer(this.networkDebounceHandle);
      this.networkDebounceHandle = null;
    }
    if (debounceMs <= 0) {
      this.retry();
      return;
    }
    this.networkDebounceHandle = this.schedule(() => {
      this.networkDebounceHandle = null;
      if (!this.started) return;
      this.retry();
    }, debounceMs);
  }

  private removeNetworkListeners(): void {
    if (this.networkDebounceHandle != null) {
      this.cancelTimer(this.networkDebounceHandle);
      this.networkDebounceHandle = null;
    }
    const onlineHandler = this.onlineHandler;
    this.onlineHandler = null;
    if (onlineHandler) this.resolveNetworkEvents()?.removeEventListener?.('online', onlineHandler);
    const connHandler = this.connectionChangeHandler;
    this.connectionChangeHandler = null;
    if (connHandler) this.resolveConnectionEvents()?.removeEventListener?.('change', connHandler);
  }

  private resolveNetworkEvents(): EventTargetLike | null {
    return this.options.networkEvents ?? (globalThis as unknown as EventTargetLike) ?? null;
  }

  private resolveConnectionEvents(): EventTargetLike | null {
    if (this.options.connectionEvents !== undefined) return this.options.connectionEvents;
    return defaultConnectionEvents();
  }
}

function closeQuietly(pc: RTCPeerConnectionLike): void {
  try {
    pc.close();
  } catch {
    // 已关闭
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

/** 等 primary 的两种姿势：等它连上（`open`）/ 等它重连过一次（`reconnect`）。 */
type PrimaryWaitMode = 'open' | 'reconnect';

/** `BorshWebSocketClient` 完成 HELLO 后的状态名。 */
const PRIMARY_READY_STATE = 'READY';

class DirectPrimaryWaitError extends Error {
  constructor(
    message: string,
    readonly mode: PrimaryWaitMode
  ) {
    super(message);
    this.name = 'DirectPrimaryWaitError';
  }
}

/**
 * 只认**带明确 code** 的那两个状态：老 node 上 `/api/mesh/connection` 落到
 * `/api/mesh/*` 的 405、或路由缺失的裸 404，都不该被误判成「等 primary」而永久挂起。
 */
function primaryWaitFor(status: number, code: string): PrimaryWaitMode | null {
  if (status === 404 && code === 'NO_CONNECTION') return 'open';
  if (status === 409 && code === 'MULTIPLE_CONNECTIONS') return 'reconnect';
  return null;
}

async function readErrorCode(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { code?: unknown; error?: unknown };
    if (typeof body?.code === 'string') return body.code;
    if (typeof body?.error === 'string') return body.error;
  } catch {
    // 非 JSON 或空 body
  }
  return '';
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
