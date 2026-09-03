// Gateway 会话/设备/选择 状态机存储
// 参考: docs/ws-protocol/2026021403-ws-state-machines.md

import type { ServerWebSocket } from 'bun';
import type { GatewaySession } from '../gateway-session';

type SessionStateClient = GatewaySession | ServerWebSocket<unknown>;

export const DEFAULT_THROTTLE_PRUNE_INTERVAL_MS = 30_000;

export interface SessionStateStoreOptions {
  now?: () => number;
  throttlePruneIntervalMs?: number;
}

// ========== WS 连接状态机 ==========

export type WsConnectionState =
  | 'IDLE'
  | 'WS_CONNECTING'
  | 'HELLO_NEGOTIATING'
  | 'READY'
  | 'RECONNECT_BACKOFF'
  | 'CLOSED';

export interface WsConnectionContext {
  state: WsConnectionState;
  connectedAt: number | null;
  lastActivityAt: number;
  seq: number;
}

// ========== 设备连接状态机 ==========

export type DeviceConnectionState =
  | 'DETACHED'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'FAILED'
  | 'DISCONNECTING'
  | 'RECONNECTING';

export interface DeviceConnectionContext {
  state: DeviceConnectionState;
  deviceId: string;
  connectedAt: number | null;
  lastError: string | null;
  reconnectAttempts: number;
}

// ========== Bell 状态机 ==========

export interface BellThrottleContext {
  lastBellAt: number;
  throttleSeconds: number;
}

// ========== Session State 存储 ==========

export interface SessionState {
  // WS 连接状态
  wsConnection: WsConnectionContext;

  // 设备状态 (按 deviceId)
  deviceConnections: Map<string, DeviceConnectionContext>;

  // Bell 频控 (按 deviceId+paneId)
  bellThrottles: Map<string, BellThrottleContext>;

  // Notification 频控 (按 deviceId+paneId+source)
  notificationThrottles: Map<string, BellThrottleContext>;
  lastNotificationPruneAt: number;
}

export function createSessionState(): SessionState {
  const now = Date.now();
  return {
    wsConnection: {
      state: 'IDLE',
      connectedAt: null,
      lastActivityAt: now,
      seq: 0,
    },
    deviceConnections: new Map(),
    bellThrottles: new Map(),
    notificationThrottles: new Map(),
    lastNotificationPruneAt: 0,
  };
}

export class SessionStateStore {
  private states = new Map<SessionStateClient, SessionState>();
  private readonly now: () => number;
  private readonly throttlePruneIntervalMs: number;

  constructor(options: SessionStateStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.throttlePruneIntervalMs =
      options.throttlePruneIntervalMs ?? DEFAULT_THROTTLE_PRUNE_INTERVAL_MS;
  }

  create(session: SessionStateClient): SessionState {
    const state = (session as Partial<GatewaySession>).state ?? createSessionState();
    this.states.set(session, state);
    return state;
  }

  get(session: SessionStateClient): SessionState | undefined {
    return this.states.get(session);
  }

  delete(session: SessionStateClient): void {
    this.states.delete(session);
  }

  // ========== WS 连接状态操作 ==========

  transitionWsState(session: SessionStateClient, newState: WsConnectionState): boolean {
    const state = this.states.get(session);
    if (!state) return false;

    const oldState = state.wsConnection.state;

    // 验证状态转移合法性
    const validTransitions: Record<WsConnectionState, WsConnectionState[]> = {
      IDLE: ['WS_CONNECTING', 'CLOSED'],
      WS_CONNECTING: ['HELLO_NEGOTIATING', 'RECONNECT_BACKOFF', 'CLOSED'],
      HELLO_NEGOTIATING: ['READY', 'RECONNECT_BACKOFF', 'CLOSED'],
      READY: ['RECONNECT_BACKOFF', 'CLOSED'],
      RECONNECT_BACKOFF: ['WS_CONNECTING', 'CLOSED'],
      CLOSED: [],
    };

    if (!validTransitions[oldState].includes(newState)) {
      console.warn(`[session-state] Invalid WS state transition: ${oldState} -> ${newState}`);
      return false;
    }

    state.wsConnection.state = newState;

    if (newState === 'READY') {
      state.wsConnection.connectedAt = Date.now();
    }

    return true;
  }

  updateLastActivity(session: SessionStateClient): void {
    const state = this.states.get(session);
    if (state) {
      state.wsConnection.lastActivityAt = Date.now();
    }
  }

  incrementSeq(session: SessionStateClient): number {
    const state = this.states.get(session);
    if (!state) return 0;
    state.wsConnection.seq += 1;
    return state.wsConnection.seq;
  }

  // ========== 设备连接状态操作 ==========

