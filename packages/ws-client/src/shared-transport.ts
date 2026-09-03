// 宿主共享数据通道的 transport：不自建 socket，收发都交给宿主，事件由宿主 publish 回灌。

import type { ConnectionState, StateFeedMode } from './client';
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
  stateFeedMode?: StateFeedMode;
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
  let latencyRawMs: number | null = null;
  let disposed = false;
  let connectRequested = false;
  let stateFeedMode = options.stateFeedMode ?? 'canonical';
  const handlers = new Set<GatewayTransportEventHandler>();
  const capabilities = {
    sequencedTerminal: stateFeedMode === 'canonical',
    atomicScreen: stateFeedMode === 'canonical',
    cursorHistory: stateFeedMode === 'canonical',
    serverSelection: options.serverSelection ?? true,
  };

  const publish = (event: GatewayTransportEvent): void => {
    if (disposed) return;
    if (event.type === 'connection-state') {
      state = event.state;
      if (state === 'READY') connectedOnce = true;
      if (state !== 'READY') {
        latencyMs = null;
        latencyRawMs = null;
      }
    } else if (event.type === 'latency') {
      latencyMs = event.latencyMs;
      latencyRawMs = event.rawMs;
    } else if (event.type === 'state-feed-mode') {
      stateFeedMode = event.mode;
      const canonical = stateFeedMode === 'canonical';
      capabilities.sequencedTerminal = canonical;
      capabilities.atomicScreen = canonical;
      capabilities.cursorHistory = canonical;
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
    capabilities,
    get hasConnectedOnce() {
      return connectedOnce;
    },
    get latencyMs() {
      return latencyMs;
    },
    get latencyRawMs() {
      return latencyRawMs;
    },
    serverCapabilities: options.serverCapabilities ?? [],
    get stateFeedMode() {
      return stateFeedMode;
    },
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
