// 基于 BorshWebSocketClient 的 gateway transport：把连接事件与 S2C 帧翻译成 typed 事件流。

import { wsBorsh } from '@tmex/shared';
import { CanonicalStateClient } from './canonical-state-client';
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

const LEGACY_STATE_KINDS = new Set([
  wsBorsh.KIND_STATE_SNAPSHOT,
  wsBorsh.KIND_STATE_SNAPSHOT_DIFF,
  wsBorsh.KIND_SWITCH_ACK,
  wsBorsh.KIND_TERM_HISTORY,
  wsBorsh.KIND_LIVE_RESUME,
  wsBorsh.KIND_TERM_OUTPUT,
]);

function mergeSendResult(left: ClientSendResult, right: ClientSendResult): ClientSendResult {
  if (left === 'overflow' || right === 'overflow') return 'overflow';
  if (left === 'backpressure' || right === 'backpressure') return 'backpressure';
  if (left === 'queued' || right === 'queued') return 'queued';
  return 'sent';
}

function orderedInput(command: GatewayTransportCommand): boolean {
  return command.type === 'terminal-input' || command.type === 'terminal-paste';
}

// TERM_RESIZE / TERM_SYNC_SIZE 没有 canonical 等价物：后者是「焦点恢复补一次尺寸、
// 不引发 resize 循环」。两者在网关都进同一套 viewport 仲裁，但线协议必须保持区分。
function isLegacySizeCommand(command: GatewayTransportCommand): boolean {
  return command.type === 'terminal-resize' || command.type === 'terminal-sync-size';
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

function cloneCommand(command: GatewayTransportCommand): GatewayTransportCommand {
  if (command.type === 'select-pane') {
    return { ...command, selectToken: Uint8Array.from(command.selectToken) };
  }
  if (command.type === 'set-pane-subscriptions') {
    return { ...command, paneIds: [...command.paneIds] };
  }
  if (command.type === 'reorder-windows') {
    return { ...command, windowIds: [...command.windowIds] };
  }
  if (command.type === 'reorder-panes') {
    return { ...command, paneIds: [...command.paneIds] };
  }
  if (command.type === 'request-pane-screen') {
    return { ...command, requestId: Uint8Array.from(command.requestId) };
  }
  if (command.type === 'request-pane-history') {
    return {
      ...command,
      requestId: Uint8Array.from(command.requestId),
      cursor: command.cursor
        ? {
            paneEpoch: Uint8Array.from(command.cursor.paneEpoch),
            historyEpoch: Uint8Array.from(command.cursor.historyEpoch),
            beforeLine: command.cursor.beforeLine,
          }
        : null,
    };
  }
  return { ...command };
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
      client.onChunkProgress(({ originalKind }) => {
        if (
          originalKind === wsBorsh.KIND_TERM_HISTORY ||
          originalKind === wsBorsh.KIND_TERM_OUTPUT
        ) {
          this.emit({ type: 'terminal-progress' });
        }
      }),
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
        this.canonical.suspend();
        for (const command of this.canonical.takePendingCommands()) {
          this.sendReadyCommand(command);
        }
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
    if (this.client.stateFeedMode === 'canonical') {
      if (kind === wsBorsh.KIND_CANONICAL_EVENT) {
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
      if (kind === wsBorsh.KIND_STATE_SNAPSHOT) {
        try {
          this.canonical.handleLegacyOverlaySnapshot(payload);
        } catch (error) {
          this.emit({
            type: 'transport-error',
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
        return;
      }
      if (LEGACY_STATE_KINDS.has(kind)) return;
    }
    decodeGatewayTransportMessage(kind, payload, (event) => this.emit(event));
  }

  private sendReadyCommand(command: GatewayTransportCommand): ClientSendResult {
    try {
      let result: ClientSendResult = 'sent';
      if (this.client.stateFeedMode === 'canonical' && !isLegacySizeCommand(command)) {
        if (command.type === 'disconnect-device') {
          result = this.canonical.removeDevice(command.deviceId);
        } else {
          const canonical = this.canonical.sendCommand(command);
          if (canonical !== null) return canonical;
        }
      }
      const message = encodeGatewayTransportCommand(command, {
        stateFeedMode: this.client.stateFeedMode,
      });
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
    if (orderedInput(command) && this.pendingInputAborted) return 'overflow';
    let encoded: ReturnType<typeof encodeGatewayTransportCommand>;
    try {
      encoded = encodeGatewayTransportCommand(command);
    } catch (error) {
      this.emit({
        type: 'transport-error',
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return 'overflow';
    }
    const bytes = encoded.payload.byteLength;
    const limits = this.client.pendingCommandLimits;
    if (
      this.pendingCommands.length < limits.maxFrames &&
      this.pendingBytes + bytes <= limits.maxBytes
    ) {
      this.canonical.stageCommand(command);
      this.pendingCommands.push({ command: cloneCommand(command), bytes });
      this.pendingBytes += bytes;
      return 'queued';
    }
    let droppedFrames = 0;
    if (orderedInput(command)) {
      const kept: PendingTransportCommand[] = [];
      let keptBytes = 0;
      for (const pending of this.pendingCommands) {
        if (orderedInput(pending.command)) droppedFrames += 1;
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
        kind: encoded.kind,
        pendingFrames: this.pendingCommands.length,
        pendingBytes: this.pendingBytes,
        droppedFrames,
      });
    }
    return 'overflow';
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
