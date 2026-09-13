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

export function useReplayTerminal(): ReplayTerminalState {
  const { t } = useTranslation();
  const [ready, setReady] = useState(false);
  const bindingRef = useRef<ReturnType<typeof createReplayTerminalBinding> | null>(null);
  if (bindingRef.current === null) {
    bindingRef.current = createReplayTerminalBinding(setReady);
  }
  const binding = bindingRef.current;
  const ariaLabel = t('settings.share.replay.title');

  const widget = useMemo(
    () =>
      createElement(ReadOnlyTerminal, {
        viewportPan: true,
        surfaceFrame: true,
        selection: true,
        onReady: binding.onReady,
        onDispose: binding.onDispose,
        testId: 'share-replay-mount',
        ariaLabel,
      }),
    [binding, ariaLabel]
  );

  return { handle: binding.handle, ready, widget };
}
