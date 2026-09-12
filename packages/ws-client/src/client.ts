// FE Borsh WebSocket 客户端
// 门面：组合心跳、重连退避与协议分发，对外维持连接状态与订阅接口

import {
  CLIENT_CAPABILITY_HELLO_SCREEN_INTENT_V1,
  GATEWAY_CAPABILITY_CANONICAL_STATE_V1_1,
  wsBorsh,
} from '@vibeterm/shared';
import {
  type ActiveCarrier,
  type AttachDirectOptions,
  CarrierSwitchBarrier,
  type DirectCarrierLike,
} from './carrier-switch';
import { ResumeProbeGate, ResumeSignalListeners } from './client-resume';
import {
  type SocketFactory,
  WS_CONNECTING,
  WS_OPEN,
  type WebSocketLike,
  defaultSocketFactory,
  defaultWsUrl,
  toArrayBuffer,
} from './client-socket';
import { getDefaultClientVersion, setDefaultClientVersion } from './client-version';
import { notifyHandlers } from './handler-fanout';
import {
  normalizeNegotiatedHeartbeatIntervalMs,
  resolveHeartbeatCadence,
  resolveResumeProbeTimeoutMs,
} from './heartbeat-cadence';
import { type HeartbeatCadence, HeartbeatController } from './heartbeat-controller';
import { NetworkWakeListeners } from './network-wake';
import {
  DEFAULT_MAX_PENDING_BYTES,
  DEFAULT_MAX_PENDING_FRAMES,
  type PendingOverflowInfo,
  PendingSendQueue,
} from './pending-send-queue';
import {
  type BorshMessage,
  type ChunkProgress,
  type NegotiatedHello,
  ProtocolDispatcher,
} from './protocol-dispatcher';
import { isProtocolFatalError } from './protocol-fatal';
import { ReconnectController } from './reconnect-controller';
import { serverSupportsTermViewport } from './server-features';

// ========== 配置 ==========

export { defaultWsUrl } from './client-socket';
export type { SocketFactory, WebSocketLike } from './client-socket';

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 5000;
export const DEFAULT_PONG_TIMEOUT_MS = 10000;
// 页面在后台时的慢节奏：30s/60s。网关自身不设 socket 空闲超时，上界由外部代理决定
// （Cloudflare Tunnel 约 100s），30s 仍有充足余量，同时把后台唤醒次数降到 1/6。
export const DEFAULT_HIDDEN_HEARTBEAT_INTERVAL_MS = 30000;
export const DEFAULT_HIDDEN_HEARTBEAT_TIMEOUT_MS = 60000;

export {
  MAX_NEGOTIATED_HEARTBEAT_INTERVAL_MS,
  MIN_NEGOTIATED_HEARTBEAT_INTERVAL_MS,
  normalizeNegotiatedHeartbeatIntervalMs,
} from './heartbeat-cadence';

const DEFAULT_OPTIONS: BorshClientOptions = {
  clientImpl: 'vibeterm-fe',
  clientVersion: getDefaultClientVersion(),
  maxFrameBytes: 1048576, // 1MB
  reconnectDelayMs: 1000,
  // 弱网下不设上限：断网期间一直以封顶间隔（30s）重试，只有协议级 fatal、
  // 会话失效（4401，宿主调 disconnect）或调用方显式关闭才停。
  maxReconnectAttempts: Number.POSITIVE_INFINITY,
  heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
  pongTimeoutMs: DEFAULT_PONG_TIMEOUT_MS,
  hiddenHeartbeatIntervalMs: DEFAULT_HIDDEN_HEARTBEAT_INTERVAL_MS,
  hiddenHeartbeatTimeoutMs: DEFAULT_HIDDEN_HEARTBEAT_TIMEOUT_MS,
};

const VISIBILITY_RECONNECT_THROTTLE_MS = 5000;
const MIN_CANONICAL_FEED_FRAME_BYTES = wsBorsh.CANONICAL_STATE_MAX_FRAME_BYTES;

