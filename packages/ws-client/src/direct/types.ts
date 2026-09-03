// 直连（DataChannel）承载的诊断接口。
//
// 现状：`GatewayConnection` 还没有 `DirectCarrierController`（F3-1 的活），因此这里只定义
// **契约**与一个恒为 primary 的桩实现，UI（设备页头部徽标 / ICE 诊断弹层）先按契约写。
// F3-1 落地后，只需让 `GatewayConnection` 暴露 `directDiagnostics: DirectDiagnosticsSource`，
// `resolveDirectDiagnostics()` 就会自动取到真实值，UI 与本文件都不用改。

import type { DirectRoute } from './ice-stats';

/** 浏览器 ↔ node 的当前承载：`primary` = 经 entry 转发的 WS；`direct` = WebRTC DataChannel。 */
export type DirectCarrierPath = 'primary' | 'direct';

/** ICE 诊断明细；F3-1 从 `RTCPeerConnection.getStats()` 填充，未知一律 `null`。 */
export interface DirectIceDiagnostics {
  /** `RTCPeerConnection.connectionState` */
  connectionState: string | null;
  /** `RTCPeerConnection.iceConnectionState` */
  iceConnectionState: string | null;
  /** 选中候选对的本端候选类型（host / srflx / prflx / relay） */
  localCandidateType: string | null;
  /** 选中候选对的对端候选类型 */
  remoteCandidateType: string | null;
  /** 选中候选对的可读描述，形如 `host → srflx` */
  selectedPair: string | null;
}

export interface DirectDiagnostics {
  /** 当前承载：primary（经 entry 转发）/ direct（DataChannel）。 */
  path: DirectCarrierPath;
  /**
   * 直连的**网络路径**（由 `getStats()` 的选中候选对推出），与 `path` 是两回事：
   * `path` 回答「走不走直连」，`route` 回答「直连走的是内网 / IPv6 / 打洞 / TURN」。
   * 未建立直连时为 `null`。
   */
  route: DirectRoute | null;
  /** 往返时延（毫秒）；未知为 `null`。 */
  rtt: number | null;
  ice: DirectIceDiagnostics | null;
  /** 熔断冷却中：不再自动拨号，直到 `until` 或 `retryDirect()`。 */
  cooling?: boolean;
  until?: number | null;
  failures?: number;
  level?: number;
  lastFailureKind?: string | null;
}

/** 可订阅的诊断源：`get()` 取快照，`subscribe()` 在快照变化时回调（供 useSyncExternalStore）。 */
export interface DirectDiagnosticsSource {
  get(): DirectDiagnostics;
  subscribe(listener: () => void): () => void;
}

/** 无直连能力时的恒定快照。引用稳定，`useSyncExternalStore` 不会因它重渲染。 */
export const PRIMARY_ONLY_DIAGNOSTICS: DirectDiagnostics = Object.freeze({
  path: 'primary',
  route: null,
  rtt: null,
  ice: null,
  cooling: false,
  until: null,
  failures: 0,
  level: 0,
  lastFailureKind: null,
});

const NOOP_UNSUBSCRIBE = (): void => undefined;

/** 恒为 `primary` 的桩诊断源（F3-1 之前的唯一实现）。 */
export function createStubDirectDiagnosticsSource(): DirectDiagnosticsSource {
  return {
    get: () => PRIMARY_ONLY_DIAGNOSTICS,
    subscribe: () => NOOP_UNSUBSCRIBE,
  };
}

const STUB_SOURCE = createStubDirectDiagnosticsSource();

/** 可后挂真实来源的诊断源：直连栈按需加载期间先当桩用，加载完 `attach()` 接上。 */
export interface DeferredDirectDiagnosticsSource extends DirectDiagnosticsSource {
  /** 接上/摘掉真实诊断源；两种情况都会立刻通知一次订阅者。 */
  attach(source: DirectDiagnosticsSource | null): void;
}

/**
 * 直连栈是懒加载的，而 UI（设备页徽标）在建连的同一帧就用 `useSyncExternalStore` 订好了
 * `connection.directDiagnostics`。所以建连时同步挂这个占位源：加载完成前恒为 primary，
 * 控制器就位后 `attach()` 转发真实快照并唤醒既有订阅者。
 */
export function createDeferredDiagnosticsSource(): DeferredDirectDiagnosticsSource {
  const listeners = new Set<() => void>();
  let inner: DirectDiagnosticsSource | null = null;
  let detachInner: (() => void) | null = null;
  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };
  return {
    get: () => inner?.get() ?? PRIMARY_ONLY_DIAGNOSTICS,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    attach: (source) => {
      detachInner?.();
      detachInner = null;
      inner = source;
      if (source) detachInner = source.subscribe(notify);
      notify();
    },
  };
}

interface MaybeDiagnosticsCarrier {
  directDiagnostics?: unknown;
}

function isDiagnosticsSource(value: unknown): value is DirectDiagnosticsSource {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<DirectDiagnosticsSource>;
  return typeof candidate.get === 'function' && typeof candidate.subscribe === 'function';
}

/**
 * 从一个 `GatewayConnection`（或任何对象）上取诊断源；没有就返回恒 primary 的桩。
 * 鸭子类型是刻意的：F3-1 给 connection 挂上 `directDiagnostics` 后此处零改动生效。
 */
export function resolveDirectDiagnostics(connection: unknown): DirectDiagnosticsSource {
  const carrier = connection as MaybeDiagnosticsCarrier | null | undefined;
  if (carrier && isDiagnosticsSource(carrier.directDiagnostics)) {
    return carrier.directDiagnostics;
  }
  return STUB_SOURCE;
}
