// 基于 BorshWebSocketClient 的 gateway transport：把连接事件与 S2C 帧翻译成 typed 事件流。

import { wsBorsh } from '@tmex/shared';
import type { BorshWebSocketClient, ClientSendResult, ConnectionState } from './client';
import { encodeGatewayTransportCommand } from './transport-command-encoder';
import { decodeGatewayTransportMessage } from './transport-message-decoder';
import type {
  GatewayTransport,
  GatewayTransportCapabilities,
  GatewayTransportCommand,
  GatewayTransportEvent,
  GatewayTransportEventHandler,
} from './transport-types';

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

  constructor(readonly client: BorshWebSocketClient) {
    this.disposers = [
      client.onStateChange((state) => this.emit({ type: 'connection-state', state })),
      client.onLatency((latencyMs, rawMs) => this.emit({ type: 'latency', latencyMs, rawMs })),
      client.onChunkProgress(({ originalKind }) => {
        if (
          originalKind === wsBorsh.KIND_TERM_HISTORY ||
          originalKind === wsBorsh.KIND_TERM_OUTPUT
        ) {
          this.emit({ type: 'terminal-progress' });
        }
      }),
      client.onMessage((message) =>
        decodeGatewayTransportMessage(message.kind, message.payload, (event) => this.emit(event))
      ),
      client.onError((error) => this.emit({ type: 'transport-error', error })),
      client.onPendingOverflow((info) => this.emit({ type: 'pending-overflow', ...info })),
    ];
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

  connect(): void {
    this.client.connect();
  }

  disconnect(): void {
    this.client.disconnect();
  }

  dispose(): void {
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
    const message = encodeGatewayTransportCommand(command);
    return this.client.send(message.kind, message.payload);
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
}

/** 首次使用时才解析并建立底层 client，用于宿主延迟决定 gateway 端点的场景。 */
export class LazyWebSocketGatewayTransport implements GatewayTransport {
  readonly kind = 'websocket' as const;
  readonly sourceRoute = 'gateway' as const;
  readonly capabilities: GatewayTransportCapabilities = {
    sequencedTerminal: false,
    atomicScreen: false,
    cursorHistory: false,
    serverSelection: true,
  };

  private delegateTransport: WebSocketGatewayTransport | null = null;

  constructor(private readonly resolveClient: () => BorshWebSocketClient) {}

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
