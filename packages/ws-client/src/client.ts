// FE Borsh WebSocket 客户端
// 门面：组合心跳、重连退避与协议分发，对外维持连接状态与订阅接口

import { wsBorsh } from '@tmex/shared';
import {
  type ActiveCarrier,
  type AttachDirectOptions,
  CarrierSwitchBarrier,
  type DirectCarrierLike,
} from './carrier-switch';
import { HeartbeatController } from './heartbeat-controller';
import { type BorshMessage, type ChunkProgress, ProtocolDispatcher } from './protocol-dispatcher';
import { ReconnectController } from './reconnect-controller';

// ========== 配置 ==========

// 惰性求值：允许在非浏览器环境 import 本模块，也允许宿主在构造时注入自定义端点
export function defaultWsUrl(): string {
  return `${typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${typeof window !== 'undefined' ? window.location.host : ''}/ws`;
}

// WHATWG 规定的 readyState 取值。用本地常量而非全局 WebSocket 的静态属性：
// 注入的 transport 不必是 WebSocket 的实例，非浏览器环境下全局 WebSocket 也未必存在。
const WS_CONNECTING = 0;
const WS_OPEN = 1;

/**
 * 浏览器 WebSocket 的最小结构子集。宿主可据此把 ws-borsh 帧承载在自定义通道上，
 * 只要实现遵循 WHATWG 的 readyState 取值约定。
 */
export interface WebSocketLike {
  readonly readyState: number;
  binaryType: 'blob' | 'arraybuffer';
  onopen: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: ArrayBuffer | string }) => void) | null;
  onclose: ((event?: unknown) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  send(data: ArrayBufferLike | ArrayBufferView | string): void;
  close(code?: number, reason?: string): void;
}

export type SocketFactory = (url: string) => WebSocketLike;

// DOM 的 onmessage 事件参数是 MessageEvent，在 strictFunctionTypes 下与 WebSocketLike 的
// 结构化参数互不可赋值（参数逆变）。把这层不兼容收敛在此一处断言，不向接口撒 any。
const defaultSocketFactory: SocketFactory = (url) => new WebSocket(url) as unknown as WebSocketLike;

/** 屏障内部一律用 Uint8Array；交回 dispatcher 时零拷贝还原成 ArrayBuffer。 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
}

const DEFAULT_OPTIONS: BorshClientOptions = {
  clientImpl: 'tmex-fe',
  clientVersion: '0.1.0',
  maxFrameBytes: 1048576, // 1MB
  reconnectDelayMs: 1000,
  maxReconnectAttempts: 5,
  heartbeatIntervalMs: 5000,
  pongTimeoutMs: 10000,
};

const VISIBILITY_RECONNECT_THROTTLE_MS = 5000;

// ========== 类型定义 ==========

export interface BorshClientOptions {
  clientImpl: string;
  clientVersion: string;
  maxFrameBytes: number;
  reconnectDelayMs: number;
  maxReconnectAttempts: number;
  heartbeatIntervalMs: number;
  /** PING 之后等待 PONG 的上限，超时则关闭连接触发重连 */
  pongTimeoutMs?: number;
  /** WS 端点；缺省时连接当刻按 window.location 推导（defaultWsUrl） */
  url?: string;
  /** 自定义 transport 工厂；缺省为 `new WebSocket(url)` */
  socketFactory?: SocketFactory;
}

export type ConnectionState =
  | 'IDLE'
  | 'WS_CONNECTING'
  | 'HELLO_NEGOTIATING'
  | 'READY'
  | 'RECONNECT_BACKOFF'
  | 'CLOSED';

export type { BorshMessage, ChunkProgress } from './protocol-dispatcher';

