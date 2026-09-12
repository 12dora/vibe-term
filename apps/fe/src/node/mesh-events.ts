// `/mesh/ws` 的浏览器侧订阅：Borsh 解出 NODE_EVENT（节点上下线 / 到达路径 / inventory）
// 与 RTC_SIGNAL（Phase 3 的直连信令，这里只做转交）。
//
// 该连接**只属于 entry（self）**：mesh 事件是入口对整张 mesh 的视图，不按 node 分身。

import { handleGlobalUnauthorized } from '@vibeterm/api-client/auth/index';
import {
  type EnrollRedeemedPayload,
  type NodeEventPayload,
  type RtcSignalPayload,
  decodeMeshFrame,
  encodeRtcSignal,
} from './mesh-events-codec';
import { type RecoverySubscribe, isPageVisible, onPageRecovery } from './mesh-recovery';
import {
  MESH_WS_PING_INTERVAL_MS,
  MESH_WS_PING_TIMEOUT_MS,
  MeshWsLiveness,
  isMeshPong,
} from './mesh-ws-ping';

// 帧编解码与页面侧类型都在 `mesh-events-codec.ts`；这里原样转出去，调用方不必改 import。
export type {
  EnrollRedeemedPayload,
  MeshFrame,
  NodeEventPayload,
  NodeEventStatus,
  NodeReach,
  NodeTransport,
  RtcSignalPayload,
} from './mesh-events-codec';
export { KIND_ENROLL_REDEEMED, decodeMeshFrame, encodeRtcSignal } from './mesh-events-codec';
export { MESH_WS_PING_INTERVAL_MS, MESH_WS_PING_TIMEOUT_MS } from './mesh-ws-ping';

/** 会话在连接期间失效时服务端的关闭码（B2-2b 契约）。 */
export const WS_UNAUTHORIZED_CLOSE_CODE = 4401;

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
  /**
   * 页面可见时的退避上限。后台待久了退避会爬到分钟级，用户切回来还要干等一整拍——
   * 前台一律压到这个上限之内。
   */
  visibleMaxDelayMs?: number;
  /** 「页面重新可见 / 网络恢复」信号（测试注入）；缺省订阅 document / window。 */
  recovery?: RecoverySubscribe;
  /** 页面此刻是否可见（测试注入）。 */
  visible?: () => boolean;
  /** 可见性**每一次**变化的订阅（测试注入）；缺省订阅 document。用来记「真的离开过多久」。 */
  visibilityChange?: (listener: () => void) => () => void;
  /** 首次打开前的最长等待；0 表示不延迟（测试注入）。 */
  startDelayMs?: number;
  /** 「首个终端内容绘制」信号（测试注入）；缺省订阅模块级注册表。 */
  firstPaint?: (listener: () => void) => () => void;
  /** 回前台时认定这条流已不可信的静默时长（测试注入）。 */
  silenceReconnectMs?: number;
  /** 前台应用层 ping 间隔；0 关闭（测试注入）。 */
  pingIntervalMs?: number;
  /** 已确认对端会回 PONG 后，超时未活动则换线。 */
  pingTimeoutMs?: number;
  /** `pageshow`（测试注入）；缺省订 window。iOS 回前台常走这条而不是 visibilitychange。 */
  pageshow?: RecoverySubscribe;
}

const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 60_000;
const DEFAULT_STABLE_AFTER_MS = 10_000;
const DEFAULT_VISIBLE_MAX_DELAY_MS = 5_000;

/**
 * `/mesh/ws` 首次打开的最长等待。
 *
 * 开屏时页面要同时建 `/ws`、`/mesh/ws`（远端 node 还要再加 `/n/<id>/ws`），每条都是一次独立的
 * TCP+TLS+Upgrade。高延迟链路上这几次握手互相抢并发窗口，而 mesh 事件流对首屏没有任何贡献：
 * 节点在线态来自 `/api/mesh/nodes` 的投影，事件流只是让它更快。所以让它排在终端首帧之后，
 * 首帧信号迟迟不来（没有终端的页面）就按这个上限兜底。
 */
export const MESH_WS_START_DELAY_MS = 3_000;

/**
 * 回前台时认定「这条 mesh 流已经不可信」的静默时长。
 *
 * 后台挂起足够久时 socket 多半已死。前台切网改走应用层 ping（见 `MESH_WS_PING_INTERVAL_MS`）：
 * 对端回 PONG 后，几秒无活动就换线；老网关不回 PONG 时仍用这条 30 s 静默门槛，避免误杀活连接。
 */
export const MESH_WS_SILENCE_RECONNECT_MS = 30_000;

