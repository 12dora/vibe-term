import { useRuntime, useTmuxStore } from '@tmex/stores/react';
import type { PaneSink } from '@tmex/ws-client/pane-sink-registry';
import type { CompatibleTerminalLike } from 'ghostty-terminal';
import { type RefObject, useEffect, useMemo, useRef } from 'react';
import type { TerminalSurface } from '../TerminalSurface';
import { historyRequestDeadlineMs, shouldRequestOlderHistory } from '../paneHistoryRequest';
import {
  type TerminalGeometry,
  type TerminalRenderTarget,
  writeRestoredHistory,
} from '../terminal-snapshot';

export interface UsePaneSinkRegistrationOptions {
  deviceId: string;
  paneId: string;
  instance: CompatibleTerminalLike | null;
  surfaceRef: RefObject<TerminalSurface<TerminalRenderTarget> | null>;
  containerRef: RefObject<HTMLDivElement | null>;
  runPostSelectResize: () => void;
  /** 是否把本 pane 计入 wire 订阅集合（默认 true）；sink 注册与之无关，恒生效 */
  subscribe?: boolean;
}

// legacy history 的几何权威是 tmux 快照里的 pane 尺寸（gateway 正是按这个尺寸
// capture 的）；这里同步读取而不订阅，避免 pane 尺寸变化重建 sink。
function remotePaneGeometry(
  runtime: ReturnType<typeof useRuntime>,
  deviceId: string,
  paneId: string
): TerminalGeometry | null {
  const session = runtime.stores.tmux.getState().snapshots[deviceId]?.session;
  for (const window of session?.windows ?? []) {
    for (const pane of window.panes) {
      if (pane.id === paneId) return { cols: pane.width, rows: pane.height };
    }
  }
  return null;
}

/**
 * pane 数据面：把 gateway 的 reset/history/live/snapshot/rebase 接进当前渲染面，
 * 并负责 pane 挂载、首屏请求与向上滚动时的 history 续拉。
 */
export function usePaneSinkRegistration({
  deviceId,
  paneId,
  instance,
  surfaceRef,
  containerRef,
  runPostSelectResize,
  subscribe = true,
}: UsePaneSinkRegistrationOptions): void {
  const runtime = useRuntime();
  const mountPane = useTmuxStore((state) => state.mountPane);
  const requestPaneScreen = useTmuxStore((state) => state.requestPaneScreen);
  const fetchPaneHistory = useTmuxStore((state) => state.fetchPaneHistory);
  // 首屏只按终端实例请求一次：实例换代（重试、字体变更）才重新请求，
  // deviceId/paneId 变动不触发第二次。
  const screenRequestedForRef = useRef<CompatibleTerminalLike | null>(null);
  const historyRequestInFlightRef = useRef(false);
  const historyRequestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const paneSink: PaneSink | null = useMemo(() => {
    if (!instance) {
      return null;
    }

    return {
      onReset: (origin) => {
        const target = surfaceRef.current?.getVisibleTarget();
        target?.terminal.reset();
        if (target) target.liveOutputEndedWithCR = false;
        // history-refresh（远端 resize 后的内容重建）不上报本地尺寸，
        // 避免不同视口的客户端互相抢 window 尺寸
        if (origin !== 'history-refresh') {
          runPostSelectResize();
        }
      },
      onApplyHistory: (data, alternateScreen, modes) => {
        const target = surfaceRef.current?.getVisibleTarget();
        if (!target) return;
        writeRestoredHistory(
          target,
          { data, alternateScreen, modes },
          remotePaneGeometry(runtime, deviceId, paneId)
        );
      },
      onOutput: (data, frame) => {
        surfaceRef.current?.write(frame ?? { deviceId, paneId, data });
      },
      onScreenSnapshot: (snapshot) => surfaceRef.current?.replace(snapshot),
      onHistoryPage: (page) => {
        historyRequestInFlightRef.current = false;
        if (historyRequestTimerRef.current) clearTimeout(historyRequestTimerRef.current);
        historyRequestTimerRef.current = null;
        surfaceRef.current?.applyHistoryPage(page);
      },
      onRebase: (reason) => surfaceRef.current?.rebase(reason),
    };
  }, [deviceId, instance, paneId, runPostSelectResize, runtime, surfaceRef]);

  useEffect(() => {
    if (!paneSink || !deviceId || !paneId) {
      return;
    }
    return runtime.paneSinks.registerPaneSink(deviceId, paneId, paneSink);
  }, [paneSink, deviceId, paneId, runtime]);

  // sink 注册（上一个 effect）与订阅贡献分开：退订时 sink 仍在，
  // 网关也不再发这个 pane 的输出，sink 注册表因此不会开始缓冲。
  useEffect(() => {
    if (!subscribe || !deviceId || !paneId) return;
    return mountPane(deviceId, paneId);
  }, [deviceId, mountPane, paneId, subscribe]);

  useEffect(() => {
    if (
      !instance ||
      !runtime.transport.capabilities.atomicScreen ||
      screenRequestedForRef.current === instance
    ) {
      return;
    }
    screenRequestedForRef.current = instance;
    requestPaneScreen(deviceId, paneId);
  }, [deviceId, instance, paneId, requestPaneScreen, runtime]);

  useEffect(() => {
    if (!instance || !runtime.transport.capabilities.cursorHistory) return;
    const container = containerRef.current;
    if (!container) return;

    const requestOlderHistory = (event: WheelEvent): void => {
      if (
        !shouldRequestOlderHistory({
          deltaY: event.deltaY,
          requestInFlight: historyRequestInFlightRef.current,
          viewportY: instance.buffer.active.viewportY,
        })
      ) {
        return;
      }
      const cursor = surfaceRef.current?.getNextHistoryCursor();
      if (!cursor) return;

      historyRequestInFlightRef.current = true;
      fetchPaneHistory(deviceId, paneId, cursor);
      if (historyRequestTimerRef.current) clearTimeout(historyRequestTimerRef.current);
      historyRequestTimerRef.current = setTimeout(() => {
        historyRequestInFlightRef.current = false;
        historyRequestTimerRef.current = null;
      }, historyRequestDeadlineMs(runtime.transport.latencyMs));
    };
    container.addEventListener('wheel', requestOlderHistory, { passive: true });
    return () => {
      container.removeEventListener('wheel', requestOlderHistory);
      historyRequestInFlightRef.current = false;
      if (historyRequestTimerRef.current) clearTimeout(historyRequestTimerRef.current);
      historyRequestTimerRef.current = null;
    };
  }, [containerRef, deviceId, fetchPaneHistory, instance, paneId, runtime, surfaceRef]);
}
