// 回放终端：薄适配共享 ReadOnlyTerminal（平移视口 + 选区）。
// handle 在 widget 未就绪时为空操作；ready 随 onReady / onDispose 翻转。播放机合同不变。

import { ReadOnlyTerminal, type ReadOnlyTerminalHandle } from '@vibeterm/terminal-ui';
import { type ReactElement, createElement, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

export interface ReplayTerminalHandle {
  write: (data: Uint8Array) => void;
  resize: (cols: number, rows: number) => void;
  reset: () => void;
  fit: () => void;
}

export interface ReplayTerminalState {
  handle: ReplayTerminalHandle;
  /** 终端实例已就绪：回放要等它才开始喂数据。 */
  ready: boolean;
  /** 已经就绪过至少一次：改字号会重建实例，那之后不该再闪「加载中」。 */
  booted: boolean;
  /** 实例代次，每次就绪 +1。重建太快时 ready 可能在一次渲染里就翻回 true，布尔值看不出换了一台。 */
  generation: number;
  widget: ReactElement;
}

export function createReplayTerminalBinding(onReadyChange: (ready: boolean) => void): {
  handle: ReplayTerminalHandle;
  onReady: (widget: ReadOnlyTerminalHandle) => void;
  onDispose: () => void;
} {
  let widget: ReadOnlyTerminalHandle | null = null;
  return {
    handle: {
      write(data) {
        if (data.length === 0) return;
        widget?.write(data);
      },
      resize(cols, rows) {
        widget?.resize(cols, rows);
      },
      reset() {
        widget?.reset();
      },
      fit() {
        widget?.fit();
      },
    },
    onReady(next) {
      widget = next;
      onReadyChange(true);
    },
    onDispose() {
      widget = null;
      onReadyChange(false);
    },
  };
}

/** `fontSize` 由外框自适应算出；变了终端会重建，播放机随后按当前时刻重新快进。 */
export function useReplayTerminal(fontSize?: number): ReplayTerminalState {
  const { t } = useTranslation();
  const [ready, setReady] = useState(false);
  const [booted, setBooted] = useState(false);
  const [generation, setGeneration] = useState(0);
  const bindingRef = useRef<ReturnType<typeof createReplayTerminalBinding> | null>(null);
  if (bindingRef.current === null) {
    bindingRef.current = createReplayTerminalBinding((next) => {
      setReady(next);
      if (!next) return;
      setBooted(true);
      setGeneration((prev) => prev + 1);
    });
  }
  const binding = bindingRef.current;
  const ariaLabel = t('settings.share.replay.title');

  const widget = useMemo(
    () =>
      createElement(ReadOnlyTerminal, {
        viewportPan: true,
        surfaceFrame: true,
        selection: true,
        fontSize,
        onReady: binding.onReady,
        onDispose: binding.onDispose,
        testId: 'share-replay-mount',
        ariaLabel,
      }),
    [binding, ariaLabel, fontSize]
  );

  return { handle: binding.handle, ready, booted, generation, widget };
}
