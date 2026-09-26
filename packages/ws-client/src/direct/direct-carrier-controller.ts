// 浏览器 ↔ 目标 node 的直连控制器。每次尝试都是全新 generation / rtcSession / PC。
// 协商在 primary HELLO_S2C（READY）之后才开始；HELLO 可捎带 connectionId。
// rtc-config 与 connection 查找并行；所有失败只在 per-node 的直连熔断里记一次账。
// attempt 必须在任何 await 之前登记；指纹不一致立即放弃；信令 FIFO。
//
// 谁决定什么：
//   * 通道死没死由 ICE 状态机判（`disconnected` 宽限 5 s）；控制器不再自己听 `online` /
//     `navigator.connection` 的 `change`——那些信号经宿主的 `nudge()` 进来，而 `nudge()`
//     在 connecting / active 时什么都不做。
//   * primary 会话结束（关闭 / 强制重连）不是直连失败：在途 attempt 不计次地放弃，
//     等 primary 重新 READY 再用新的 connectionId 重来。

import { CONNECTION_HEADER } from '@vibeterm/shared/http/mesh-headers';
import type { DirectCarrierLike } from '../carrier-switch';
import { DirectDataChannelCarrier, type RTCDataChannelLike } from './data-channel-carrier';
import { type DirectRestContext, lookupConnectionId, requestAuthorize } from './direct-authorize';
import {
  DIRECT_BREAKER_HEALTHY_MS,
  NODE_UNREACHABLE_KIND,
  beginDirectAttempt,
  clearDirectUnavailable,
  directBreakerGate,
  directBreakerSnapshot,
  forceDirectProbe,
  noteDirectAuthorized,
  noteDirectEstablished,
  noteDirectFailure,
  noteDirectHealthy,
} from './direct-breaker';
import {
  DirectAuthorizeError,
  DirectPrimaryWaitError,
  type PrimaryWaitMode,
} from './direct-carrier-errors';
import {
  type PageVisibility,
  browserVisibility,
  buildDirectDiagnostics,
  buildIceDiagnostics,
  retainIceCandidateTypes,
  sameDirectDiagnostics,
} from './direct-diagnostics';
import { classifyDirectDialFailure } from './direct-dial-breaker';
import { connectionIdFromCapabilities } from './direct-hello-connection';
import { buildIceServers } from './direct-ice-servers';
import { LinkBackoffWait } from './direct-link-wait';
import { fetchRtcConfig } from './direct-negotiate';
import { type DtlsFingerprint, fingerprintsEqual, parseSdpFingerprint } from './fingerprint';
import {
  type DirectRoute,
  type SelectedPairStats,
  deriveRoute,
  readSelectedPair,
} from './ice-stats';
import type {
  DirectApiClientLike,
  DirectSignalMessage,
  DirectSignalingTransport,
  IceCandidateLike,
  IceServerLike,
  RTCPeerConnectionLike,
  RtcPeerConnectionFactory,
} from './rtc-types';
import {
  type DirectDiagnostics,
  type DirectDiagnosticsSource,
  type DirectIceDiagnostics,
  PRIMARY_ONLY_DIAGNOSTICS,
} from './types';

export { buildIceServers } from './direct-ice-servers';

export type DirectCarrierState = 'idle' | 'connecting' | 'active' | 'failed';

export const SESS_CHANNEL_LABEL = 'sess';
export { RTC_CONFIG_PATH } from './direct-negotiate';
export {
  MESH_CONNECTION_PATH,
  RTC_AUTHORIZE_PATH,
  meshConnectionPath,
} from './direct-authorize';
export { CONNECTION_HEADER };

const DEFAULT_RETRY_BASE_MS = 1000;
const DEFAULT_RETRY_MAX_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_STATS_INTERVAL_MS = 2000;
/** `iceConnectionState === 'disconnected'` 的宽限期：撑过短暂抖动，超时就回落 primary。 */
const DEFAULT_ICE_DISCONNECT_GRACE_MS = 5000;
/** 回前台时 visibility / pageshow / online 往往连着到：距上一次 attempt 这么近的 `nudge()` 合并掉。 */
export const NUDGE_COALESCE_MS = 2000;