// ========== 类型定义 ==========

export interface BorshClientOptions {
  clientImpl: string;
  clientVersion: string;
  maxFrameBytes: number;
  reconnectDelayMs: number;
  /** 自动重连尝试次数上限；缺省无上限（`Infinity`），仅测试需要收敛时才传 */
  maxReconnectAttempts: number;
  heartbeatIntervalMs: number;
  /** PING 之后等待 PONG 的上限，超时则关闭连接触发重连 */
  pongTimeoutMs?: number;
  /** 页面隐藏时的心跳间隔；缺省 30000 */
  hiddenHeartbeatIntervalMs?: number;
  /** 页面隐藏时的 PONG 超时；缺省 60000 */
  hiddenHeartbeatTimeoutMs?: number;
  /** WS 端点；缺省时连接当刻按 window.location 推导（defaultWsUrl） */
  url?: string;
  /** 自定义 transport 工厂；缺省为 `new WebSocket(url)` */
  socketFactory?: SocketFactory;
  /** 未就绪待发队列字节上限；缺省 2 MiB */
  maxPendingBytes?: number;
  /** 未就绪待发队列帧数上限；缺省 2048 */
  maxPendingFrames?: number;
}

export type ConnectionState =
  | 'IDLE'
  | 'WS_CONNECTING'
  | 'HELLO_NEGOTIATING'
  | 'READY'
  | 'RECONNECT_BACKOFF'
  | 'CLOSED';

// legacy 状态流已下线；unsupported = 已连上但网关不满足 canonical v1.1 门槛，不回退
export type StateFeedMode = 'pending' | 'canonical' | 'unsupported';

export { getDefaultClientVersion, setDefaultClientVersion };
export type { BorshMessage, ChunkProgress } from './protocol-dispatcher';

export type MessageHandler = (message: BorshMessage) => void;
export type StateChangeHandler = (state: ConnectionState) => void;
export type ErrorHandler = (error: Error) => void;
export type ChunkProgressHandler = (progress: ChunkProgress) => void;
export type PendingOverflowHandler = (info: PendingOverflowInfo) => void;

/**
 * 出站结果。`queued` / `backpressure` 数据未丢，调用方不必重发；
 * `overflow` 表示本帧未入队（有序输入会整段丢弃），调用方必须视为发送失败。
 */
export type ClientSendResult = 'sent' | 'queued' | 'backpressure' | 'overflow';
export type { PendingOverflowInfo };

// ========== Borsh WebSocket 客户端 ==========

export class BorshWebSocketClient {
  private ws: WebSocketLike | null = null;
  private options: BorshClientOptions;
  private state: ConnectionState = 'IDLE';

  // 消息处理
  private seq = 0;
  private readonly dispatcher: ProtocolDispatcher;

  // 重连 / 心跳
  private readonly reconnector: ReconnectController;
  private readonly heartbeat: HeartbeatController;
  /** 调用方显式给了 heartbeatIntervalMs 时不接受服务端协商值（应用侧设置优先） */
  private readonly heartbeatIntervalPinned: boolean;
  private negotiatedHeartbeatIntervalMs: number | null = null;
  private readonly explicitPongTimeoutMs: number | undefined;

  // 回调
  private messageHandlers: Set<MessageHandler> = new Set();
  private stateChangeHandlers: Set<StateChangeHandler> = new Set();
  private errorHandlers: Set<ErrorHandler> = new Set();
  private latencyHandlers: Set<(latencyMs: number, rawMs: number) => void> = new Set();
  private chunkProgressHandlers: Set<ChunkProgressHandler> = new Set();
  private pendingOverflowHandlers: Set<PendingOverflowHandler> = new Set();