// 「首个终端内容绘制」的模块级注册表：信号只会发生一次，之后注册的订阅者立即回调。
let firstTerminalPainted = false;
const firstPaintListeners = new Set<() => void>();

/**
 * 宣告首个终端内容已经画出来了。由终端挂载侧调用（幂等）；没人调用时
 * `MESH_WS_START_DELAY_MS` 是唯一的开闸条件。
 */
export function notifyFirstTerminalPaint(): void {
  if (firstTerminalPainted) return;
  firstTerminalPainted = true;
  for (const listener of [...firstPaintListeners]) listener();
  firstPaintListeners.clear();
}

export function onFirstTerminalPaint(listener: () => void): () => void {
  if (firstTerminalPainted) {
    listener();
    return () => undefined;
  }
  firstPaintListeners.add(listener);
  return () => {
    firstPaintListeners.delete(listener);
  };
}

/** 仅供测试：把首帧信号倒回未发生。 */
export function resetFirstTerminalPaintForTest(): void {
  firstTerminalPainted = false;
  firstPaintListeners.clear();
}

/**
 * 可见性变化的缺省订阅源。`onPageRecovery` 只在「重新可见」时回调，拿不到**转入后台**那一下，
 * 而判断「这次回来之前真的离开过多久」正需要它。非浏览器宿主取不到 document，订阅即空操作。
 */
function onVisibilityChanged(listener: () => void): () => void {
  const doc = (globalThis as { document?: Document }).document;
  if (!doc || typeof doc.addEventListener !== 'function') return () => undefined;
  doc.addEventListener('visibilitychange', listener);
  return () => doc.removeEventListener('visibilitychange', listener);
}

