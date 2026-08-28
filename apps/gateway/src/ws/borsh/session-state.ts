// Gateway 会话/设备/选择 状态机存储
// 参考: docs/ws-protocol/2026021403-ws-state-machines.md

import { wsBorsh } from '@tmex/shared';
import type { ServerWebSocket } from 'bun';
import type { GatewaySession } from '../gateway-session';
import { encodeCanonicalEvent, sendToClient } from './codec-borsh';

type SessionStateClient = GatewaySession | ServerWebSocket<unknown>;

export const DEFAULT_OUTPUT_GATE_MAX_FRAMES = 1000;
export const DEFAULT_OUTPUT_GATE_MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_THROTTLE_PRUNE_INTERVAL_MS = 30_000;

export interface SessionStateStoreOptions {
  now?: () => number;
  maxOutputBufferBytes?: number;
  maxOutputBufferFrames?: number;
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

// ========== 选择事务状态机 ==========

export type SelectTransactionState =
  | 'STABLE'
  | 'SELECTING'
  | 'ACKED'
  | 'HISTORY_APPLIED'
  | 'LIVE'
  | 'SELECT_FAILED';

export interface SelectTransactionContext {
  state: SelectTransactionState;
  deviceId: string;
  windowId: string | null;
  paneId: string | null;
  selectToken: Uint8Array | null;
  startedAt: number;
  ackedAt: number | null;
  historyAppliedAt: number | null;
  liveResumedAt: number | null;
}

// ========== 输出门控状态机 ==========

export type OutputGateState = 'FLOWING' | 'BUFFERING';

export interface OutputGateContext {
  state: OutputGateState;
  buffer: Uint8Array[];
  bufferBytes: number;
  maxBufferSize: number;
  maxBufferBytes: number;
  overflowed: boolean;
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

  // 选择事务 (按 deviceId)
  selectTransactions: Map<string, SelectTransactionContext>;

  // 输出门控 (按 deviceId)
  outputGates: Map<string, OutputGateContext>;

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
    selectTransactions: new Map(),
    outputGates: new Map(),
    bellThrottles: new Map(),
    notificationThrottles: new Map(),
    lastNotificationPruneAt: 0,
  };
}

export class SessionStateStore {
  private states = new Map<SessionStateClient, SessionState>();
  private readonly now: () => number;
  private readonly maxOutputBufferBytes: number;
  private readonly maxOutputBufferFrames: number;
  private readonly throttlePruneIntervalMs: number;

