// `/mesh/ws` 的浏览器侧订阅：Borsh 解出 NODE_EVENT（节点上下线 / 到达路径 / inventory）
// 与 RTC_SIGNAL（Phase 3 的直连信令，这里只做转交）。
//
// 该连接**只属于 entry（self）**：mesh 事件是入口对整张 mesh 的视图，不按 node 分身。

import { handleGlobalUnauthorized } from '@tmex/api-client/auth/index';
import { wsBorsh } from '@tmex/shared';
import { encodeBase64url } from '@tmex/shared/auth';

/** 会话在连接期间失效时服务端的关闭码（B2-2b 契约）。 */
export const WS_UNAUTHORIZED_CLOSE_CODE = 4401;

export type NodeEventStatus = 'online' | 'offline' | 'revoked';
export type NodeReach = 'lan' | 'relay' | null;

export interface NodeEventPayload {
  nodeId: string;
  status: NodeEventStatus;
  reach: NodeReach;
  /** node.status 上报的 inventory（JSON 字符串已解析）；不可解析时保留原串。 */
  inventory: unknown;
}

export interface RtcSignalPayload {
  rtcSession: string;
  from: 'browser' | 'node';
  to: string;
  sdp: string | null;
  candidate: string | null;
}

/** hub 收到 redeem 后经 entry 转发给发起页面的证书（设计 §2 步骤 3）。 */
export interface EnrollRedeemedPayload {
  /** base64url，32 字节：本次 enrollment 的公钥，页面据此匹配 pending。 */
  enrollPk: string;
  /** base64url(borsh(Certificate)) */
  certificate: string;
  /** base64url，64 字节 */
  certSig: string;
  /** 32 位小写 hex */
  nodeId: string;
}

export type MeshFrame =
  | { kind: 'node-event'; payload: NodeEventPayload }
  | { kind: 'rtc-signal'; payload: RtcSignalPayload }
  | { kind: 'enroll-redeemed'; payload: EnrollRedeemedPayload };

/** `ENROLL_REDEEMED`（B2-5）：线上是原始字节，页面侧一律转成 base64url 再走证书匹配。 */
export const KIND_ENROLL_REDEEMED = wsBorsh.KIND_ENROLL_REDEEMED;

/**
 * 枚举严格 allowlist：未知值一律让整帧作废。
 * 滚动升级时把未知 status 当成 `online`、把未知来源当成 `browser` 会把离线节点标成在线、
 * 把不明信令交给直连控制器（见 F4-3 评审 Minor）。
 */
function statusFromWire(status: number): NodeEventStatus | null {
  if (status === wsBorsh.NODE_EVENT_STATUS_ONLINE) return 'online';
  if (status === wsBorsh.NODE_EVENT_STATUS_OFFLINE) return 'offline';
  if (status === wsBorsh.NODE_EVENT_STATUS_REVOKED) return 'revoked';
  return null;
}

function fromFromWire(from: number): 'browser' | 'node' | null {
  if (from === wsBorsh.RTC_SIGNAL_FROM_BROWSER) return 'browser';
  if (from === wsBorsh.RTC_SIGNAL_FROM_NODE) return 'node';
  return null;
}

function reachFromWire(reach: string | null): NodeReach {
  return reach === 'lan' || reach === 'relay' ? reach : null;
}