  getOrCreateDeviceConnection(
    session: SessionStateClient,
    deviceId: string
  ): DeviceConnectionContext | undefined {
    const state = this.states.get(session);
    if (!state) return undefined;

    let ctx = state.deviceConnections.get(deviceId);
    if (!ctx) {
      ctx = {
        state: 'DETACHED',
        deviceId,
        connectedAt: null,
        lastError: null,
        reconnectAttempts: 0,
      };
      state.deviceConnections.set(deviceId, ctx);
    }
    return ctx;
  }

  transitionDeviceState(
    session: SessionStateClient,
    deviceId: string,
    newState: DeviceConnectionState
  ): boolean {
    const ctx = this.getOrCreateDeviceConnection(session, deviceId);
    if (!ctx) return false;

    const oldState = ctx.state;

    // 验证状态转移合法性
    const validTransitions: Record<DeviceConnectionState, DeviceConnectionState[]> = {
      DETACHED: ['CONNECTING'],
      CONNECTING: ['CONNECTED', 'FAILED'],
      CONNECTED: ['DISCONNECTING', 'RECONNECTING'],
      FAILED: ['CONNECTING'],
      DISCONNECTING: ['DETACHED'],
      RECONNECTING: ['CONNECTED', 'FAILED'],
    };

    if (!validTransitions[oldState].includes(newState)) {
      console.warn(
        `[session-state] Invalid device state transition: ${oldState} -> ${newState} for ${deviceId}`
      );
      return false;
    }

    ctx.state = newState;

    if (newState === 'CONNECTED') {
      ctx.connectedAt = Date.now();
      ctx.reconnectAttempts = 0;
      ctx.lastError = null;
    } else if (newState === 'FAILED') {
      ctx.reconnectAttempts += 1;
    }

    return true;
  }

  // ========== Bell 频控操作 ==========

  shouldAllowBell(
    session: SessionStateClient,
    deviceId: string,
    paneId: string,
    throttleSeconds: number
  ): boolean {
    const state = this.states.get(session);
    if (!state) return false;

    const key = `${deviceId}:${paneId}`;
    const now = Date.now();

    let ctx = state.bellThrottles.get(key);
    if (!ctx) {
      ctx = {
        lastBellAt: 0,
        throttleSeconds,
      };
      state.bellThrottles.set(key, ctx);
    }

    const throttleMs = throttleSeconds * 1000;
    if (now - ctx.lastBellAt < throttleMs) {
      return false; // 在频控期内
    }

    ctx.lastBellAt = now;
    ctx.throttleSeconds = throttleSeconds;
    return true;
  }

  shouldAllowNotification(
    session: SessionStateClient,
    deviceId: string,
    paneId: string,
    source: string,
    throttleSeconds: number
  ): boolean {
    const state = this.states.get(session);
    if (!state) return false;

    const key = `${deviceId}:${paneId}:${source}`;
    const now = this.now();
    this.pruneNotificationThrottles(state, now, key);

    let ctx = state.notificationThrottles.get(key);
    if (!ctx) {
      ctx = {
        lastBellAt: 0,
        throttleSeconds,
      };
      state.notificationThrottles.set(key, ctx);
    }

    const throttleMs = throttleSeconds * 1000;
    if (now - ctx.lastBellAt < throttleMs) {
      ctx.throttleSeconds = throttleSeconds;
      return false;
    }

    ctx.lastBellAt = now;
    ctx.throttleSeconds = throttleSeconds;
    return true;
  }

  private pruneNotificationThrottles(state: SessionState, now: number, keepKey?: string): void {
    if (now - state.lastNotificationPruneAt < this.throttlePruneIntervalMs) return;
    state.lastNotificationPruneAt = now;
    for (const [key, ctx] of state.notificationThrottles) {
      if (key === keepKey) continue;
      if (now - ctx.lastBellAt >= ctx.throttleSeconds * 1000) {
        state.notificationThrottles.delete(key);
      }
    }
  }

  // ========== 清理操作 ==========

  cleanupDevice(session: SessionStateClient, deviceId: string): void {
    const state = this.states.get(session);
    if (!state) return;

    state.deviceConnections.delete(deviceId);

    // 清理该设备的所有 bell 记录
    for (const key of state.bellThrottles.keys()) {
      if (key.startsWith(`${deviceId}:`)) {
        state.bellThrottles.delete(key);
      }
    }

    for (const key of state.notificationThrottles.keys()) {
      if (key.startsWith(`${deviceId}:`)) {
        state.notificationThrottles.delete(key);
      }
    }
  }

  cleanup(session: SessionStateClient): void {
    this.states.delete(session);
  }
}

// 全局单例
export const sessionStateStore = new SessionStateStore();
