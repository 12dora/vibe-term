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
import { DEFAULT_MAX_PENDING_BYTES, DEFAULT_MAX_PENDING_FRAMES } from './pending-send-queue';
import { encodeGatewayTransportCommand } from './transport-command-encoder';
import { decodeGatewayTransportMessage } from './transport-message-decoder';
import type {
  GatewayTransport,
  GatewayTransportCapabilities,
  GatewayTransportCommand,
  GatewayTransportEvent,
  GatewayTransportEventHandler,
} from './transport-types';

interface PendingTransportCommand {
  command: GatewayTransportCommand;
  bytes: number;
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

  private readonly handlers = new Set<GatewayTransportEventHandler>();
  private readonly disposers: Array<() => void>;
  private readonly canonical: CanonicalStateClient;
  private pendingCommands: PendingTransportCommand[] = [];
  private pendingBytes = 0;
  private pendingOverflowOpen = false;
  private pendingInputAborted = false;
  private lastFeedMode: StateFeedMode = 'pending';

  constructor(readonly client: BorshWebSocketClient) {
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
      if (this.client.stateFeedMode === 'canonical') this.canonical.activate();
      else {
        // 网关太旧：canonical 会话建不起来，legacy 状态流又已下线，只能报错等宿主升级。
        this.canonical.suspend();
        this.canonical.takePendingCommands();
        this.emit({
          type: 'server-too-old',
          minVersion: wsBorsh.CANONICAL_V11_MIN_PEER_VERSION,
          serverVersion: this.client.serverVersion,
        });
      }
      this.flushPendingCommands();
    } else {
      this.canonical.suspend();
      this.syncFeedMode('pending');
    }
    this.emit({ type: 'connection-state', state });
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
      // 解码器拿不到本连接协商到的服务端版本，这里补一次（被门槛拒时通常还没收到 HELLO_S2C）。
      if (event.type === 'server-too-old' && event.serverVersion === null) {
        this.emit({ ...event, serverVersion: this.client.serverVersion });
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
      this.pendingCommands.push({ command: clonePendingCommand(command), bytes });
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
    for (const item of pending) this.sendReadyCommand(item.command);
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
