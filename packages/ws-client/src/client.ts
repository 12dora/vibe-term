// FE Borsh WebSocket 客户端
// 门面：组合心跳、重连退避与协议分发，对外维持连接状态与订阅接口

import { wsBorsh } from '@tmex/shared';
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
  pongTimeoutMs: number;
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
      pongTimeoutMs: this.options.pongTimeoutMs,
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
      this.handleError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  disconnect(): void {
    this.setState('CLOSED');
    this.clearTimers();
    this.dispatcher.reset();
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

    if (chunkResult.totalChunks === 0) {
      // 不需要分片
      const envelope = wsBorsh.encodeEnvelope(kind, payload, seq);
      this.sendRaw(envelope);
    } else {
      // 发送分片
      for (const chunk of chunkResult.chunks) {
        const chunkEnvelope = wsBorsh.encodeChunk(chunk, this.nextSeq());
        this.sendRaw(chunkEnvelope);
      }
    }

    return true;
  }

  private sendRaw(data: Uint8Array): void {
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

export function resetBorshClient(): void {
  if (globalClient) {
    globalClient.disconnect();
    globalClient = null;
  }
}