  // 恢复信号（visibilitychange / pageshow）
  private readonly resumeSignals = new ResumeSignalListeners({
    // 转入后台只换节奏、不补发 PING；在途 PONG 沿用原截止时间。
    onVisibilityChange: () => this.applyHeartbeatCadence(),
    onResume: () => this.handleResumeSignal(),
  });
  private lastVisibilityReconnectAt = 0;
  private readonly resumeProbeGate = new ResumeProbeGate();

  // online / navigator.connection change
  private readonly networkWake = new NetworkWakeListeners(() => this.handleResumeSignal());

  // 协议级不可重试错误（对端版本低于 canonical v1.1 门槛）：重连只会原样再被拒一次，
  // 只有宿主升级或调用方显式 connect()/reconnect() 才有意义，故就地熄火。
  private protocolFatal = false;

  // 直连载体（F3-1）：懒建，未挂载直连时整条路径与之前完全一致
  private barrier: CarrierSwitchBarrier | null = null;
  private carrierChangeHandlers: Set<(active: ActiveCarrier) => void> = new Set();
  private resumeSubscribedPanes: (() => void) | null = null;

  private readonly pending: PendingSendQueue;

  hasConnectedOnce = false;
  latencyMs: number | null = null;
  latencyRawMs: number | null = null;
  // 服务端 HELLO_S2C 协商的能力集（消费方按 featureset 判定；多实例宿主按连接读取）
  serverCapabilities: readonly string[] = [];
  // 本连接协商到的服务端版本；未协商（含重连等待期）为 null，下一次 HELLO 重新推导
  serverVersion: string | null = null;
  stateFeedMode: StateFeedMode = 'pending';
  private serverMaxFrameBytes: number | null = null;
  private helloScreenIntentProvider: (() => wsBorsh.HelloScreenIntent | null) | null = null;

  get effectiveMaxFrameBytes(): number {
    return Math.min(
      this.options.maxFrameBytes,
      this.serverMaxFrameBytes ?? this.options.maxFrameBytes
    );
  }

  get pendingCommandLimits(): { maxBytes: number; maxFrames: number } {
    return {
      maxBytes: this.options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES,
      maxFrames: this.options.maxPendingFrames ?? DEFAULT_MAX_PENDING_FRAMES,
    };
  }

  /** 当前生效的心跳节奏（协商 + 可见性两条都算进去后的结果）。 */
  get heartbeatCadence(): HeartbeatCadence {
    return this.heartbeat.cadence;
  }

  /** 服务端是否认识 TERM_VIEWPORT（1.1.7 起）；未知版本按新版处理。 */
  get supportsTermViewport(): boolean {
    return serverSupportsTermViewport(this.serverVersion);
  }

  getClientVersion(): string {
    return this.options.clientVersion;
  }

  setHelloScreenIntentProvider(provider: (() => wsBorsh.HelloScreenIntent | null) | null): void {
    this.helloScreenIntentProvider = provider;
  }

  constructor(options: Partial<BorshClientOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, clientVersion: getDefaultClientVersion(), ...options };
    this.explicitPongTimeoutMs = options.pongTimeoutMs;
    this.heartbeatIntervalPinned = options.heartbeatIntervalMs !== undefined;
    this.pending = new PendingSendQueue({
      maxBytes: this.options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES,
      maxFrames: this.options.maxPendingFrames ?? DEFAULT_MAX_PENDING_FRAMES,
    });

    this.dispatcher = new ProtocolDispatcher({
      onMessage: (message) => this.dispatchMessage(message),
      onChunkProgress: (progress) => this.dispatchChunkProgress(progress),
      onHello: (hello) => this.handleHelloNegotiated(hello),
      onHelloFailure: (error) => this.handleError(error),
      onPong: (payload) => this.handlePong(payload),
    });

    this.reconnector = new ReconnectController({
      delayMs: this.options.reconnectDelayMs,
      maxAttempts: this.options.maxReconnectAttempts,
      onReconnect: () => this.connect(),
      onSchedule: ({ attempt, delayMs }) => {
        console.log(`[borsh-client] Reconnecting in ${delayMs}ms (attempt ${attempt})`);
      },
    });