  constructor(options: SessionStateStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxOutputBufferBytes = options.maxOutputBufferBytes ?? DEFAULT_OUTPUT_GATE_MAX_BYTES;
    this.maxOutputBufferFrames = options.maxOutputBufferFrames ?? DEFAULT_OUTPUT_GATE_MAX_FRAMES;
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

  // ========== 选择事务状态操作 ==========

  getOrCreateSelectTransaction(
    session: SessionStateClient,
    deviceId: string
  ): SelectTransactionContext | undefined {
    const state = this.states.get(session);
    if (!state) return undefined;

    let ctx = state.selectTransactions.get(deviceId);
    if (!ctx) {
      ctx = {
        state: 'STABLE',
        deviceId,
        windowId: null,
        paneId: null,
        selectToken: null,
        startedAt: 0,
        ackedAt: null,
        historyAppliedAt: null,
        liveResumedAt: null,
      };
      state.selectTransactions.set(deviceId, ctx);
    }
    return ctx;
  }

  startSelectTransaction(
    session: SessionStateClient,
    deviceId: string,
    windowId: string,
    paneId: string,
    selectToken: Uint8Array
  ): boolean {
    const ctx = this.getOrCreateSelectTransaction(session, deviceId);
    if (!ctx) return false;

    // 重置之前的状态
    ctx.state = 'SELECTING';
    ctx.windowId = windowId;
    ctx.paneId = paneId;
    ctx.selectToken = selectToken;
    ctx.startedAt = Date.now();
    ctx.ackedAt = null;
    ctx.historyAppliedAt = null;
    ctx.liveResumedAt = null;

    // 同时启动输出门控
    this.startOutputBuffering(session, deviceId);

    return true;
  }

  transitionSelectState(
    session: SessionStateClient,
    deviceId: string,
    newState: SelectTransactionState
  ): boolean {
    const ctx = this.getOrCreateSelectTransaction(session, deviceId);
    if (!ctx) return false;

    const oldState = ctx.state;

    // 验证状态转移合法性
    const validTransitions: Record<SelectTransactionState, SelectTransactionState[]> = {
      STABLE: ['SELECTING'],
      SELECTING: ['ACKED', 'SELECT_FAILED'],
      ACKED: ['HISTORY_APPLIED', 'LIVE', 'SELECT_FAILED'],
      HISTORY_APPLIED: ['LIVE', 'SELECT_FAILED'],
      LIVE: ['STABLE', 'SELECTING'],
      SELECT_FAILED: ['STABLE', 'SELECTING'],
    };

    if (!validTransitions[oldState].includes(newState)) {
      console.warn(
        `[session-state] Invalid select state transition: ${oldState} -> ${newState} for ${deviceId}`
      );
      return false;
    }

    ctx.state = newState;

    const now = Date.now();
    switch (newState) {
      case 'ACKED':
        ctx.ackedAt = now;
        break;
      case 'HISTORY_APPLIED':
        ctx.historyAppliedAt = now;
        break;
      case 'LIVE':
        ctx.liveResumedAt = now;
        break;
      case 'STABLE':
        ctx.selectToken = null;
        break;
    }

    return true;
  }

  // ========== 输出门控操作 ==========

  getOrCreateOutputGate(
    session: SessionStateClient,
    deviceId: string
  ): OutputGateContext | undefined {
    const state = this.states.get(session);
    if (!state) return undefined;

    let ctx = state.outputGates.get(deviceId);
    if (!ctx) {
      ctx = {
        state: 'FLOWING',
        buffer: [],
        bufferBytes: 0,
        maxBufferSize: this.maxOutputBufferFrames,
        maxBufferBytes: this.maxOutputBufferBytes,
        overflowed: false,
      };
      state.outputGates.set(deviceId, ctx);
    }
    return ctx;
  }

  startOutputBuffering(session: SessionStateClient, deviceId: string): void {
    const ctx = this.getOrCreateOutputGate(session, deviceId);
    if (!ctx) return;

    ctx.state = 'BUFFERING';
    ctx.buffer = [];
    ctx.bufferBytes = 0;
    ctx.overflowed = false;
  }

  stopOutputBuffering(session: SessionStateClient, deviceId: string): Uint8Array[] {
    const ctx = this.getOrCreateOutputGate(session, deviceId);
    if (!ctx) return [];

    ctx.state = 'FLOWING';
    const buffered = [...ctx.buffer];
    ctx.buffer = [];
    ctx.bufferBytes = 0;
    ctx.overflowed = false;
    return buffered;
  }

  bufferOutput(session: SessionStateClient, deviceId: string, data: Uint8Array): boolean {
    const ctx = this.getOrCreateOutputGate(session, deviceId);
    if (!ctx || ctx.state !== 'BUFFERING' || ctx.overflowed) return false;

    const nextBytes = ctx.bufferBytes + data.byteLength;
    if (ctx.buffer.length >= ctx.maxBufferSize || nextBytes > ctx.maxBufferBytes) {
      this.overflowOutputGate(session, deviceId, ctx);
      return false;
    }

    ctx.buffer.push(data);
    ctx.bufferBytes = nextBytes;
    return true;
  }

  private overflowOutputGate(
    session: SessionStateClient,
    deviceId: string,
    ctx: OutputGateContext
  ): void {
    ctx.buffer = [];
    ctx.bufferBytes = 0;
    ctx.overflowed = true;
    console.warn(`[session-state] Output buffer overflow for ${deviceId}`);
    this.emitResourceExhaustedGap(session);
  }

  private emitResourceExhaustedGap(session: SessionStateClient): void {
    const owner = session as Partial<GatewaySession>;
    const borshState = owner.borshState;
    if (!borshState) return;
    const carrier = owner.activeCarrier;
    if (!carrier) return;
    try {
      const frame = encodeCanonicalEvent(
        {
          SourceGap: {
            reason: wsBorsh.SOURCE_GAP_REASON_RESOURCE_EXHAUSTED,
            scope: { Stream: {} },
          },
        },
        borshState.seqGen(),
        borshState.maxFrameBytes
      );
      sendToClient(carrier, frame, borshState.maxFrameBytes);
    } catch (error) {
      console.warn('[session-state] Failed to emit SourceGap after output overflow:', error);
    }
  }

  isBuffering(session: SessionStateClient, deviceId: string): boolean {
    const ctx = this.getOrCreateOutputGate(session, deviceId);
    return ctx?.state === 'BUFFERING';
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
    state.selectTransactions.delete(deviceId);
    state.outputGates.delete(deviceId);

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
