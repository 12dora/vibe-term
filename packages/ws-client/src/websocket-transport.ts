// 基于 BorshWebSocketClient 的 gateway transport：把连接事件与 S2C 帧翻译成 typed 事件流。

import { wsBorsh } from '@tmex/shared';
import { CanonicalStateClient } from './canonical-state-client';
import {
  clonePendingCommand,
  estimateCommandBytes,
  isOrderedInput,
  mergeSendResult,
} from './canonical-state-helpers';
import type {
  BorshWebSocketClient,
  ClientSendResult,
  ConnectionState,
  StateFeedMode,
} from './client';
import {
  DEFAULT_MAX_PENDING_BYTES,
  DEFAULT_MAX_PENDING_FRAMES,
  STALE_INPUT_TTL_MS,
} from './pending-send-queue';
import { encodeGatewayTransportCommand } from './transport-command-encoder';
import { decodeGatewayTransportMessage } from './transport-message-decoder';
import type {
  GatewayTransport,
  GatewayTransportCapabilities,
  GatewayTransportCommand,
  GatewayTransportEvent,
  GatewayTransportEventHandler,
  ServerTooOldSide,
} from './transport-types';

interface PendingTransportCommand {
  command: GatewayTransportCommand;
  bytes: number;
  enqueuedAt: number;
}

function onDocumentVisible(resume: () => void): () => void {
  if (typeof document === 'undefined') return () => {};
  const owner = document;
  if (
    typeof owner.addEventListener !== 'function' ||
    typeof owner.removeEventListener !== 'function'
  ) {
    return () => {};
  }
  const handler = () => {
    if (owner.visibilityState === 'visible') resume();
  };
  owner.addEventListener('visibilitychange', handler);
  return () => owner.removeEventListener('visibilitychange', handler);
}

export class WebSocketGatewayTransport implements GatewayTransport {
  readonly kind = 'websocket' as const;
  readonly sourceRoute = 'gateway' as const;
  readonly capabilities: GatewayTransportCapabilities = {
    sequencedTerminal: false,
    atomicScreen: false,
    cursorHistory: false,
    serverSelection: true,
  };

  /**
   * 已经提示过的「版本过低」，键是 `side:nodeId:version`，活到本 transport 销毁为止。
   * 只记最近一条的话，A、B 两个旧节点交替报错会连弹；入口重连后同一节点也会再弹一次。
   */
  private readonly reportedTooOld = new Set<string>();

  private readonly handlers = new Set<GatewayTransportEventHandler>();
  private readonly disposers: Array<() => void>;
  private readonly canonical: CanonicalStateClient;
  private pendingCommands: PendingTransportCommand[] = [];
  private pendingBytes = 0;
  private pendingOverflowOpen = false;
  private pendingInputAborted = false;
  private lastFeedMode: StateFeedMode = 'pending';

  constructor(
    readonly client: BorshWebSocketClient,
    private readonly now: () => number = Date.now
  ) {
    const limits = client.pendingCommandLimits ?? {
      maxBytes: DEFAULT_MAX_PENDING_BYTES,
      maxFrames: DEFAULT_MAX_PENDING_FRAMES,
    };
    this.canonical = new CanonicalStateClient({
      emit: (event) => this.emit(event),
      send: (message) => client.send(message.kind, message.payload),
      effectiveMaxFrameBytes: () =>
        client.effectiveMaxFrameBytes ?? wsBorsh.DEFAULT_MAX_FRAME_BYTES,
      onMetadataGap: () => client.reconnect?.(),
      maxPendingBytes: limits.maxBytes,
      maxPendingFrames: limits.maxFrames,
    });
    this.disposers = [
      client.onStateChange((state) => this.handleStateChange(state)),
      client.onLatency((latencyMs, rawMs) => this.emit({ type: 'latency', latencyMs, rawMs })),
      client.onMessage((message) => this.handleMessage(message.kind, message.payload)),
      client.onError((error) => this.emit({ type: 'transport-error', error })),
      client.onPendingOverflow((info) => this.emit({ type: 'pending-overflow', ...info })),
      onDocumentVisible(() => this.canonical.resumeSubscriptions()),
    ];
    if (client.isReady()) {
      this.syncFeedMode(client.stateFeedMode);
      if (client.stateFeedMode === 'canonical') this.canonical.activate();
    }
  }

  get hasConnectedOnce(): boolean {
    return this.client.hasConnectedOnce;
  }

  get latencyMs(): number | null {
    return this.client.latencyMs;
  }

  get latencyRawMs(): number | null {
    return this.client.latencyRawMs;
  }

  get serverCapabilities(): readonly string[] {
    return this.client.serverCapabilities;
  }

  get stateFeedMode(): StateFeedMode {
    return this.client.stateFeedMode;
  }

  connect(): void {
    this.client.connect();
  }

