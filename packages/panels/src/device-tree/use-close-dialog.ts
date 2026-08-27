import { buildWindowDisplayName } from '@tmex/stores';
import { useRuntime, useTmuxStore } from '@tmex/stores/react';
import { useCallback, useState } from 'react';

export type CloseCandidate =
  | { kind: 'window'; deviceId: string; windowId: string; name: string }
  | { kind: 'pane'; deviceId: string; paneId: string; name: string };

export interface CloseDialogState {
  candidate: CloseCandidate | null;
  requestCloseWindow: (deviceId: string, windowId: string) => void;
  requestClosePane: (deviceId: string, windowId: string, paneId: string) => void;
  confirm: () => void;
  dismiss: () => void;
}

export interface UseCloseDialogOptions {
  /** 确认关闭窗口时执行；由设备树根负责关闭前的路由回退 */
  onCloseWindow: (deviceId: string, windowId: string) => void;
}

export function useCloseDialog({ onCloseWindow }: UseCloseDialogOptions): CloseDialogState {
  const runtime = useRuntime();
  const closePane = useTmuxStore((state) => state.closePane);
  const [candidate, setCandidate] = useState<CloseCandidate | null>(null);

  const requestCloseWindow = useCallback(
    (deviceId: string, windowId: string) => {
      const windows = runtime.stores.tmux.getState().snapshots[deviceId]?.session?.windows;
      const target = windows?.find((w) => w.id === windowId);
      setCandidate({
        kind: 'window',
        deviceId,
        windowId,
        name: target ? buildWindowDisplayName(target) : '',
      });
    },
    [runtime]
  );

  const requestClosePane = useCallback(
    (deviceId: string, windowId: string, paneId: string) => {
      const windows = runtime.stores.tmux.getState().snapshots[deviceId]?.session?.windows;
      const pane = windows?.find((w) => w.id === windowId)?.panes?.find((p) => p.id === paneId);
      setCandidate({
        kind: 'pane',
        deviceId,
        paneId,
        name: pane?.title || `Pane ${pane?.index ?? ''}`,
      });
    },
    [runtime]
  );

  const confirm = useCallback(() => {
    if (!candidate) return;
    if (candidate.kind === 'window') {
      onCloseWindow(candidate.deviceId, candidate.windowId);
    } else {
      closePane(candidate.deviceId, candidate.paneId);
    }
    setCandidate(null);
  }, [candidate, onCloseWindow, closePane]);

  const dismiss = useCallback(() => setCandidate(null), []);

  return { candidate, requestCloseWindow, requestClosePane, confirm, dismiss };
}