function onPageshow(listener: () => void): () => void {
  const g = globalThis as {
    addEventListener?: (type: string, cb: () => void) => void;
    removeEventListener?: (type: string, cb: () => void) => void;
  };
  if (typeof g.addEventListener !== 'function') return () => undefined;
  g.addEventListener('pageshow', listener);
  return () => g.removeEventListener?.('pageshow', listener);
}

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
  private readonly visibleMaxDelayMs: number;
  private readonly recovery: RecoverySubscribe;
  private readonly visible: () => boolean;
  private readonly visibilityChange: (listener: () => void) => () => void;
  private readonly startDelayMs: number;
  private readonly firstPaint: (listener: () => void) => () => void;
  private readonly silenceReconnectMs: number;
  private readonly pageshow: RecoverySubscribe;
  private stopRecovery: (() => void) | null = null;
  private stopFirstPaint: (() => void) | null = null;
  private stopVisibility: (() => void) | null = null;
  private stopPageshow: (() => void) | null = null;
  private readonly liveness: MeshWsLiveness;
  private startTimer: unknown = null;
  private lastActivityAt = 0;
  /** 页面转入后台的时刻；一直在前台为 null。 */
  private hiddenSince: number | null = null;

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
    this.visibleMaxDelayMs = options.visibleMaxDelayMs ?? DEFAULT_VISIBLE_MAX_DELAY_MS;
    this.recovery = options.recovery ?? onPageRecovery;
    this.visible = options.visible ?? isPageVisible;
    this.visibilityChange = options.visibilityChange ?? onVisibilityChanged;
    this.startDelayMs = options.startDelayMs ?? MESH_WS_START_DELAY_MS;
    this.firstPaint = options.firstPaint ?? onFirstTerminalPaint;
    this.silenceReconnectMs = options.silenceReconnectMs ?? MESH_WS_SILENCE_RECONNECT_MS;
    this.pageshow = options.pageshow ?? onPageshow;
    const pingIntervalMs = options.pingIntervalMs ?? MESH_WS_PING_INTERVAL_MS;
    const pingTimeoutMs = options.pingTimeoutMs ?? MESH_WS_PING_TIMEOUT_MS;
    this.liveness = new MeshWsLiveness({
      intervalMs: pingIntervalMs,
      timeoutMs: pingTimeoutMs,
      now: () => this.now(),
      visible: () => this.visible(),
      isSilent: () => this.now() - this.lastActivityAt >= pingTimeoutMs,
      schedule: (fn, ms) => this.schedule(fn, ms),
      cancel: (handle) => this.cancel(handle),
      send: (bytes) => {
        if (!this.socket || !this.connectedFlag) throw new Error('mesh-ws-closed');
        this.socket.send(bytes);
      },
      onZombie: () => this.cycleSocket(),
    });
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
    const ceiling = this.visible()
      ? Math.min(this.maxDelayMs, this.visibleMaxDelayMs)
      : this.maxDelayMs;
    const capped = Math.min(ceiling, this.baseDelayMs * 2 ** exponent);
    return Math.round(capped * (0.5 + this.random() * 0.5));
  }

  /**
   * 起订阅。首次打开**不在本次调用里发生**：排到「首个终端内容绘制」或
   * `startDelayMs` 兜底，两者谁先到算谁（见 `MESH_WS_START_DELAY_MS`）。
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.attempt = 0;
    this.unauthorizedFlag = false;
    this.stopRecovery ??= this.recovery(() => this.onRecovery());
    this.stopPageshow ??= this.pageshow(() => this.onRecovery());
    this.stopVisibility ??= this.visibilityChange(() => this.noteVisibility());
    this.hiddenSince = this.visible() ? null : this.now();
    if (this.startDelayMs <= 0) {
      this.open();
      return;
    }
    this.stopFirstPaint ??= this.firstPaint(() => this.openNow());
    if (this.socket || this.startTimer != null) return;
    this.startTimer = this.schedule(() => {
      this.startTimer = null;
      this.openNow();
    }, this.startDelayMs);
  }

  /** 开闸：取消首帧等待并立刻建连（已经连上 / 正在退避重连时什么都不做）。 */
  private openNow(): void {
    this.clearStartTimer();
    if (!this.started || this.socket || this.timer != null) return;
    this.open();
  }

  private clearStartTimer(): void {
    this.stopFirstPaint?.();
    this.stopFirstPaint = null;
    if (this.startTimer == null) return;
    this.cancel(this.startTimer);
    this.startTimer = null;
  }

  /** 转入后台就记下时刻；回到前台由 `onRecovery` 结算并清零。 */
  private noteVisibility(): void {
    if (this.visible()) return;
    this.hiddenSince ??= this.now();
    this.liveness.pause();
  }

  /**
   * 页面重新可见 / 网络恢复。
   *
   * 没连上：退避计数清零并立刻重连——锁屏几分钟后退避早就爬到分钟级，用户切回来第一眼
   * 看到的却是「事件流未连接」，节点上下线全靠 5 分钟的兜底轮询。
   *
   * 连着的那条要不要换，两个条件**都**满足才换：
   *  - 这次回来之前页面**真的离开过** ≥ `silenceReconnectMs`（iOS 挂起足够久，socket 多半已死）；
   *  - 且这条流静默了同样久（`/mesh/ws` 没有应用层心跳，见 `MESH_WS_SILENCE_RECONNECT_MS`）。
   *
   * 只看静默是不够的：桌面上切个标签页回来、或者服务端本来就没有节点上下线可报，
   * 都会是「静默 30 s 的活连接」，换掉它纯属白付一次握手。
   */
  private onRecovery(): void {
    if (!this.started || this.startTimer != null) return;
    const hiddenFor = this.hiddenSince === null ? 0 : this.now() - this.hiddenSince;
    this.hiddenSince = null;
    if (this.connectedFlag && this.socket) {
      this.liveness.arm();
      this.liveness.sendNow();
      if (hiddenFor < this.silenceReconnectMs) return;
      if (this.now() - this.lastActivityAt < this.silenceReconnectMs) return;
      this.cycleSocket();
      return;
    }
    this.reconnectNow();
  }

  private reconnectNow(): void {
    if (!this.started || this.connectedFlag || this.socket) return;
    this.attempt = 0;
    if (this.timer != null) {
      this.cancel(this.timer);
      this.timer = null;
    }
    this.open();
  }

  /** 摘掉当前 socket 并立刻建一条新的（不经退避、不派发 4401 判定）。 */
  private cycleSocket(): void {
    this.liveness.stop();
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
    this.attempt = 0;
    if (this.timer != null) {
      this.cancel(this.timer);
      this.timer = null;
    }
    this.open();
  }

  stop(): void {
    this.started = false;
    this.stopRecovery?.();
    this.stopRecovery = null;
    this.stopPageshow?.();
    this.stopPageshow = null;
    this.stopVisibility?.();
    this.stopVisibility = null;
    this.liveness.stop();
    this.hiddenSince = null;
    this.clearStartTimer();
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
      this.lastActivityAt = this.openedAt;
      this.sawValidFrame = false;
      this.setConnected(true);
      this.liveness.start();
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      // 任何一帧（哪怕解不出来）都证明这条流此刻还通，足以刷新静默计时。
      this.lastActivityAt = this.now();
      const bytes = toBytes(event.data);
      if (bytes && isMeshPong(bytes)) this.liveness.notePong();
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
      this.liveness.stop();
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