export type MessageHandler = (message: BorshMessage) => void;
export type StateChangeHandler = (state: ConnectionState) => void;
export type ErrorHandler = (error: Error) => void;
export type ChunkProgressHandler = (progress: ChunkProgress) => void;

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

  // 回调
  private messageHandlers: Set<MessageHandler> = new Set();
  private stateChangeHandlers: Set<StateChangeHandler> = new Set();
  private errorHandlers: Set<ErrorHandler> = new Set();
  private latencyHandlers: Set<(ms: number) => void> = new Set();
  private chunkProgressHandlers: Set<ChunkProgressHandler> = new Set();

  // visibilitychange
  private visibilityHandler: (() => void) | null = null;
  private lastVisibilityReconnectAt = 0;

  // 直连载体（F3-1）：懒建，未挂载直连时整条路径与之前完全一致
  private barrier: CarrierSwitchBarrier | null = null;
  private carrierChangeHandlers: Set<(active: ActiveCarrier) => void> = new Set();
  private resumeSubscribedPanes: (() => void) | null = null;

  // 待发送队列
  private pendingMessages: Array<{ kind: number; payload: Uint8Array }> = [];
  private maxPendingMessages = 100;

  hasConnectedOnce = false;
  latencyMs: number | null = null;
  // 服务端 HELLO_S2C 协商的能力集（消费方按 featureset 判定；多实例宿主按连接读取）
  serverCapabilities: readonly string[] = [];

  constructor(options: Partial<BorshClientOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };

    this.dispatcher = new ProtocolDispatcher({
      onMessage: (message) => this.dispatchMessage(message),
      onChunkProgress: (progress) => this.dispatchChunkProgress(progress),
      onHello: (capabilities) => this.handleHelloNegotiated(capabilities),
      onHelloFailure: (error) => this.handleError(error),
      onPong: () => this.handlePong(),
    });

    this.reconnector = new ReconnectController({
      delayMs: this.options.reconnectDelayMs,
      maxAttempts: this.options.maxReconnectAttempts,
      onReconnect: () => this.connect(),
      onSchedule: ({ attempt, delayMs }) => {
        console.log(`[borsh-client] Reconnecting in ${delayMs}ms (attempt ${attempt})`);
      },
    });

    this.heartbeat = new HeartbeatController({
      intervalMs: this.options.heartbeatIntervalMs,
      pongTimeoutMs: this.options.pongTimeoutMs ?? DEFAULT_OPTIONS.pongTimeoutMs ?? 10000,
      sendPing: () => this.sendPingFrame(),
      onPongTimeout: () => this.ws?.close(),
    });
  }

  // ========== 状态管理 ==========

  private setState(newState: ConnectionState): void {
    if (this.state === newState) return;

    console.log(`[borsh-client] State: ${this.state} -> ${newState}`);
    this.state = newState;

    for (const handler of this.stateChangeHandlers) {
      try {
        handler(newState);
      } catch (err) {
        console.error('[borsh-client] State change handler error:', err);
      }
    }

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

  onLatency(handler: (ms: number) => void): () => void {
    this.latencyHandlers.add(handler);
    return () => this.latencyHandlers.delete(handler);
  }

  onChunkProgress(handler: ChunkProgressHandler): () => void {
    this.chunkProgressHandlers.add(handler);
    return () => this.chunkProgressHandlers.delete(handler);
  }

  // ========== 连接管理 ==========

  connect(): void {
    this.setupVisibilityListener();

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
    this.dispatcher.reset();
    this.barrier?.closeDirect();
    this.latencyMs = null;

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
  }

  // ========== 消息处理 ==========

  private dispatchMessage(message: BorshMessage): void {
    for (const handler of this.messageHandlers) {
      try {
        handler(message);
      } catch (err) {
        console.error('[borsh-client] Message handler error:', err);
      }
    }
  }

  private dispatchChunkProgress(progress: ChunkProgress): void {
    for (const handler of this.chunkProgressHandlers) {
      try {
        handler(progress);
      } catch (err) {
        console.error('[borsh-client] Chunk progress handler error:', err);
      }
    }
  }

  private handleHelloNegotiated(capabilities: readonly string[]): void {
    this.serverCapabilities = capabilities;

    this.setState('READY');
    this.hasConnectedOnce = true;
    this.heartbeat.start();
    this.heartbeat.ping();
    this.reconnector.reset();
  }

  private handlePong(): void {
    const rtt = this.heartbeat.notePong();
    if (rtt === null) return;

    this.latencyMs = rtt;
    for (const handler of this.latencyHandlers) {
      try {
        handler(rtt);
      } catch {}
    }
  }

  private handleClose(): void {
    this.heartbeat.stop();
    this.dispatcher.reset();
    // primary 断开 = 会话整体结束，直连随之关闭（设计 §3 步骤 4）；
    // 重连后是全新会话，epoch 从 0 重来。
    this.barrier?.closeDirect();

    if (this.state === 'CLOSED') {
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

    for (const handler of this.errorHandlers) {
      try {
        handler(error);
      } catch (err) {
        console.error('[borsh-client] Error handler error:', err);
      }
    }
  }

  // ========== 发送消息 ==========

  private sendHello(): void {
    const hello = {
      clientImpl: this.options.clientImpl,
      clientVersion: this.options.clientVersion,
      maxFrameBytes: this.options.maxFrameBytes,
      supportsCompression: false,
      supportsDiffSnapshot: false,
    };

    const payload = wsBorsh.encodePayload(wsBorsh.schema.HelloC2SSchema, hello);
    const seq = this.nextSeq();
    const envelope = wsBorsh.encodeEnvelope(wsBorsh.KIND_HELLO_C2S, payload, seq);

    this.sendRaw(envelope);
    this.setState('HELLO_NEGOTIATING');
  }

  /**
   * 返回值语义：`true` = 已写进当前载体；`false` = **未立刻上线**（未就绪时进
   * `pendingMessages`，或直连处于背压、整帧已排进直连队列）。两种情况数据都没丢，
   * 调用方不需要也不应该重发。
   */
  send(kind: number, payload: Uint8Array): boolean {
    if (!this.isReady()) {
      // 未就绪，加入队列
      if (this.pendingMessages.length < this.maxPendingMessages) {
        this.pendingMessages.push({ kind, payload });
      }
      return false;
    }

    const seq = this.nextSeq();

    // 检查是否需要分片
    const chunkResult = wsBorsh.splitPayloadIntoChunks(payload, kind, seq, {
      maxFrameBytes: this.options.maxFrameBytes,
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

    return flushed;
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

  private flushPendingMessages(): void {
    while (this.pendingMessages.length > 0) {
      const msg = this.pendingMessages.shift();
      if (msg) {
        this.send(msg.kind, msg.payload);
      }
    }
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

  private sendPingFrame(): boolean {
    if (!this.isReady()) return false;

    const ping = {
      nonce: Math.floor(Math.random() * 0xffffffff),
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

  // ========== visibilitychange ==========

  private setupVisibilityListener(): void {
    if (this.visibilityHandler) return;
    if (typeof document === 'undefined') return;

    const handler = () => {
      if (document.visibilityState !== 'visible') return;

      this.heartbeat.clearPongTimeout();

      if (this.state === 'CLOSED') {
        const now = Date.now();
        if (now - this.lastVisibilityReconnectAt < VISIBILITY_RECONNECT_THROTTLE_MS) return;
        this.lastVisibilityReconnectAt = now;
        this.reconnector.reset();
        this.connect();
      } else if (this.state === 'RECONNECT_BACKOFF') {
        this.reconnector.reset();
        this.connect();
      } else if (this.state === 'READY') {
        this.heartbeat.ping();
      }
    };

    document.addEventListener('visibilitychange', handler);
    this.visibilityHandler = handler;
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
    this.latencyMs = null;
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