    const cadence = this.resolveHeartbeatCadence();
    this.heartbeat = new HeartbeatController({
      intervalMs: cadence.intervalMs,
      pongTimeoutMs: cadence.pongTimeoutMs,
      sendPing: (nonce) => this.sendPingFrame(nonce),
      onPongTimeout: () => this.ws?.close(),
    });
  }

  // ========== 状态管理 ==========

  private setState(newState: ConnectionState): void {
    if (this.state === newState) return;

    console.log(`[borsh-client] State: ${this.state} -> ${newState}`);
    this.state = newState;

    notifyHandlers(this.stateChangeHandlers, newState, 'state change');

    // 进入 READY 时发送队列
    if (newState === 'READY') {
      this.flushPendingMessages();
    }
  }

  getState(): ConnectionState {
    return this.state;
  }

  isReady(): boolean {
    return this.state === 'READY';
  }

  // ========== 事件订阅 ==========

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onStateChange(handler: StateChangeHandler): () => void {
    this.stateChangeHandlers.add(handler);
    return () => this.stateChangeHandlers.delete(handler);
  }

  onError(handler: ErrorHandler): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  onLatency(handler: (latencyMs: number, rawMs: number) => void): () => void {
    this.latencyHandlers.add(handler);
    return () => this.latencyHandlers.delete(handler);
  }

  onChunkProgress(handler: ChunkProgressHandler): () => void {
    this.chunkProgressHandlers.add(handler);
    return () => this.chunkProgressHandlers.delete(handler);
  }

  onPendingOverflow(handler: PendingOverflowHandler): () => void {
    this.pendingOverflowHandlers.add(handler);
    return () => this.pendingOverflowHandlers.delete(handler);
  }

  // ========== 连接管理 ==========

  connect(): void {
    this.protocolFatal = false;
    this.resumeSignals.install();
    this.networkWake.install();

    if (this.ws?.readyState === WS_OPEN || this.ws?.readyState === WS_CONNECTING) {
      return;
    }

    this.setState('WS_CONNECTING');

    try {
      const createSocket = this.options.socketFactory ?? defaultSocketFactory;
      const socket = createSocket(this.options.url ?? defaultWsUrl());
      this.ws = socket;
      socket.binaryType = 'arraybuffer';

      // 事件回调一律绑定创建时捕获的 socket：旧 socket 的 onclose 可能在新连接建立之后
      // 才派发，若不比对来源就会把新连接的心跳/分片状态一并清掉并再排一次重连。
      socket.onopen = () => {
        if (this.ws !== socket) return;
        this.sendHello();
      };

      socket.onmessage = (event) => {
        if (this.ws !== socket) return;
        if (this.barrier && typeof event.data !== 'string') {
          this.barrier.handlePrimaryInbound(new Uint8Array(event.data));
          return;
        }
        this.dispatcher.handleFrame(event.data);
      };

      socket.onclose = () => {
        if (this.ws !== socket) return;
        this.handleClose();
      };

      socket.onerror = () => {
        if (this.ws !== socket) return;
        this.handleError(new Error('WebSocket error'));
      };
    } catch (err) {
      this.handleConnectFailure(err instanceof Error ? err : new Error(String(err)));
    }
  }

  // socketFactory 同步抛出时没有 socket，也就永远等不到 onclose 兜底：
  // 必须自行清掉 ws 引用并走与 onclose 相同的收敛路径，否则状态卡死在 WS_CONNECTING
  private handleConnectFailure(error: Error): void {
    this.ws = null;
    this.handleError(error);
    this.handleClose();
  }

  disconnect(): void {
    this.setState('CLOSED');
    this.clearTimers();
    this.negotiatedHeartbeatIntervalMs = null;
    this.dispatcher.reset();
    this.barrier?.closeDirect();
    this.resetLatency();
    this.resetNegotiatedServerState();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.resumeSignals.dispose();
    this.networkWake.dispose();
  }

  // ========== 消息处理 ==========

  private dispatchMessage(message: BorshMessage): void {
    if (isProtocolFatalError(message.kind, message.payload)) {
      this.protocolFatal = true;
      this.reconnector.cancel();
    }
    notifyHandlers(this.messageHandlers, message, 'message');
  }

  private dispatchChunkProgress(progress: ChunkProgress): void {
    notifyHandlers(this.chunkProgressHandlers, progress, 'chunk progress');
  }

  private handleHelloNegotiated(hello: NegotiatedHello): void {
    this.negotiatedHeartbeatIntervalMs = this.heartbeatIntervalPinned
      ? null
      : normalizeNegotiatedHeartbeatIntervalMs(hello.heartbeatIntervalMs);
    this.serverCapabilities = hello.capabilities;
    this.serverVersion = hello.serverVersion;
    this.serverMaxFrameBytes = hello.maxFrameBytes;
    // canonical v1.1 门槛（fail-closed）：能力 + 版本 + 帧上限三条全中才建会话，缺一不降级
    this.stateFeedMode =
      hello.capabilities.includes(GATEWAY_CAPABILITY_CANONICAL_STATE_V1_1) &&
      wsBorsh.peerSupportsCanonicalV11(hello.serverVersion) &&
      this.effectiveMaxFrameBytes >= MIN_CANONICAL_FEED_FRAME_BYTES
        ? 'canonical'
        : 'unsupported';
    this.setState('READY');
    this.hasConnectedOnce = true;
    this.applyHeartbeatCadence();
    this.heartbeat.start();
    this.heartbeat.ping();
    this.reconnector.reset();
  }

  get negotiatedCapabilities(): readonly string[] {
    return this.serverCapabilities;
  }

  private handlePong(payload: Uint8Array): void {
    let nonce: number;
    try {
      nonce = wsBorsh.decodePayload(wsBorsh.schema.PingPongSchema, payload).nonce;
    } catch {
      return;
    }
    const sample = this.heartbeat.notePong(nonce);
    if (sample === null) return;

    this.latencyMs = sample.latencyMs;
    this.latencyRawMs = sample.rawMs;
    for (const handler of this.latencyHandlers) {
      try {
        handler(sample.latencyMs, sample.rawMs);
      } catch {}
    }
  }

  /** 丢弃上一次 HELLO 的协商结果：连接重建前后都必须回到未协商态。 */
  private resetNegotiatedServerState(): void {
    this.serverCapabilities = [];
    this.serverVersion = null;
    this.serverMaxFrameBytes = null;
    this.stateFeedMode = 'pending';
  }

  private resetLatency(): void {
    this.latencyMs = null;
    this.latencyRawMs = null;
  }

  private handleClose(): void {
    this.heartbeat.stop();
    this.negotiatedHeartbeatIntervalMs = null;
    this.resetLatency();
    this.dispatcher.reset();
    this.resetNegotiatedServerState();
    // primary 断开 = 会话整体结束，直连随之关闭（设计 §3 步骤 4）；
    // 重连后是全新会话，epoch 从 0 重来。
    this.barrier?.closeDirect();

    if (this.state === 'CLOSED') {
      return;
    }

    if (this.protocolFatal) {
      this.setState('CLOSED');
      return;
    }

    if (this.reconnector.canRetry()) {
      this.scheduleReconnect();
    } else {
      this.setState('CLOSED');
      this.handleError(new Error('Max reconnection attempts reached'));
    }
  }

  private handleError(error: Error): void {
    console.error('[borsh-client] Error:', error);

    notifyHandlers(this.errorHandlers, error, 'error');
  }

  // ========== 发送消息 ==========

  private sendHello(): void {
    this.resetNegotiatedServerState();
    const payload = wsBorsh.encodeHelloC2S({
      clientImpl: this.options.clientImpl,
      clientVersion: this.options.clientVersion,
      maxFrameBytes: this.options.maxFrameBytes,
      supportsCompression: false,
      supportsDiffSnapshot: false,
      clientCapabilities: [CLIENT_CAPABILITY_HELLO_SCREEN_INTENT_V1],
      screenIntent: this.helloScreenIntentProvider?.() ?? null,
    });
    const seq = this.nextSeq();
    this.sendRaw(wsBorsh.encodeEnvelope(wsBorsh.KIND_HELLO_C2S, payload, seq));
    this.setState('HELLO_NEGOTIATING');
  }

  /**
   * 返回值语义：
   * - `sent`：已写进当前载体
   * - `queued`：未就绪，已进入待发队列，就绪后按序 flush；无需重发
   * - `backpressure`：直连背压，整帧已排进直连队列；无需重发
   * - `overflow`：超出待发字节/帧预算，本帧未入队。有序输入（TERM_INPUT / TERM_PASTE）
   *   会丢掉**整段**已排队输入并在本未就绪周期内拒绝后续输入，避免只丢掉中间而发出残缺序列。
   */
  send(kind: number, payload: Uint8Array): ClientSendResult {
    // 老网关不认识 TERM_VIEWPORT，发过去只会换回一条 ERROR_UNKNOWN_KIND；
    // 版本未协商时先入队，就绪 flush 时再按当次 HELLO 判定一次。
    if (kind === wsBorsh.KIND_TERM_VIEWPORT && !this.supportsTermViewport) {
      return 'sent';
    }

    if (!this.isReady()) {
      return this.enqueuePending(kind, payload);
    }

    const seq = this.nextSeq();

    if (kind === wsBorsh.KIND_CANONICAL_COMMAND) {
      const maxFrameBytes = Math.min(
        wsBorsh.CANONICAL_STATE_MAX_FRAME_BYTES,
        this.effectiveMaxFrameBytes
      );
      if (payload.byteLength + wsBorsh.WS_ENVELOPE_WIRE_OVERHEAD_BYTES > maxFrameBytes) {
        throw new wsBorsh.WsBorshError(
          wsBorsh.ERROR_FRAME_TOO_LARGE,
          false,
          `canonical frame exceeds ${maxFrameBytes} bytes`
        );
      }
      const envelope = wsBorsh.encodeEnvelope(kind, payload, seq);
      return this.sendRaw(envelope) ? 'sent' : 'backpressure';
    }

    // 检查是否需要分片
    const chunkResult = wsBorsh.splitPayloadIntoChunks(payload, kind, seq, {
      maxFrameBytes: this.effectiveMaxFrameBytes,
      chunkStreamId: wsBorsh.generateChunkStreamId(),
    });

    let flushed = true;
    if (chunkResult.totalChunks === 0) {
      // 不需要分片
      const envelope = wsBorsh.encodeEnvelope(kind, payload, seq);
      flushed = this.sendRaw(envelope);
    } else {
      // 发送分片
      for (const chunk of chunkResult.chunks) {
        const chunkEnvelope = wsBorsh.encodeChunk(chunk, this.nextSeq());
        if (!this.sendRaw(chunkEnvelope)) flushed = false;
      }
    }

    return flushed ? 'sent' : 'backpressure';
  }

  /** 返回是否已真正写出；`false` 表示直连在背压中、整帧已排队等待排水。 */
  private sendRaw(data: Uint8Array): boolean {
    if (this.barrier) {
      return this.barrier.send(data) === 'sent';
    }
    this.sendPrimaryRaw(data);
    return true;
  }

  private sendPrimaryRaw(data: Uint8Array): void {
    if (this.ws?.readyState === WS_OPEN) {
      this.ws.send(data);
    }
  }

  private enqueuePending(kind: number, payload: Uint8Array): ClientSendResult {
    const outcome = this.pending.enqueue(kind, payload);
    if (outcome.status === 'queued') return 'queued';
    if (outcome.info) this.emitPendingOverflow(outcome.info);
    return 'overflow';
  }

  private emitPendingOverflow(info: PendingOverflowInfo): void {
    console.warn(`[borsh-client] pending send ${info.reason ?? 'overflow'}`, info);
    for (const handler of this.pendingOverflowHandlers) {
      try {
        handler(info);
      } catch (err) {
        console.error('[borsh-client] Pending overflow handler error:', err);
      }
    }
  }

  private flushPendingMessages(): void {
    const stale = this.pending.dropStaleOrderedInput();
    if (stale) this.emitPendingOverflow(stale);
    for (const msg of this.pending.drain()) this.send(msg.kind, msg.payload);
  }

  // ========== 直连载体（设计 §3「载体切换屏障」） ==========

  /**
   * 挂上直连载体。此刻仍走 primary：要等服务端在 primary 上发来
   * `CARRIER_SWITCH{to:'direct'}`，屏障排空缓冲并回 ACK 之后才真正切换。
   * `options.rtcSession` 把切换绑定到本次 attempt（见 `CarrierSwitchBarrier`）。
   */
  attachDirectCarrier(carrier: DirectCarrierLike, options?: AttachDirectOptions): void {
    this.ensureBarrier().attachDirect(carrier, options);
  }

  /** 主动摘掉直连（控制器放弃/停止时调用），回落 primary。 */
  detachDirectCarrier(): void {
    this.barrier?.handleDirectClose();
  }

  get activeCarrier(): ActiveCarrier {
    return this.barrier?.activeCarrier ?? 'primary';
  }

  onCarrierChange(handler: (active: ActiveCarrier) => void): () => void {
    this.carrierChangeHandlers.add(handler);
    return () => this.carrierChangeHandlers.delete(handler);
  }

  /** 切回 primary 时触发的补齐钩子（宿主注入：对已订阅 pane 重新 resume）。 */
  setResumeSubscribedPanes(fn: (() => void) | null): void {
    this.resumeSubscribedPanes = fn;
  }

  private ensureBarrier(): CarrierSwitchBarrier {
    if (this.barrier) return this.barrier;
    this.barrier = new CarrierSwitchBarrier({
      deliver: (bytes) => this.dispatcher.handleFrame(toArrayBuffer(bytes)),
      sendPrimary: (bytes) => this.sendPrimaryRaw(bytes),
      nextSeq: () => this.nextSeq(),
      onCarrierChange: (active) => {
        for (const handler of this.carrierChangeHandlers) {
          try {
            handler(active);
          } catch (err) {
            console.error('[borsh-client] Carrier change handler error:', err);
          }
        }
      },
      resumeSubscribedPanes: () => this.resumeSubscribedPanes?.(),
    });
    return this.barrier;
  }

  // ========== 心跳 ==========

  private resolveHeartbeatCadence(): HeartbeatCadence {
    return resolveHeartbeatCadence({
      hidden: typeof document !== 'undefined' && document.visibilityState === 'hidden',
      intervalMs: this.options.heartbeatIntervalMs,
      timeoutMs: this.options.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS,
      hiddenIntervalMs:
        this.options.hiddenHeartbeatIntervalMs ?? DEFAULT_HIDDEN_HEARTBEAT_INTERVAL_MS,
      hiddenTimeoutMs: this.options.hiddenHeartbeatTimeoutMs ?? DEFAULT_HIDDEN_HEARTBEAT_TIMEOUT_MS,
      explicitTimeoutMs: this.explicitPongTimeoutMs,
      negotiatedIntervalMs: this.negotiatedHeartbeatIntervalMs,
    });
  }

  private applyHeartbeatCadence(): void {
    const { intervalMs, pongTimeoutMs } = this.resolveHeartbeatCadence();
    this.heartbeat.setCadence(intervalMs, pongTimeoutMs);
  }

  private sendPingFrame(nonce: number): boolean {
    if (!this.isReady()) return false;

    const ping = {
      nonce,
      timeMs: BigInt(Date.now()),
    };

    const payload = wsBorsh.encodePayload(wsBorsh.schema.PingPongSchema, ping);
    const seq = this.nextSeq();
    const envelope = wsBorsh.encodeEnvelope(wsBorsh.KIND_PING, payload, seq);

    this.sendRaw(envelope);
    return true;
  }

  // ========== 重连 ==========

  private scheduleReconnect(): void {
    if (this.reconnector.isPending()) return;

    this.setState('RECONNECT_BACKOFF');
    this.reconnector.schedule();
  }

  private clearTimers(): void {
    this.reconnector.cancel();
    this.heartbeat.stop();
  }

  // ========== 恢复信号（visibilitychange / pageshow / online） ==========

  /**
   * 回前台 / 网络恢复的统一处置。READY 时补一次 PING，但这一次用 **RTT 推出来的短期限**
   * 武装 PONG 超时（`resolveResumeProbeTimeoutMs`）：链路是僵尸的话秒级就能发现，而不是
   * 干等常规的 30 s；期限内收到 PONG 就什么都不做，下一拍自动回到常规节奏。其余状态照旧立刻重连。
   */
  private handleResumeSignal(): void {
    if (this.state !== 'READY') {
      this.wakeReconnect();
      return;
    }
    if (!this.resumeProbeGate.allow()) return;
    // 探测没等到 PONG：这条 socket 是僵尸。只 `close()` 不够——对端已经不在，关闭握手可能
    // 迟迟等不到回应，`onclose` 也就迟迟不来。直接强制重连（摘回调、关旧 socket、立刻建连）。
    const deadlineMs = resolveResumeProbeTimeoutMs({
      medianLatencyMs: this.heartbeat.medianLatencyMs,
      pongTimeoutMs: this.heartbeat.cadence.pongTimeoutMs,
    });
    this.heartbeat.pingWithDeadline(deadlineMs, () => {
      console.warn('[borsh-client] resume probe timed out, forcing reconnect');
      this.reconnect();
    });
  }

  /** 立即重连：清空退避计数后直接建连；CLOSED 态按节流放行。 */
  private wakeReconnect(): void {
    if (this.protocolFatal) return;

    if (this.state === 'CLOSED') {
      const now = Date.now();
      if (now - this.lastVisibilityReconnectAt < VISIBILITY_RECONNECT_THROTTLE_MS) return;
      this.lastVisibilityReconnectAt = now;
      this.reconnector.reset();
      this.connect();
      return;
    }

    if (this.state === 'RECONNECT_BACKOFF') {
      this.reconnector.reset();
      this.connect();
    }
  }

  // ========== 端点切换 ==========

  /** 更新 WS 端点；已建立的连接不受影响，下次 connect/reconnect 生效 */
  updateUrl(url: string): void {
    this.options.url = url;
  }

  getUrl(): string {
    return this.options.url ?? defaultWsUrl();
  }

  // ========== 强制重连 ==========

  reconnect(): void {
    this.clearTimers();
    this.barrier?.closeDirect();
    this.resetLatency();
    this.resetNegotiatedServerState();
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.close();
      this.ws = null;
    }
    this.reconnector.reset();
    this.setState('IDLE');
    this.connect();
  }

  // ========== 工具方法 ==========

  private nextSeq(): number {
    this.seq = (this.seq + 1) % 0xffffffff;
    return this.seq;
  }
}

// 全局客户端实例
let globalClient: BorshWebSocketClient | null = null;

export function getBorshClient(): BorshWebSocketClient {
  if (!globalClient) {
    globalClient = new BorshWebSocketClient();
  }
  return globalClient;
}