function parseInventory(raw: string | null): unknown {
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/**
 * 解一帧 mesh WS 二进制；协议版本不符、未知枚举值、非 mesh kind 或畸形帧一律返回 `null`
 * （不抛，避免打断收流）。
 */
export function decodeMeshFrame(data: Uint8Array): MeshFrame | null {
  try {
    const envelope = wsBorsh.decodeEnvelope(data);
    if (envelope.version !== wsBorsh.CURRENT_VERSION) return null;
    if (envelope.kind === wsBorsh.KIND_NODE_EVENT) {
      const payload = wsBorsh.decodePayload(wsBorsh.schema.NodeEventSchema, envelope.payload);
      const status = statusFromWire(payload.status);
      if (!status) return null;
      return {
        kind: 'node-event',
        payload: {
          nodeId: payload.nodeId,
          status,
          reach: reachFromWire(payload.reach),
          inventory: parseInventory(payload.inventory),
        },
      };
    }
    if (envelope.kind === wsBorsh.KIND_RTC_SIGNAL) {
      const payload = wsBorsh.decodePayload(wsBorsh.schema.RtcSignalSchema, envelope.payload);
      const from = fromFromWire(payload.from);
      if (!from) return null;
      return {
        kind: 'rtc-signal',
        payload: {
          rtcSession: payload.rtcSession,
          from,
          to: payload.to,
          sdp: payload.sdp,
          candidate: payload.candidate,
        },
      };
    }
    if (envelope.kind === KIND_ENROLL_REDEEMED) {
      const payload = wsBorsh.decodePayload(wsBorsh.schema.EnrollRedeemedSchema, envelope.payload);
      if (
        payload.enrollPk.length === 0 ||
        payload.certificate.length === 0 ||
        payload.certSig.length !== 64
      ) {
        return null;
      }
      return {
        kind: 'enroll-redeemed',
        payload: {
          enrollPk: encodeBase64url(payload.enrollPk),
          certificate: encodeBase64url(payload.certificate),
          certSig: encodeBase64url(payload.certSig),
          nodeId: payload.nodeId,
        },
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** 编一帧 RTC_SIGNAL（Phase 3 的 `DirectCarrierController` 用它上行）。 */
export function encodeRtcSignal(payload: RtcSignalPayload, seq = 0): Uint8Array {
  const body = wsBorsh.encodePayload(wsBorsh.schema.RtcSignalSchema, {
    rtcSession: payload.rtcSession,
    from: payload.from === 'node' ? wsBorsh.RTC_SIGNAL_FROM_NODE : wsBorsh.RTC_SIGNAL_FROM_BROWSER,
    to: payload.to,
    sdp: payload.sdp,
    candidate: payload.candidate,
  });
  return wsBorsh.encodeEnvelope(wsBorsh.KIND_RTC_SIGNAL, body, seq);
}

/** `/mesh/ws` 的绝对地址（始终指向 entry 自身，不带 `/n/:id` 前缀）。 */
export function meshWsUrl(location?: { protocol: string; host: string }): string {
  const loc =
    location ?? (globalThis as { location?: { protocol: string; host: string } }).location;
  if (!loc) return '/mesh/ws';
  const scheme = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${loc.host}/mesh/ws`;
}

export interface MeshSocketLike {
  binaryType?: string;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  send(data: Uint8Array): void;
  close(): void;
}

export type MeshSocketFactory = (url: string) => MeshSocketLike;

export interface MeshEventSourceOptions {
  url?: string;
  socketFactory?: MeshSocketFactory;
  /** 重连退避基数（ms），第 n 次重连等 `base * 2^(n-1)` 再乘一个 [0.5,1] 的抖动，上限 `maxDelayMs`。 */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** 认为「连接已稳定」的时长；只有稳定过或收到过有效帧才重置退避计数。 */
  stableAfterMs?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  /** 抖动因子来源（测试注入）；返回 [0,1)。 */
  random?: () => number;
  nowFn?: () => number;
  /** 4401（会话失效）时的处理；缺省派发全局未授权并跳登录页。 */
  onUnauthorized?: () => void;
}

const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 60_000;
const DEFAULT_STABLE_AFTER_MS = 10_000;

function closeCodeOf(event: unknown): number | null {
  const code = (event as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'number' ? code : null;
}

function defaultSocketFactory(url: string): MeshSocketLike {
  const ctor = (globalThis as { WebSocket?: new (url: string) => MeshSocketLike }).WebSocket;
  if (!ctor) throw new Error('WebSocket unavailable');
  const socket = new ctor(url);
  socket.binaryType = 'arraybuffer';
  return socket;
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return null;
}

/**
 * `/mesh/ws` 订阅：指数退避重连、NODE_EVENT 多播、RTC_SIGNAL 单一 handler（Phase 3 的钩子）。
 *
 * 之所以给 RTC_SIGNAL 留的是**一个** handler 而不是多播：直连控制器同一时刻只有一个所有者，
 * 多播会让两份控制器同时应答同一个 offer。
 */
export class MeshEventSource {
  private readonly url: string;
  private readonly socketFactory: MeshSocketFactory;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly stableAfterMs: number;
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly onUnauthorized: () => void;

  private socket: MeshSocketLike | null = null;
  private timer: unknown = null;
  private attempt = 0;
  private started = false;
  private connectedFlag = false;
  private openedAt = 0;
  private sawValidFrame = false;
  private unauthorizedFlag = false;

  private readonly nodeListeners = new Set<(event: NodeEventPayload) => void>();
  private readonly statusListeners = new Set<() => void>();
  private readonly enrollListeners = new Set<(event: EnrollRedeemedPayload) => void>();
  private rtcHandler: ((signal: RtcSignalPayload) => void) | null = null;

  constructor(options: MeshEventSourceOptions = {}) {
    this.url = options.url ?? meshWsUrl();
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.stableAfterMs = options.stableAfterMs ?? DEFAULT_STABLE_AFTER_MS;
    this.schedule =
      options.setTimeoutFn ?? ((fn, ms) => (globalThis as typeof global).setTimeout(fn, ms));
    this.cancel =
      options.clearTimeoutFn ??
      ((handle) => (globalThis as typeof global).clearTimeout(handle as never));
    this.random = options.random ?? Math.random;
    this.now = options.nowFn ?? Date.now;
    this.onUnauthorized = options.onUnauthorized ?? (() => handleGlobalUnauthorized('/mesh/ws'));
  }

  get connected(): boolean {
    return this.connectedFlag;
  }

  /** 会话失效（4401）后置位；此后不再重连，直到调用方重新 `start()`。 */
  get unauthorized(): boolean {
    return this.unauthorizedFlag;
  }

  /**
   * 第 `attempt` 次重连的等待时长（attempt 从 1 起）：
   * `base * 2^(n-1)` 截到 `maxDelayMs`，再乘 [0.5, 1] 的抖动——
   * 服务恢复时大量页面同时重连会把刚起来的 gateway 再打挂。
   */
  retryDelay(attempt: number): number {
    const exponent = Math.max(0, attempt - 1);
    const capped = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** exponent);
    return Math.round(capped * (0.5 + this.random() * 0.5));
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.attempt = 0;
    this.unauthorizedFlag = false;
    this.open();
  }

  stop(): void {
    this.started = false;
    if (this.timer != null) {
      this.cancel(this.timer);
      this.timer = null;
    }
    const socket = this.socket;
    this.socket = null;
    this.setConnected(false);
    if (socket) {
      socket.onopen = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.close();
    }
  }

  onNodeEvent(listener: (event: NodeEventPayload) => void): () => void {
    this.nodeListeners.add(listener);
    return () => {
      this.nodeListeners.delete(listener);
    };
  }

  /** 订阅连接状态变化（供 UI 显示 mesh 事件流是否在线）。 */
  onStatusChange(listener: () => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  /** 订阅 hub 转发过来的 redeem 证书（Nodes 页据此自动 admit）。 */
  onEnrollRedeemed(listener: (event: EnrollRedeemedPayload) => void): () => void {
    this.enrollListeners.add(listener);
    return () => {
      this.enrollListeners.delete(listener);
    };
  }

  /** Phase 3 的直连控制器在此登记；返回注销函数。 */
  setRtcSignalHandler(handler: ((signal: RtcSignalPayload) => void) | null): () => void {
    this.rtcHandler = handler;
    return () => {
      if (this.rtcHandler === handler) this.rtcHandler = null;
    };
  }

  sendRtcSignal(signal: RtcSignalPayload): boolean {
    if (!this.socket || !this.connectedFlag) return false;
    this.socket.send(encodeRtcSignal(signal));
    return true;
  }

  private setConnected(next: boolean): void {
    if (this.connectedFlag === next) return;
    this.connectedFlag = next;
    for (const listener of this.statusListeners) listener();
  }

  private open(): void {
    let socket: MeshSocketLike;
    try {
      socket = this.socketFactory(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    // 服务端会「接受升级后立刻 4401 关闭」，所以 open 本身不代表鉴权通过：
    // 在这里清零退避会让客户端每秒 open→reset→close 一次，永远进不了指数退避。
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.openedAt = this.now();
      this.sawValidFrame = false;
      this.setConnected(true);
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      const bytes = toBytes(event.data);
      if (!bytes) return;
      const frame = decodeMeshFrame(bytes);
      if (!frame) return;
      // 收到一帧合法业务数据即视为连接可用，可以重置退避。
      this.sawValidFrame = true;
      this.attempt = 0;
      if (frame.kind === 'node-event') {
        for (const listener of this.nodeListeners) listener(frame.payload);
        return;
      }
      if (frame.kind === 'enroll-redeemed') {
        for (const listener of this.enrollListeners) listener(frame.payload);
        return;
      }
      this.rtcHandler?.(frame.payload);
    };
    socket.onerror = () => {
      // close 事件随后必到，重连统一在 onclose 里处理。
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      const wasConnected = this.connectedFlag;
      this.setConnected(false);
      if (closeCodeOf(event) === WS_UNAUTHORIZED_CLOSE_CODE) {
        // 会话已失效：继续重连只会被反复关掉，必须停下并派发一次全局未授权。
        this.started = false;
        this.unauthorizedFlag = true;
        this.attempt = 0;
        this.onUnauthorized();
        return;
      }
      if (
        wasConnected &&
        (this.sawValidFrame || this.now() - this.openedAt >= this.stableAfterMs)
      ) {
        this.attempt = 0;
      }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (!this.started) return;
    this.attempt += 1;
    const delay = this.retryDelay(this.attempt);
    this.timer = this.schedule(() => {
      this.timer = null;
      if (!this.started) return;
      this.open();
    }, delay);
  }
}

let sharedSource: MeshEventSource | null = null;

/** 宿主级共享的 mesh 事件源（懒建，首次订阅时 start）。 */
export function sharedMeshEvents(): MeshEventSource {
  if (!sharedSource) {
    sharedSource = new MeshEventSource();
  }
  return sharedSource;
}

/** 仅测试使用：替换 / 清空共享实例。 */
export function setSharedMeshEvents(source: MeshEventSource | null): void {
  sharedSource = source;
}
