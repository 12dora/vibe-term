// 宿主共享数据通道的 transport：不自建 socket，收发都交给宿主，事件由宿主 publish 回灌。

import type { ConnectionState } from './client';
import type {
  GatewayTransport,
  GatewayTransportCommand,
  GatewayTransportEvent,
  GatewayTransportEventHandler,
  GatewayTransportSourceRoute,
} from './transport-types';

export interface SharedGatewayTransportOptions {
  initialState?: ConnectionState;
  sourceRoute?: GatewayTransportSourceRoute;
  serverCapabilities?: readonly string[];
  serverSelection?: boolean;
  onConnect?: () => void;
  onDisconnect?: () => void;
  // biome-ignore lint/suspicious/noConfusingVoidType: void accepts fire-and-forget owners; false is the explicit rejection signal
  onCommand: (command: GatewayTransportCommand) => boolean | void;
}

export interface SharedGatewayTransport extends GatewayTransport {
  readonly kind: 'shared';
  publish(event: GatewayTransportEvent): void;
}

export function createSharedGatewayTransport(
  options: SharedGatewayTransportOptions
): SharedGatewayTransport {
  let state = options.initialState ?? 'IDLE';
  let connectedOnce = state === 'READY';
  let latencyMs: number | null = null;
  let disposed = false;
  let connectRequested = false;
  const handlers = new Set<GatewayTransportEventHandler>();

  const publish = (event: GatewayTransportEvent): void => {
    if (disposed) return;
    if (event.type === 'connection-state') {
      state = event.state;
      if (state === 'READY') connectedOnce = true;
      if (state !== 'READY') latencyMs = null;
    } else if (event.type === 'latency') {
      latencyMs = event.latencyMs;
    }
    for (const handler of handlers) {
      try {
        handler(event);
      } catch (error) {
        console.error('[shared-gateway-transport] event handler failed:', error);
      }
    }
  };

  return {
    kind: 'shared',
    sourceRoute: options.sourceRoute ?? 'unknown',
    capabilities: {
      sequencedTerminal: true,
      atomicScreen: true,
      cursorHistory: true,
      serverSelection: options.serverSelection ?? true,
    },
    get hasConnectedOnce() {
      return connectedOnce;
    },
    get latencyMs() {
      return latencyMs;
    },
    serverCapabilities: options.serverCapabilities ?? [],
    connect() {
      if (disposed || state === 'READY' || state === 'WS_CONNECTING') return;
      connectRequested = true;
      publish({ type: 'connection-state', state: 'WS_CONNECTING' });
      options.onConnect?.();
    },
    disconnect() {
      if (disposed || state === 'CLOSED') return;
      if (connectRequested || state === 'READY') options.onDisconnect?.();
      connectRequested = false;
      publish({ type: 'connection-state', state: 'CLOSED' });
    },
    dispose() {
      if (disposed) return;
      if (connectRequested || state === 'READY') options.onDisconnect?.();
      connectRequested = false;
      disposed = true;
      state = 'CLOSED';
      handlers.clear();
    },
    getState: () => state,
    isReady: () => state === 'READY',
    send(command) {
      if (disposed) return false;
      return options.onCommand(command) !== false;
    },
    onEvent(handler) {
      if (disposed) return () => {};
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    publish,
  };
}