/**
 * primary（Gateway WS）的状态源。`BorshWebSocketClient` 结构上即满足，
 * 宿主把整个 `GatewayConnection` 传进来时自动可用。
 *
 * node 侧的 `connectionId` 是**每条 Gateway WS** 一个身份：primary 没连上（404）或同 sid
 * 有多条（409）时，只有 primary 重新连过才可能变；primary 一旦重连，在途 attempt 手上的
 * 旧 id 也就作废了。
 */
export interface PrimaryStatusLike {
  isReady?(): boolean;
  onStateChange?(handler: (state: string) => void): () => void;
  /** primary 会话结束，在直连被一并关掉**之前**触发；缺省时只靠 `onStateChange`。 */
  onSessionEnd?(handler: () => void): () => void;
  /**
   * 最近一次 HELLO_S2C 的能力集。含 `connection-id:<id>` 时本轮不必再
   * `GET /api/mesh/connection`；老网关没有该串，走原来的 REST。
   */
  readonly serverCapabilities?: readonly string[];
}

/** 控制器只用到连接的这几个成员，避免与 `GatewayConnection` 循环依赖。 */
export interface GatewayConnectionLike {
  attachDirectCarrier(carrier: DirectCarrierLike, options?: { rtcSession?: string }): void;
  detachDirectCarrier?(): void;
  /** 屏障完成切换（并已回 ACK）后才通知；控制器据此才认为直连真正生效。 */
  onCarrierChange?(handler: (active: 'primary' | 'direct') => void): () => void;
  /** primary WS 客户端；缺省时 connectionId 相关的等待退化成普通退避重试。 */
  readonly client?: PrimaryStatusLike;
  /** 由控制器挂上「强制拨一次」；`GatewayConnection.retryDirect()` 走这里。 */
  setDirectRetry?(fn: (() => void) | null): void;
}

