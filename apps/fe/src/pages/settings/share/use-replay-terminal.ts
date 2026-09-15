// 回放终端：薄适配共享 ReadOnlyTerminal（平移视口 + 选区）。
// handle 在 widget 未就绪时为空操作；ready 随 onReady / onDispose 翻转。
// 网格不由录像里的 resize 决定，而是「窗口 ∪ 录像包络」，由 minGrid 交给 widget 自己算。

import {
  type ReadOnlyGrid,
  ReadOnlyTerminal,
  type ReadOnlyTerminalHandle,
} from '@vibeterm/terminal-ui';
import { type ReactElement, createElement, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

export interface ReplayTerminalHandle {
  write: (data: Uint8Array) => void;
  /** 快照按录制网格写入（见 ReadOnlyTerminalHandle.writeCheckpoint）。 */
  writeCheckpoint: (data: Uint8Array, grid: ReadOnlyGrid) => void;
  reset: () => void;
}

export interface ReplayTerminalState {
  handle: ReplayTerminalHandle;
  /** 终端实例已就绪：回放要等它才开始喂数据。 */
  ready: boolean;
  /** 已经就绪过至少一次：改字号会重建实例，那之后不该再闪「加载中」。 */
  booted: boolean;
  /** 实例代次，每次就绪 +1。重建太快时 ready 可能在一次渲染里就翻回 true，布尔值看不出换了一台。 */
  generation: number;
  /** 字号还没定（外框或录像网格没齐）时为 null：先不开面，免得用户先看到一台没适配的。 */
  widget: ReactElement | null;
}

export interface ReplayTerminalBinding {
  handle: ReplayTerminalHandle;
  onReady: (widget: ReadOnlyTerminalHandle) => void;
  onDispose: () => void;
  /** 生效网格变了（窗口缩放、包络变大）：实例还是那台，但画面要清屏重放。 */
  onGridChange: () => void;
}

/** `onNewFrame` 在「换了一台实例」或「同一台换了网格」时各触发一次：播放机据此重放。 */
export function createReplayTerminalBinding(
  onReadyChange: (ready: boolean) => void,
  onNewFrame: () => void = () => {}
): ReplayTerminalBinding {
  let widget: ReadOnlyTerminalHandle | null = null;
  return {
    handle: {
      write(data) {
        if (data.length === 0) return;
        widget?.write(data);
      },
      writeCheckpoint(data, grid) {
        if (data.length === 0) return;
        widget?.writeCheckpoint(data, grid);
      },
      reset() {
        widget?.reset();
      },
    },
    onReady(next) {
      widget = next;
      onReadyChange(true);
      onNewFrame();
    },
    onDispose() {
      widget = null;
      onReadyChange(false);
    },
    onGridChange() {
      if (widget) onNewFrame();
    },
  };
}

/**
 * `fontSize` 为 null 表示还不到开面的时候（外框/包络没齐）。
 * 字号变会重建终端，网格变（窗口缩放、包络变大）会触发 `onGridChange`：
 * 两者都把 generation 往前推一格，播放机据此清屏并重放到当前时刻——
 * ghostty 在 resize 时会 reflow，不重放的话 TUI 画面会留下残渣。
 */
export function useReplayTerminal(
  fontSize: number | null,
  minGrid: ReadOnlyGrid | null
): ReplayTerminalState {
  const { t } = useTranslation();
  const [ready, setReady] = useState(false);
  const [booted, setBooted] = useState(false);
  const [generation, setGeneration] = useState(0);
  const bindingRef = useRef<ReplayTerminalBinding | null>(null);
  if (bindingRef.current === null) {
    bindingRef.current = createReplayTerminalBinding(
      (next) => {
        setReady(next);
        if (next) setBooted(true);
      },
      () => setGeneration((prev) => prev + 1)
    );
  }
  const binding = bindingRef.current;
  const ariaLabel = t('settings.share.replay.title');
  // 值相同就复用同一个对象：每页日志都会造出一个新包络对象，否则 widget 每页都要重算网格。
  const minCols = minGrid?.cols ?? 0;
  const minRows = minGrid?.rows ?? 0;
  const stableMinGrid = useMemo(
    () => (minCols > 0 && minRows > 0 ? { cols: minCols, rows: minRows } : null),
    [minCols, minRows]
  );

  const widget = useMemo(
    () =>
      fontSize === null
        ? null
        : createElement(ReadOnlyTerminal, {
            viewportPan: true,
            selection: true,
            fontSize,
            minGrid: stableMinGrid,
            onGridChange: binding.onGridChange,
            onReady: binding.onReady,
            onDispose: binding.onDispose,
            testId: 'share-replay-mount',
            ariaLabel,
          }),
    [binding, ariaLabel, fontSize, stableMinGrid]
  );

  return { handle: binding.handle, ready, booted, generation, widget };
}
