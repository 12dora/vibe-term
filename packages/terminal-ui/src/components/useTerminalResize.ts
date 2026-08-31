import type { CompatibleTerminalLike } from 'ghostty-terminal';
import type { FitAddon } from 'ghostty-terminal';
import { type RefObject, useCallback, useEffect, useRef } from 'react';
import {
  type TerminalResizeGate,
  type TerminalResizeKind,
  TerminalResizeReporter,
  type TerminalSizingMode,
} from './terminal-resize-reporter';
import {
  RafCoalescer,
  TerminalResizeScheduler,
  browserResizeSchedulerTimers,
  readDocumentFontsReady,
} from './terminal-resize-scheduler';
import {
  type ViewportRestorePendingState,
  createViewportRestoreController,
} from './terminal-viewport-restore';

interface UseTerminalResizeOptions {
  deviceId: string;
  paneId: string;
  deviceConnected: boolean;
  isSelectionInvalid: boolean;
  /**
   * report（默认）：容器尺寸变化测量后上报 onResize/onSync（单 pane 整窗语义）。
   * follow：分屏模式，pane 尺寸由 tmux layout 决定，本地只对齐不上报，
   * 避免多个 pane 实例互相抢整窗尺寸。
   * local：保活池里的隐藏实例，测量并对齐本地行列但不上报。
   */
  sizingMode?: TerminalSizingMode;
  onResize: (cols: number, rows: number) => void;
  onSync: (cols: number, rows: number) => void;
  /**
   * resize/sync 成功上报后附加触发（同 150ms 防抖节奏）。
   * 用于 resize 路径附加发一次主题同步消息（KIND_TMUX_SET_WINDOW_STYLE），
   * 让 gateway 重查 OSC 11 代答色，避免 resize 后 TUI 颜色与前端主题脱节。
   * 仅在 reportSize 实际上报（非 short-circuit）时触发。
   */
  onResizeSettled?: (cols: number, rows: number) => void;
  /** 获取容器尺寸的回调函数，用于 fitAddon 失败时的回退计算 */
  getContainerRect?: () => { width: number; height: number } | null;
}

type ResizeCallbacks = Pick<
  UseTerminalResizeOptions,
  'onResize' | 'onSync' | 'onResizeSettled' | 'getContainerRect'
>;

type ScheduleResize = (
  kind?: TerminalResizeKind,
  options?: { immediate?: boolean; force?: boolean }
) => void;

interface ResizeActions {
  scheduleResize: ScheduleResize;
  runPostSelectResize: () => void;
  clearPostSelectResizeTimers: () => void;
}

function useConstant<T>(create: () => T): T {
  const ref = useRef<T | null>(null);
  if (ref.current === null) {
    ref.current = create();
  }
  return ref.current;
}

/**
 * 把随渲染变化的回调镜像进 ref，供调度器的异步回调读取最新值。
 * 必须在渲染期同步写入：放进 passive effect 的话，「渲染完成 → effect 执行」这段窗口里
 * 触发的防抖任务会拿到上一帧的回调（保活切换时即隐藏实例的 no-op 与可见实例的真回调错位）。
 */
function useResizeCallbacksRef(callbacks: ResizeCallbacks): RefObject<ResizeCallbacks> {
  const { onResize, onSync, onResizeSettled, getContainerRect } = callbacks;
  const ref = useRef<ResizeCallbacks>({ onResize, onSync, onResizeSettled, getContainerRect });
  ref.current = { onResize, onSync, onResizeSettled, getContainerRect };
  return ref;
}

function useResizeReporter(
  callbacksRef: RefObject<ResizeCallbacks>,
  gateRef: RefObject<TerminalResizeGate>,
  terminalRef: RefObject<CompatibleTerminalLike | null>,
  fitAddonRef: RefObject<FitAddon | null>
): TerminalResizeReporter {
  return useConstant(
    () =>
      new TerminalResizeReporter({
        getGate: () => gateRef.current,
        getTerminal: () => terminalRef.current,
        getProposer: () => fitAddonRef.current,
        getContainerRect: () => callbacksRef.current.getContainerRect?.() ?? null,
        getHandlers: () => callbacksRef.current,
      })
  );
}

function useResizeActions(
  reporter: TerminalResizeReporter,
  scheduler: TerminalResizeScheduler
): ResizeActions {
  const reportSize = useCallback(
    (kind: TerminalResizeKind, force: boolean) => reporter.report({ kind, force }),
    [reporter]
  );

  const scheduleResize = useCallback<ScheduleResize>(
    (kind = 'resize', options = {}) => {
      const { immediate = false, force = false } = options;
      scheduler.schedule(() => reportSize(kind, force), { immediate });
    },
    [reportSize, scheduler]
  );

  const runPostSelectResize = useCallback(() => {
    scheduler.runPostSelect(
      () => scheduleResize('sync', { immediate: true, force: true }),
      readDocumentFontsReady
    );
  }, [scheduleResize, scheduler]);

  const clearPostSelectResizeTimers = useCallback(() => {
    scheduler.clearPostSelectTimers();
  }, [scheduler]);

  return { scheduleResize, runPostSelectResize, clearPostSelectResizeTimers };
}