export interface DirectCarrierControllerOptions {
  /** 目标 node id（`self` 永远不建直连，由调用方保证）。 */
  nodeId: string;
  /** 已带 `/n/<nodeId>` 前缀的 REST 客户端。 */
  apiClient: DirectApiClientLike;
  signaling: DirectSignalingTransport;
  connection: GatewayConnectionLike;
  /**
   * 本标签页那条 Gateway WS 握手时带的 client nonce（`?cid=`）。**每次尝试都现取**：
   * primary 重连会换一条 socket，也就会换一个 nonce。
   *
   * 返回空值（宿主没接线 / 还没建过 socket）时退化成不带 `cid` 的查询——node 侧只有
   * 恰好一条 live WS 时才答得上来，多标签会拿到 409。
   */
  cid?: () => string | null | undefined;
  /** 缺省 `new RTCPeerConnection(config)`。 */
  rtcFactory?: RtcPeerConnectionFactory;
  /**
   * 固定 rtcSession（仅测试用）。生产环境**必须**每次尝试换新值，
   * 传了这里就等于所有重试共用一个 session id。
   */
  rtcSession?: string;
  retryBaseMs?: number;
  retryMaxMs?: number;
  now?: () => number;
  connectTimeoutMs?: number;
  statsIntervalMs?: number;
  /**
   * 页面可见性（测试注入）。缺省 `browserVisibility()`：隐藏时暂停 `getStats`
   * 轮询，回到前台立刻补一拍。失败检测（ICE 宽限 / 通道关闭 / 熔断）不走这条回路。
   */
  visibility?: PageVisibility;
  iceDisconnectGraceMs?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  /**
   * 该 node 在宿主的「打不通」退避里还剩多久（与 REST、primary 重连共用一份账）。
   * 大于 0 时不发起新 attempt（不计入熔断），按短步长复查（见 `LinkBackoffWait`）。
   */
  linkBackoffRemainingMs?: () => number;
  /** 协商 REST 被转发器答 `NODE_UNREACHABLE`：交给宿主记进同一份不可达退避（带 body 的 `reason`）。 */
  onNodeUnreachable?: (reason: string | null) => void;
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

/** 一次失败怎么记账：`count: false` 不进熔断；`kind` 缺省按 reason 归类。 */
interface FailureAccount {
  count?: boolean;
  kind?: string | null;
  retryAfterMs?: number | null;
}

/** 清理路径（注销订阅 / 关闭已关闭的对象）不该因二次调用抛出而中断。 */
function quietly(fn: (() => void) | null | undefined): void {
  try {
    fn?.();
  } catch {
    // 已注销 / 已关闭
  }
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

  private readonly options: DirectCarrierControllerOptions;
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private readonly cancelTimer: (handle: unknown) => void;

  private state: DirectCarrierState = 'idle';
  private failureReason: string | null = null;
  private attempt: Attempt | null = null;
  private generation = 0;
  /** 连续自动重试的次数，只用来算退避间隔；通道健康满 60 s 清零。 */
  private retryStreak = 0;
  private lastAttemptAt = Number.NEGATIVE_INFINITY;
  private retryHandle: unknown = null;
  private coolingHandle: unknown = null;
  private readonly linkWait: LinkBackoffWait;
  private healthyHandle: unknown = null;
  private statsHandle: unknown = null;
  private statsPollGeneration = 0;
  private statsVisibilityUnsub: (() => void) | null = null;
  private started = false;
  private readonly now: () => number;
  private unsubscribeSignalingReady: (() => void) | null = null;
  private unsubscribeCarrierChange: (() => void) | null = null;
  private readonly primaryCleanups: (() => void)[] = [];
  /** 正在等 primary：`open` 等它 READY，`reconnect` 等它掉出 READY 再回来。 */
  private primaryWait: PrimaryWaitMode | null = null;
  private primarySawDown = false;

  private route: DirectRoute | null = null;
  private rttMs: number | null = null;
  private ice: DirectIceDiagnostics | null = null;
  private snapshot: DirectDiagnostics = PRIMARY_ONLY_DIAGNOSTICS;
  private readonly listeners = new Set<() => void>();

  constructor(options: DirectCarrierControllerOptions) {
    this.options = options;
    this.nodeId = options.nodeId;
    this.now = options.now ?? Date.now;
    this.linkWait = new LinkBackoffWait(() => options.linkBackoffRemainingMs?.() ?? 0);
    this.schedule =
      options.setTimeoutFn ?? ((fn, ms) => (globalThis as typeof global).setTimeout(fn, ms));
    this.cancelTimer =
      options.clearTimeoutFn ??
      ((handle) => (globalThis as typeof global).clearTimeout(handle as never));
  }

  /** 撤销一个定时器句柄并交回 `null`：`x = this.clearHandle(x)`。 */
  private clearHandle(handle: unknown): null {
    if (handle != null) this.cancelTimer(handle);
    return null;
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
    this.retryStreak = 0;
    this.options.connection.setDirectRetry?.(() => this.retryDirect());
    this.installPrimaryListeners();
    this.installSignalingReadyListener();
    this.connect();
  }

  /**
   * 用户显式重试：撤掉 `DIRECT_UNAVAILABLE` 停放，冷却中也放行恰好一次（`retryAfterMs`
   * 之内不行），不等宿主的不可达退避。已在建连或已 active 时什么都不做——拆掉在途 attempt
   * 只会让目标 node 多挂一条授权记录。
   */
  retryDirect(): void {
    clearDirectUnavailable(this.nodeId);
    if (!this.started) {
      this.start();
      return;
    }
    if (this.attempt) return;
    forceDirectProbe(this.nodeId);
    this.retryHandle = this.clearHandle(this.retryHandle);
    this.coolingHandle = this.clearHandle(this.coolingHandle);
    this.connect(true);
  }

  /**
   * 「环境可能变了，方便的话再试一次」（页面恢复、`/mesh/ws` 重连）。connecting / active / 等
   * primary / 冷却中、距上次 attempt 不到 `NUDGE_COALESCE_MS` 都不动；等宿主退避而它已清掉时立即重来。
   */
  nudge(): void {
    if (!this.started || this.attempt || this.primaryWait) return;
    const linkCleared = this.linkWait.cleared;
    if (this.coolingHandle != null && !linkCleared) return;
    if (!linkCleared && this.now() - this.lastAttemptAt < NUDGE_COALESCE_MS) return;
    this.coolingHandle = this.clearHandle(this.coolingHandle);
    this.retryHandle = this.clearHandle(this.retryHandle);
    this.connect();
  }

  stop(): void {
    this.started = false;
    this.retryHandle = this.clearHandle(this.retryHandle);
    this.coolingHandle = this.clearHandle(this.coolingHandle);
    this.linkWait.reset();
    this.healthyHandle = this.clearHandle(this.healthyHandle);
    this.stopStatsPolling();
    this.primaryWait = null;
    this.removePrimaryListeners();
    this.removeSignalingReadyListener();
    this.options.connection.setDirectRetry?.(null);
    this.teardownAttempt();
    this.setState('idle', null);
  }

  // ========== 连接流程 ==========

  private connect(explicit = false): void {
    if (!this.started || this.attempt) return;
    // 信令没通也开 attempt：REST / ICE 与 `/mesh/ws` 握手重叠，offer 进 outbox，ready 再泵。
    // HELLO_S2C 之前 connection 还没登记：先等 primary READY，避免 404 空转。
    if (!this.primaryReady()) {
      this.waitPrimary('primary not ready', 'open');
      return;
    }
    if (!explicit && this.waitLinkBackoff()) return;
    const gate = directBreakerGate(this.nodeId, this.now());
    if (!gate.allow) {
      this.setState('failed', this.failureReason);
      this.armCoolingRetry(gate.until);
      this.publish();
      return;
    }
    this.primaryWait = null;
    this.setState('connecting', null);
    const attempt = this.beginAttempt();
    void this.runAttempt(attempt).catch((err) => {
      if (this.attempt !== attempt) return;
      if (err instanceof DirectPrimaryWaitError) {
        this.waitPrimary(err.message, err.mode);
        return;
      }
      if (err instanceof DirectAuthorizeError) {
        this.failNegotiation(err);
        return;
      }
      this.failAttempt(err instanceof Error ? err.message : String(err), true);
    });
  }

  /** 宿主说这台 node 此刻打不通：不发请求、不计次，短步长复查。 */
  private waitLinkBackoff(): boolean {
    const delay = this.linkWait.next();
    if (delay <= 0) return false;
    this.setState('idle', 'node unreachable');
    this.armCoolingRetry(this.now() + delay);
    return true;
  }

  /** 在**任何 await 之前**登记 attempt：否则并发调用会开出两条 PeerConnection。 */
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
    this.lastAttemptAt = this.now();
    beginDirectAttempt(this.nodeId, attempt.rtcSession);
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
    // connectionId 与 rtc-config 并行：HELLO 已捎带 id 时跳过转发 GET，
    // rtc-config 打 entry（宿主把该路径指到不带 `/n/<id>` 的客户端）。
    const helloId = this.helloConnectionId();
    const [connectionId, config] = await Promise.all([
      helloId ? Promise.resolve(helloId) : this.fetchConnectionId(attempt),
      fetchRtcConfig(this.options.apiClient, attempt.abort.signal),
    ]);
    if (this.stale(attempt)) return;
    attempt.connectionId = connectionId;

    const factory = this.options.rtcFactory ?? defaultRtcFactory;
    const pc = factory({ iceServers: buildIceServers(config) });
    if (this.stale(attempt)) {
      // 这一代已被替换：新建的 PC 必须就地关掉，否则泄漏
      quietly(() => pc.close());
      return;
    }
    attempt.pc = pc;
    const channel = pc.createDataChannel(SESS_CHANNEL_LABEL, { ordered: true });
    attempt.channel = channel;
    this.watchPeer(attempt, pc);

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
    noteDirectAuthorized(this.nodeId);
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
      this.failAttempt('direct channel closed before switch', true);
    };
    if (channel.readyState === 'open') this.mountCarrier(attempt);
  }

  /** PC 侧的三个回调：本地候选出站、连接态、ICE 态；一律先比对 generation。 */
  private watchPeer(attempt: Attempt, pc: RTCPeerConnectionLike): void {
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
  }

  /**
   * HELLO_S2C 捎带的本条 WS `connectionId`（能力串 `connection-id:`）。
   * 每次 attempt 现读：primary 重连会换一条 socket，HELLO 也会换一个 id。
   */
  private helloConnectionId(): string | null {
    return connectionIdFromCapabilities(this.options.connection.client?.serverCapabilities);
  }

  private restContext(attempt: Attempt): DirectRestContext {
    return { apiClient: this.options.apiClient, signal: attempt.abort.signal };
  }

  /**
   * `GET /api/mesh/connection?cid=<nonce>`：取本标签页那条 Gateway WS 在目标 node 上的
   * `connectionId`。HELLO 已带 id 的网关跳过这条（见 `runAttempt`）。**每次尝试都要重取**
   * ——primary 重连会换一条 WS（连带换 nonce），缓存下来的旧值会把直连挂到已死的会话上。
   *
   * 浏览器的 `WebSocket` 构造函数不能带自定义请求头，也读不到 upgrade 响应头，
   * 老网关的 HELLO 也不带 id，所以身份只能靠握手 URL 上的 `?cid=` nonce 加这一条 REST 换取。
   * 返回的是 node **自己生成**的 id，nonce 绝不能拿去 authorize。
   */
  private fetchConnectionId(attempt: Attempt): Promise<string | null> {
    return lookupConnectionId(this.restContext(attempt), this.options.cid?.());
  }

  private authorize(
    attempt: Attempt,
    fpBrowser: DtlsFingerprint
  ): Promise<{ nonce: string; fpNode: DtlsFingerprint }> {
    return requestAuthorize(this.restContext(attempt), {
      rtcSession: attempt.rtcSession,
      connectionId: attempt.connectionId,
      fpBrowser,
    });
  }

  // ========== 信令 ==========

  private signalingReady(): boolean {
    const signaling = this.options.signaling;
    return signaling.isReady ? signaling.isReady() : true;
  }

  private primaryReady(): boolean {
    const status = this.options.connection.client;
    if (!status?.isReady) return true;
    return status.isReady();
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
      if (!fingerprintsEqual(parseSdpFingerprint(parsed.sdp), attempt.fpNode)) {
        this.failAttempt('node DTLS fingerprint mismatch', false);
        return;
      }
      await pc.setRemoteDescription({ type, sdp: parsed.sdp });
      if (this.stale(attempt)) return;
      attempt.remoteReady = true;
      for (const candidate of attempt.pendingRemoteCandidates.splice(0)) {
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

  /** `/mesh/ws` 连上：在途 attempt 接着泵 outbox；没有在途 attempt 就当作一次 `nudge()`。 */
  private installSignalingReadyListener(): void {
    const signaling = this.options.signaling;
    if (!signaling.onReady || this.unsubscribeSignalingReady) return;
    this.unsubscribeSignalingReady = signaling.onReady((ready) => {
      if (!this.started || !ready) return;
      const attempt = this.attempt;
      if (attempt && !attempt.cancelled) {
        void this.pumpOutbox(attempt);
        return;
      }
      this.nudge();
    });
  }

  private removeSignalingReadyListener(): void {
    const unsubscribe = this.unsubscribeSignalingReady;
    this.unsubscribeSignalingReady = null;
    quietly(unsubscribe);
  }

  // ========== primary 状态 ==========

  /**
   * 整个 started 期间都盯着 primary：会话结束时在途 attempt 手上的 connectionId 就作废了，
   * 此时拆掉它**不计入熔断**（primary 断开不是直连的错），等 primary 回到 READY 再来。
   * `onSessionEnd` 在屏障关直连之前触发，保证随之而来的通道关闭不会被当成直连失败；
   * 没有该事件的宿主退回 `onStateChange`。
   */
  private installPrimaryListeners(): void {
    const status = this.options.connection.client;
    if (!status) return;
    if (status.onSessionEnd) {
      this.primaryCleanups.push(status.onSessionEnd.call(status, () => this.handlePrimaryLost()));
    }
    if (status.onStateChange) {
      this.primaryCleanups.push(
        status.onStateChange.call(status, (state) => this.handlePrimaryState(state))
      );
    }
  }

  private removePrimaryListeners(): void {
    for (const off of this.primaryCleanups.splice(0)) quietly(off);
  }

  private handlePrimaryLost(): void {
    if (!this.started) return;
    this.primarySawDown = true;
    if (!this.attempt) return;
    this.abandonAttempt('primary closed', 'idle', { detach: false });
    this.primaryWait = 'open';
  }

  private handlePrimaryState(state: string): void {
    if (!this.started) return;
    if (state !== PRIMARY_READY_STATE) {
      this.handlePrimaryLost();
      return;
    }
    if (!this.primaryWait || !this.primarySawDown) return;
    this.primaryWait = null;
    this.retryHandle = this.clearHandle(this.retryHandle);
    this.connect();
  }

  /**
   * connectionId 定位不到本标签页 / primary 还没 READY：这不是退避能解决的问题（多标签时
   * 重试多少次都是 409），不计入熔断，挂在 primary 的状态上等它（重）连过再来。
   *
   * `open`：等 primary 进入 READY（已经 READY 说明只是登记竞态，退避重试即可）。
   * `reconnect`：必须先看到 primary 掉出 READY 再回到 READY。宿主没给状态源（老测试桩）
   * 时退回普通退避，绝不静默卡死。
   */
  private waitPrimary(reason: string, mode: PrimaryWaitMode): void {
    this.abandonAttempt(reason, 'idle');
    if (!this.started) return;
    const status = this.options.connection.client;
    if (!status?.onStateChange) {
      this.scheduleRetry();
      return;
    }
    const ready = status.isReady?.() ?? false;
    if (mode === 'open' && ready) {
      this.scheduleRetry();
      return;
    }
    this.primaryWait = mode;
    this.primarySawDown = !ready;
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
    if (state === 'connected' || state === 'completed') {
      attempt.iceGraceHandle = this.clearHandle(attempt.iceGraceHandle);
      return;
    }
    if (state === 'failed' || state === 'closed') this.failAttempt(`ice ${state}`, true);
  }

  // ========== 载体挂载与激活 ==========

  /**
   * 通道 open：发首帧 nonce、建载体挂进屏障。**不置 active**——node 可能因为 nonce /
   * session 绑定失败立刻关掉通道，此时若已清零重试计数，退避永远从 1 s 重来；
   * 诊断还会长期显示「direct」而实际仍走 primary。
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
      if (failure.reason) {
        this.failAttempt(`direct protocol violation: ${failure.reason}`, true);
        return;
      }
      const local = carrier.closeReason;
      this.failAttempt(
        local ? `direct channel closed (${local})` : 'direct channel closed by peer',
        true
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
    quietly(this.unsubscribeCarrierChange);
    this.unsubscribeCarrierChange = subscribe.call(this.options.connection, (active) => {
      if (this.stale(attempt)) return;
      if (active === 'direct') {
        this.activate(attempt);
        return;
      }
      // 切回 primary（node 切回，或 PING 在直连上超时被摘掉）：这条直连已经不承载业务了。
      if (this.state === 'active') this.failAttempt('switched back to primary', true);
    });
  }

  /** 屏障已切换并回过 ACK：这时候才算真的 active。 */
  private activate(attempt: Attempt): void {
    if (this.stale(attempt) || !attempt.carrier) return;
    if (this.state === 'active') return;
    attempt.timeoutHandle = this.clearHandle(attempt.timeoutHandle);
    noteDirectEstablished(this.nodeId, attempt.rtcSession, this.now());
    this.healthyHandle = this.clearHandle(this.healthyHandle);
    const establishedAt = this.now();
    this.healthyHandle = this.schedule(() => {
      this.healthyHandle = null;
      if (this.state !== 'active' || this.attempt !== attempt) return;
      if (this.now() - establishedAt < DIRECT_BREAKER_HEALTHY_MS) return;
      noteDirectHealthy(this.nodeId, this.now());
      this.retryStreak = 0;
      this.publish();
    }, DIRECT_BREAKER_HEALTHY_MS);
    this.setState('active', null);
    this.startStatsPolling();
  }

  // ========== 失败与退避 ==========

  /** 协商 REST 的失败只记一次账：`NODE_UNREACHABLE` 只进宿主的不可达退避，不进熔断。 */
  private failNegotiation(err: DirectAuthorizeError): void {
    const kind = err.kind ?? classifyDirectDialFailure(err.message);
    const unreachable = kind === NODE_UNREACHABLE_KIND;
    if (unreachable) this.options.onNodeUnreachable?.(err.reason);
    const account = unreachable ? { count: false } : { kind, retryAfterMs: err.retryAfterMs };
    this.failAttempt(err.message, !err.fatal, account);
  }

  private failAttempt(reason: string, retryable: boolean, account: FailureAccount = {}): void {
    const attemptId = this.attempt?.rtcSession;
    this.stopAttempt();
    if (account.count !== false) {
      const kind = account.kind !== undefined ? account.kind : classifyDirectDialFailure(reason);
      if (kind) {
        noteDirectFailure(this.nodeId, kind, attemptId, this.now(), account.retryAfterMs ?? null);
      }
    }
    this.setState('failed', reason);
    if (retryable && this.started) this.scheduleRetry();
  }

  /** 放弃在途 attempt 但不记失败（primary 没了、要等 primary）。 */
  private abandonAttempt(
    reason: string,
    state: DirectCarrierState,
    options: { detach?: boolean } = {}
  ): void {
    this.stopAttempt(options.detach ?? true);
    this.setState(state, reason);
  }

  private stopAttempt(detach = true): void {
    this.healthyHandle = this.clearHandle(this.healthyHandle);
    this.teardownAttempt(detach);
    this.stopStatsPolling();
    this.route = null;
    this.rttMs = null;
  }

  private scheduleRetry(): void {
    if (this.retryHandle != null || this.coolingHandle != null) return;
    const gate = directBreakerGate(this.nodeId, this.now());
    if (!gate.allow) {
      this.armCoolingRetry(gate.until);
      this.publish();
      return;
    }
    const delay = this.retryDelay(this.retryStreak);
    this.retryStreak += 1;
    this.retryHandle = this.schedule(() => {
      this.retryHandle = null;
      if (!this.started) return;
      this.connect();
    }, delay);
  }

  private armCoolingRetry(until: number | null): void {
    if (this.coolingHandle != null) return;
    this.retryHandle = this.clearHandle(this.retryHandle);
    const delay = Math.max(0, (until ?? this.now()) - this.now());
    this.coolingHandle = this.schedule(() => {
      this.coolingHandle = null;
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

  /**
   * `detach: false` 只用于 primary 会话结束：屏障紧接着会 `closeDirect()`。这里既不摘载体，
   * 也不同步关载体 / PC——载体一关，屏障会当成「直连掉了」去补齐订阅、弹回落提示，而此刻
   * primary 本身就不在。等屏障切回 primary 之后（微任务）再关。
   */
  private teardownAttempt(detach = true): void {
    const attempt = this.attempt;
    if (!attempt) return;
    this.attempt = null;
    attempt.cancelled = true;
    attempt.timeoutHandle = this.clearHandle(attempt.timeoutHandle);
    attempt.iceGraceHandle = this.clearHandle(attempt.iceGraceHandle);
    quietly(() => attempt.abort.abort());
    quietly(attempt.unsubscribeSignal);
    quietly(this.unsubscribeCarrierChange);
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
    const release = () => {
      quietly(() => attempt.carrier?.close());
      quietly(() => attempt.pc?.close());
    };
    if (!detach) {
      queueMicrotask(release);
      return;
    }
    release();
    this.options.connection.detachDirectCarrier?.();
  }

  private startStatsPolling(): void {
    this.stopStatsPolling();
    const visibility = this.options.visibility ?? browserVisibility();
    const interval = this.options.statsIntervalMs ?? DEFAULT_STATS_INTERVAL_MS;
    const gen = this.statsPollGeneration;
    let busy = false;
    const live = () =>
      this.statsPollGeneration === gen &&
      this.state === 'active' &&
      !!this.attempt &&
      !visibility.hidden();
    const tick = () => {
      this.statsHandle = null;
      if (!live() || busy) return;
      busy = true;
      void this.pollStats().finally(() => {
        busy = false;
        if (live()) this.statsHandle = this.schedule(tick, interval);
      });
    };
    this.statsVisibilityUnsub = visibility.subscribe(() => {
      if (this.statsPollGeneration !== gen || this.state !== 'active' || !this.attempt) return;
      if (visibility.hidden()) this.statsHandle = this.clearHandle(this.statsHandle);
      else tick();
    });
    tick();
  }

  private stopStatsPolling(): void {
    this.statsPollGeneration += 1;
    this.statsHandle = this.clearHandle(this.statsHandle);
    const unsub = this.statsVisibilityUnsub;
    this.statsVisibilityUnsub = null;
    quietly(unsub);
  }

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
    this.ice = buildIceDiagnostics(pc, pair);
    this.publish();
  }

  private refreshIceSnapshot(): void {
    const pc = this.attempt?.pc;
    if (!pc) return;
    this.ice = retainIceCandidateTypes(pc, this.ice);
    this.publish();
  }

  private publish(): void {
    const next = buildDirectDiagnostics(this.state, {
      route: this.route,
      rtt: this.rttMs,
      ice: this.ice,
      breaker: directBreakerSnapshot(this.nodeId, this.now()),
    });
    if (sameDirectDiagnostics(this.snapshot, next)) return;
    this.snapshot = next;
    for (const listener of this.listeners) quietly(listener);
  }

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
}

/** `BorshWebSocketClient` 完成 HELLO 后的状态名。 */
const PRIMARY_READY_STATE = 'READY';
