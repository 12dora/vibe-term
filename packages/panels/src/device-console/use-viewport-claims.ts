// 视口声明：把「本客户端在该 pane 上的可见状态 + 容器测量几何」告诉网关，
// 网关据此在多客户端间仲裁整窗尺寸（最大的可见客户端持有 PTY 尺寸）。
//
// 为什么不复用 terminal-resize：跟随者（sizingMode='follow'）下 TerminalResizeReporter
// 根本不测量也不上报，若只靠 resize 声明，跟随者把窗口拉大后永远抢不回 owner。

import { useRuntime } from '@tmex/stores/react';
import { type RefObject, useEffect, useRef } from 'react';

/** 容器就绪前的重试节奏：终端实例是异步 boot 的，首帧往往量不到 */
const MEASURE_RETRY_MS = 120;
const MEASURE_MAX_ATTEMPTS = 25;

export interface ViewportClaimSize {
  cols: number;
  rows: number;
}

export interface ViewportClaim extends ViewportClaimSize {
  visible: boolean;
}

export type ViewportClaimSend = (deviceId: string, paneId: string, claim: ViewportClaim) => void;

export interface ViewportClaimSender {
  claim(deviceId: string, paneId: string, size: ViewportClaimSize, visible: boolean): void;
  /** 不再是可见面（切走/卸载）：用最后一次几何补发 visible:false */
  release(deviceId: string, paneId: string): void;
  /** 丢弃去重记忆：重连后网关侧声明已清空，必须原样重发一次 */
  forget(deviceId: string, paneId: string): void;
  lastSize(deviceId: string, paneId: string): ViewportClaimSize | null;
}

function claimKey(deviceId: string, paneId: string): string {
  return `${deviceId}:${paneId}`;
}

export function createViewportClaimSender(send: ViewportClaimSend): ViewportClaimSender {
  const last = new Map<string, ViewportClaim>();

  return {
    claim(deviceId, paneId, size, visible) {
      if (!deviceId || !paneId) return;
      const key = claimKey(deviceId, paneId);
      const previous = last.get(key);
      if (
        previous &&
        previous.cols === size.cols &&
        previous.rows === size.rows &&
        previous.visible === visible
      ) {
        return;
      }
      const next: ViewportClaim = { cols: size.cols, rows: size.rows, visible };
      last.set(key, next);
      send(deviceId, paneId, next);
    },

    release(deviceId, paneId) {
      if (!deviceId || !paneId) return;
      const key = claimKey(deviceId, paneId);
      const previous = last.get(key);
      if (!previous || !previous.visible) return;
      const next: ViewportClaim = { ...previous, visible: false };
      last.set(key, next);
      send(deviceId, paneId, next);
    },

    forget(deviceId, paneId) {
      last.delete(claimKey(deviceId, paneId));
    },

    lastSize(deviceId, paneId) {
      const previous = last.get(claimKey(deviceId, paneId));
      return previous ? { cols: previous.cols, rows: previous.rows } : null;
    },
  };
}

export type ViewportClaimAction =
  | { kind: 'claim'; cols: number; rows: number; visible: boolean }
  | { kind: 'retry' }
  | { kind: 'skip' };

/** 一次声明尝试的判定：页面不可见就撤回，量不到尺寸就重试 */
export function resolveViewportClaim({
  documentVisible,
  measured,
  lastSize,
}: {
  documentVisible: boolean;
  measured: ViewportClaimSize | null;
  lastSize: ViewportClaimSize | null;
}): ViewportClaimAction {
  if (!documentVisible) {
    const size = lastSize ?? measured;
    if (!size) return { kind: 'skip' };
    return { kind: 'claim', cols: size.cols, rows: size.rows, visible: false };
  }
  if (!measured) return { kind: 'retry' };
  return { kind: 'claim', cols: measured.cols, rows: measured.rows, visible: true };
}

export interface ViewportClaimsOptions {
  deviceId?: string;
  paneId?: string;
  /** 该 pane 确实是本页当前的可见终端面，且传输可用 */
  enabled: boolean;
  containerRef: RefObject<HTMLElement | null>;
  /** 容器测量出的行列（跟随者也要量，故不能取终端实例当前的 cols/rows） */
  measure: () => ViewportClaimSize | null;
}

export function useViewportClaims({
  deviceId,
  paneId,
  enabled,
  containerRef,
  measure,
}: ViewportClaimsOptions): void {
  const runtime = useRuntime();
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;

  const measureRef = useRef(measure);
  measureRef.current = measure;

  const senderRef = useRef<ViewportClaimSender | null>(null);
  if (!senderRef.current) {
    senderRef.current = createViewportClaimSender((claimDeviceId, claimPaneId, claim) => {
      runtimeRef.current.stores.tmux.getState().setPaneViewport(claimDeviceId, claimPaneId, claim);
    });
  }

  useEffect(() => {
    const sender = senderRef.current;
    if (!sender || !enabled || !deviceId || !paneId) return;
    if (typeof window === 'undefined') return;

    const doc = typeof document === 'undefined' ? null : document;
    // 每次重新成为可见面（或重连）都要重新声明：网关侧的旧声明可能已随会话消失
    sender.forget(deviceId, paneId);

    let attempts = 0;
    let timer: number | undefined;

    const cancelRetry = (): void => {
      if (timer === undefined) return;
      window.clearTimeout(timer);
      timer = undefined;
    };

    const push = (): void => {
      cancelRetry();
      const action = resolveViewportClaim({
        documentVisible: doc === null || doc.visibilityState !== 'hidden',
        measured: measureRef.current(),
        lastSize: sender.lastSize(deviceId, paneId),
      });
      if (action.kind === 'skip') return;
      if (action.kind === 'retry') {
        if (attempts >= MEASURE_MAX_ATTEMPTS) return;
        attempts += 1;
        timer = window.setTimeout(push, MEASURE_RETRY_MS);
        return;
      }
      attempts = 0;
      sender.claim(deviceId, paneId, { cols: action.cols, rows: action.rows }, action.visible);
    };

    const restart = (): void => {
      attempts = 0;
      push();
    };

    restart();

    const container = containerRef.current;
    const observer =
      typeof ResizeObserver === 'undefined' || !container ? null : new ResizeObserver(restart);
    observer?.observe(container as Element);
    doc?.addEventListener('visibilitychange', restart);

    return () => {
      cancelRetry();
      observer?.disconnect();
      doc?.removeEventListener('visibilitychange', restart);
      sender.release(deviceId, paneId);
    };
  }, [containerRef, deviceId, enabled, paneId]);
}