/** 浏览器窗口 resize：先过一帧 RAF 等布局稳定，再共享 scheduleResize 的防抖 */
function useWindowResizeListener(scheduleResize: ScheduleResize): void {
  useEffect(() => {
    const coalescer = new RafCoalescer(browserResizeSchedulerTimers);
    const handleWindowResize = () => {
      coalescer.request(() => scheduleResize('resize'));
    };

    window.addEventListener('resize', handleWindowResize);
    return () => {
      window.removeEventListener('resize', handleWindowResize);
      coalescer.cancel();
    };
  }, [scheduleResize]);
}

interface ViewportRestoreListenerOptions {
  reporter: TerminalResizeReporter;
  terminalRef: RefObject<CompatibleTerminalLike | null>;
  pending: ViewportRestorePendingState;
  requestSync: () => void;
}

function useViewportRestoreListeners({
  reporter,
  terminalRef,
  pending,
  requestSync,
}: ViewportRestoreListenerOptions): void {
  useEffect(() => {
    const controller = createViewportRestoreController({
      pending,
      getCurrentSize: () => {
        const term = terminalRef.current;
        if (!term) {
          return null;
        }
        return { cols: Math.max(2, term.cols), rows: Math.max(2, term.rows) };
      },
      measureContainerSize: () => reporter.measure(),
      // ?.() 容错老版本 terminal 暂未提供 forceFullRepaint 的情形
      forceFullRepaint: () => {
        terminalRef.current?.forceFullRepaint?.();
      },
      requestSync,
    });

    const handleVisibilityChange = () => {
      controller.handleVisibilityChange(document.visibilityState === 'visible');
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('blur', controller.handleWindowBlur);
    window.addEventListener('focus', controller.handleWindowFocus);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('blur', controller.handleWindowBlur);
      window.removeEventListener('focus', controller.handleWindowFocus);
    };
  }, [pending, reporter, requestSync, terminalRef]);
}

interface ResizeLifecycleOptions extends Omit<ViewportRestoreListenerOptions, 'requestSync'> {
  scheduler: TerminalResizeScheduler;
  scheduleResize: ScheduleResize;
}

function useResizeLifecycle({
  scheduler,
  scheduleResize,
  reporter,
  terminalRef,
  pending,
}: ResizeLifecycleOptions): void {
  const requestSync = useCallback(() => {
    scheduleResize('sync', { force: true });
  }, [scheduleResize]);

  useWindowResizeListener(scheduleResize);
  useViewportRestoreListeners({ reporter, terminalRef, pending, requestSync });

  useEffect(() => {
    return () => {
      scheduler.dispose();
    };
  }, [scheduler]);
}

function useTerminalHandles(
  reporter: TerminalResizeReporter,
  terminalRef: RefObject<CompatibleTerminalLike | null>,
  fitAddonRef: RefObject<FitAddon | null>
) {
  const setFitAddon = useCallback(
    (addon: FitAddon | null) => {
      fitAddonRef.current = addon;
    },
    [fitAddonRef]
  );

  const setTerminal = useCallback(
    (terminal: CompatibleTerminalLike | null) => {
      terminalRef.current = terminal;
    },
    [terminalRef]
  );

  const clearPendingLocalSize = useCallback(() => {
    reporter.pendingLocalSize.current = null;
  }, [reporter]);

  return { setFitAddon, setTerminal, clearPendingLocalSize };
}

export function useTerminalResize({
  deviceId,
  paneId,
  deviceConnected,
  isSelectionInvalid,
  sizingMode = 'report',
  onResize,
  onSync,
  onResizeSettled,
  getContainerRect,
}: UseTerminalResizeOptions) {
  const fitAddonRef = useRef<FitAddon | null>(null);
  const terminalRef = useRef<CompatibleTerminalLike | null>(null);
  const pending: ViewportRestorePendingState = useRef(false);

  const callbacksRef = useResizeCallbacksRef({
    onResize,
    onSync,
    onResizeSettled,
    getContainerRect,
  });

  const gateRef = useRef<TerminalResizeGate>({
    deviceId,
    paneId,
    deviceConnected,
    isSelectionInvalid,
    sizingMode,
  });
  gateRef.current = { deviceId, paneId, deviceConnected, isSelectionInvalid, sizingMode };

  const reporter = useResizeReporter(callbacksRef, gateRef, terminalRef, fitAddonRef);
  const scheduler = useConstant(() => new TerminalResizeScheduler(browserResizeSchedulerTimers));
  const actions = useResizeActions(reporter, scheduler);

  useResizeLifecycle({
    scheduler,
    scheduleResize: actions.scheduleResize,
    reporter,
    terminalRef,
    pending,
  });

  const handles = useTerminalHandles(reporter, terminalRef, fitAddonRef);

  return {
    ...actions,
    ...handles,
    lastReportedSize: reporter.lastReportedSize,
    lastMeasuredRect: reporter.lastMeasuredRect,
    pendingLocalSize: reporter.pendingLocalSize,
    suppressLocalResizeUntil: reporter.suppressLocalResizeUntil,
  };
}
