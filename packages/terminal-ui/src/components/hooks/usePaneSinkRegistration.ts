import { useRuntime, useTmuxStore } from '@vibeterm/stores/react';
import type { GatewayHistoryCursor } from '@vibeterm/ws-client';
import type { PaneSink } from '@vibeterm/ws-client/pane-sink-registry';
import type { CompatibleTerminalLike } from 'ghostty-terminal';
import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import type { TerminalSurface } from '../TerminalSurface';
import { HistoryPrefetchController, historyRequestDeadlineMs } from '../paneHistoryRequest';
import type { TerminalRenderTarget } from '../terminal-snapshot';
import { useLatestRef } from './useLatestRef';

export interface UsePaneSinkRegistrationOptions {
  deviceId: string;
  paneId: string;
  instance: CompatibleTerminalLike | null;
  surfaceRef: RefObject<TerminalSurface<TerminalRenderTarget> | null>;
  containerRef: RefObject<HTMLDivElement | null>;
  /** 是否把本 pane 计入 wire 订阅集合（默认 true）；sink 注册与之无关，恒生效 */
  subscribe?: boolean;
  /** 保活池里的隐藏实例：渲染挂起期间不自动续拉 history */
  renderSuspended?: boolean;
}

/**
 * pane 数据面：把 gateway 的 live/snapshot/history/rebase 接进当前渲染面，
 * 并负责 pane 挂载、首屏请求与向上滚动时的 history 续拉。
 */
export function usePaneSinkRegistration({
  deviceId,
  paneId,
  instance,
  surfaceRef,
  containerRef,
  subscribe = true,
  renderSuspended = false,
}: UsePaneSinkRegistrationOptions): void {
  const runtime = useRuntime();
  const mountPane = useTmuxStore((state) => state.mountPane);
  const requestPaneScreen = useTmuxStore((state) => state.requestPaneScreen);
  const fetchPaneHistory = useTmuxStore((state) => state.fetchPaneHistory);
  // 首屏只按终端实例请求一次：实例换代（重试、字体变更）才重新请求，
  // deviceId/paneId 变动不触发第二次。
  const screenRequestedForRef = useRef<CompatibleTerminalLike | null>(null);
  const prefetchRef = useRef<HistoryPrefetchController<GatewayHistoryCursor> | null>(null);
  // 经 ref 读：挂起状态翻转不能重建控制器，否则在途标记丢失后会用同一游标再请求一次，
  // 拿回重复页反而触发整屏重取。
  const renderSuspendedRef = useLatestRef(renderSuspended);

  const paneSink: PaneSink | null = useMemo(() => {
    if (!instance) {
      return null;
    }

    return {
      onOutput: (data, frame) => {
        surfaceRef.current?.write(frame ?? { deviceId, paneId, data });
      },
      onScreenSnapshot: (snapshot) => surfaceRef.current?.replace(snapshot),
      onHistoryPage: (page) => {
        // 先落地再续发：游标要等 applyHistoryPage 推进后才指向更旧的一页
        surfaceRef.current?.applyHistoryPage(page);
        prefetchRef.current?.handlePageArrived();
      },
      onRebase: (reason) => surfaceRef.current?.rebase(reason),
    };
  }, [deviceId, instance, paneId, surfaceRef]);

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

  // canonical 能力是连接协商出来的，翻转时不会自己触发重渲染：终端现在可能先于 WS READY
  // 挂载（本地拓扑给得出 pane id 即挂），订阅这条信号才能在协商完成的那一刻发出首屏请求。
  const subscribeFeedMode = useCallback(
    (onChange: () => void) =>
      runtime.transport.onEvent((event) => {
        if (event.type === 'state-feed-mode') onChange();
      }),
    [runtime]
  );
  const atomicScreen = useSyncExternalStore(
    subscribeFeedMode,
    () => runtime.transport.capabilities.atomicScreen,
    () => runtime.transport.capabilities.atomicScreen
  );

  useEffect(() => {
    if (!instance || !atomicScreen || screenRequestedForRef.current === instance) {
      return;
    }
    screenRequestedForRef.current = instance;
    requestPaneScreen(deviceId, paneId);
  }, [atomicScreen, deviceId, instance, paneId, requestPaneScreen]);

  useEffect(() => {
    if (!instance || !runtime.transport.capabilities.cursorHistory) return;
    const container = containerRef.current;
    if (!container) return;

    const controller = new HistoryPrefetchController<GatewayHistoryCursor>({
      isVisible: () => !renderSuspendedRef.current,
      getCursor: () => surfaceRef.current?.getNextHistoryCursor() ?? null,
      getViewport: () => ({ viewportY: instance.buffer.active.viewportY, rows: instance.rows }),
      request: (cursor) => fetchPaneHistory(deviceId, paneId, cursor),
      deadlineMs: () => historyRequestDeadlineMs(runtime.transport.latencyMs),
    });
    prefetchRef.current = controller;

    const handleWheel = (event: WheelEvent): void => controller.handleWheel(event.deltaY);
    container.addEventListener('wheel', handleWheel, { passive: true });
    return () => {
      container.removeEventListener('wheel', handleWheel);
      controller.dispose();
      if (prefetchRef.current === controller) prefetchRef.current = null;
    };
  }, [
    containerRef,
    deviceId,
    fetchPaneHistory,
    instance,
    paneId,
    renderSuspendedRef,
    runtime,
    surfaceRef,
  ]);
}