  disconnect(): void {
    this.clearPendingCommands();
    this.client.disconnect();
  }

  dispose(): void {
    this.canonical.dispose();
    this.clearPendingCommands();
    for (const dispose of this.disposers.splice(0)) dispose();
    this.handlers.clear();
  }

  getState(): ConnectionState {
    return this.client.getState();
  }

  isReady(): boolean {
    return this.client.isReady();
  }

  send(command: GatewayTransportCommand): ClientSendResult {
    if (!this.client.isReady()) return this.enqueueCommand(command);
    this.canonical.stageCommand(command);
    return this.sendReadyCommand(command);
  }

  onEvent(handler: GatewayTransportEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private emit(event: GatewayTransportEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch (error) {
        console.error('[gateway-transport] event handler failed:', error);
      }
    }
  }

  private handleStateChange(state: ConnectionState): void {
    if (state === 'READY') {
      this.syncFeedMode(this.client.stateFeedMode);
      if (this.client.stateFeedMode === 'canonical') {
        this.canonical.activate();
        // 只清入口网关那一条：节点是否升级与本次协商无关，清了会让旧节点重复弹。
        this.forgetTooOld('gateway:');
      } else {
        // 网关太旧：canonical 会话建不起来，legacy 状态流又已下线，只能报错等宿主升级。
        this.canonical.suspend();
        this.canonical.takePendingCommands();
        this.emitServerTooOld({ side: 'gateway', version: this.client.serverVersion });
      }
      this.flushPendingCommands();
    } else {
      this.canonical.suspend();
      this.syncFeedMode('pending');
    }
    this.emit({ type: 'connection-state', state });
  }

  /**
   * 同一端、同一版本只提示一次：READY + unsupported 每次重连（含切标签页唤醒的惰性重连）
   * 都会再走一遍，不去重会连弹。对端升级后会重新协商成 canonical，届时清掉这里的记忆。
   */
  private emitServerTooOld(peer: {
    side: ServerTooOldSide;
    version: string | null;
    nodeId?: string | null;
  }): void {
    const prefix = `${peer.side}:${peer.nodeId ?? ''}:`;
    const key = `${prefix}${peer.version ?? ''}`;
    if (this.reportedTooOld.has(key)) return;
    // 同一端报了另一个版本：旧记忆作废，否则它退回旧版本时不会再提示。
    this.forgetTooOld(prefix);
    this.reportedTooOld.add(key);
    this.emit({
      type: 'server-too-old',
      side: peer.side,
      minVersion: wsBorsh.CANONICAL_V11_MIN_PEER_VERSION,
      version: peer.version,
      nodeId: peer.nodeId ?? null,
    });
  }

  /** 抹掉某一端（`gateway:` / `node:<id>:`）的全部提示记忆。 */
  private forgetTooOld(prefix: string): void {
    for (const key of [...this.reportedTooOld]) {
      if (key.startsWith(prefix)) this.reportedTooOld.delete(key);
    }
  }

  private syncFeedMode(mode: StateFeedMode): void {
    const canonical = mode === 'canonical';
    this.capabilities.sequencedTerminal = canonical;
    this.capabilities.atomicScreen = canonical;
    this.capabilities.cursorHistory = canonical;
    if (this.lastFeedMode === mode) return;
    this.lastFeedMode = mode;
    this.emit({ type: 'state-feed-mode', mode });
  }

  private handleMessage(kind: number, payload: Uint8Array): void {
    if (kind === wsBorsh.KIND_CANONICAL_EVENT && this.client.stateFeedMode === 'canonical') {
      try {
        this.canonical.handleEventPayload(payload);
      } catch (error) {
        this.emit({
          type: 'transport-error',
          error: error instanceof Error ? error : new Error(String(error)),
        });
        this.emit({ type: 'rebase-required', reason: 'pane_gap' });
      }
      return;
    }
    decodeGatewayTransportMessage(kind, payload, (event) => {
      if (event.type === 'server-too-old') {
        this.emitServerTooOld({
          side: event.side,
          version: event.version,
          nodeId: event.nodeId ?? null,
        });
        return;
      }
      this.emit(event);
    });
  }

  private sendReadyCommand(command: GatewayTransportCommand): ClientSendResult {
    try {
      let result: ClientSendResult = 'sent';
      if (command.type === 'disconnect-device') {
        result = this.canonical.removeDevice(command.deviceId);
      } else {
        const canonical = this.canonical.sendCommand(command);
        if (canonical !== null) return canonical;
      }
      const message = encodeGatewayTransportCommand(command);
      return mergeSendResult(result, this.client.send(message.kind, message.payload));
    } catch (error) {
      this.emit({
        type: 'transport-error',
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return 'overflow';
    }
  }

  private enqueueCommand(command: GatewayTransportCommand): ClientSendResult {
    if (isOrderedInput(command) && this.pendingInputAborted) return 'overflow';
    let measured: { kind: number; bytes: number };
    try {
      measured = this.measureCommand(command);
    } catch (error) {
      this.emit({
        type: 'transport-error',
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return 'overflow';
    }
    const bytes = measured.bytes;
    const limits = this.client.pendingCommandLimits;
    if (
      this.pendingCommands.length < limits.maxFrames &&
      this.pendingBytes + bytes <= limits.maxBytes
    ) {
      this.canonical.stageCommand(command);
      this.pendingCommands.push({
        command: clonePendingCommand(command),
        bytes,
        enqueuedAt: this.now(),
      });
      this.pendingBytes += bytes;
      return 'queued';
    }
    let droppedFrames = 0;
    if (isOrderedInput(command)) {
      const kept: PendingTransportCommand[] = [];
      let keptBytes = 0;
      for (const pending of this.pendingCommands) {
        if (isOrderedInput(pending.command)) droppedFrames += 1;
        else {
          kept.push(pending);
          keptBytes += pending.bytes;
        }
      }
      this.pendingCommands = kept;
      this.pendingBytes = keptBytes;
      this.pendingInputAborted = true;
    }
    if (!this.pendingOverflowOpen) {
      this.pendingOverflowOpen = true;
      this.emit({
        type: 'pending-overflow',
        reason: 'overflow',
        kind: measured.kind,
        pendingFrames: this.pendingCommands.length,
        pendingBytes: this.pendingBytes,
        droppedFrames,
      });
    }
    return 'overflow';
  }

  /** 未就绪时的记账用量：canonical 覆盖的命令没有控制帧，按 canonical 载荷估算。 */
  private measureCommand(command: GatewayTransportCommand): { kind: number; bytes: number } {
    if (this.canonical.handles(command)) {
      return { kind: wsBorsh.KIND_CANONICAL_COMMAND, bytes: estimateCommandBytes(command) };
    }
    const encoded = encodeGatewayTransportCommand(command);
    return { kind: encoded.kind, bytes: encoded.payload.byteLength };
  }

  private flushPendingCommands(): void {
    const pending = this.pendingCommands;
    this.clearPendingCommands();
    const now = this.now();
    const fresh: PendingTransportCommand[] = [];
    let droppedFrames = 0;
    for (const item of pending) {
      if (isOrderedInput(item.command) && now - item.enqueuedAt > STALE_INPUT_TTL_MS) {
        droppedFrames += 1;
        continue;
      }
      fresh.push(item);
    }
    if (droppedFrames > 0) {
      this.emit({
        type: 'pending-overflow',
        reason: 'stale',
        kind: wsBorsh.KIND_TERM_INPUT,
        pendingFrames: fresh.length,
        pendingBytes: fresh.reduce((sum, item) => sum + item.bytes, 0),
        droppedFrames,
      });
    }
    for (const item of fresh) this.sendReadyCommand(item.command);
  }

  private clearPendingCommands(): void {
    this.pendingCommands = [];
    this.pendingBytes = 0;
    this.pendingOverflowOpen = false;
    this.pendingInputAborted = false;
  }
}

/** 首次使用时才解析并建立底层 client，用于宿主延迟决定 gateway 端点的场景。 */
export class LazyWebSocketGatewayTransport implements GatewayTransport {
  readonly kind = 'websocket' as const;
  readonly sourceRoute = 'gateway' as const;

  private delegateTransport: WebSocketGatewayTransport | null = null;

  constructor(private readonly resolveClient: () => BorshWebSocketClient) {}

  get capabilities(): GatewayTransportCapabilities {
    return this.delegate().capabilities;
  }

  get hasConnectedOnce(): boolean {
    return this.delegate().hasConnectedOnce;
  }

  get latencyMs(): number | null {
    return this.delegate().latencyMs;
  }

  get latencyRawMs(): number | null {
    return this.delegate().latencyRawMs;
  }

  get serverCapabilities(): readonly string[] {
    return this.delegate().serverCapabilities;
  }

  get stateFeedMode(): StateFeedMode {
    return this.delegate().stateFeedMode;
  }

  connect(): void {
    this.delegate().connect();
  }

  disconnect(): void {
    this.delegateTransport?.disconnect();
  }

  dispose(): void {
    this.delegateTransport?.dispose();
    this.delegateTransport = null;
  }

  getState(): ConnectionState {
    return this.delegate().getState();
  }

  isReady(): boolean {
    return this.delegate().isReady();
  }

  send(command: GatewayTransportCommand): ClientSendResult {
    return this.delegate().send(command);
  }

  onEvent(handler: GatewayTransportEventHandler): () => void {
    return this.delegate().onEvent(handler);
  }

  private delegate(): WebSocketGatewayTransport {
    this.delegateTransport ??= new WebSocketGatewayTransport(this.resolveClient());
    return this.delegateTransport;
  }
}
