import { buildWindowTitleParts } from '@tmex/stores';
import { useRuntime, useTmuxStore } from '@tmex/stores/react';
import { useCallback, useState } from 'react';

export type RenameCandidate =
  | { kind: 'window'; deviceId: string; windowId: string; hasCustomName: boolean }
  | { kind: 'pane'; deviceId: string; paneId: string; hasCustomName: boolean };

export interface RenameDialogState {
  candidate: RenameCandidate | null;
  value: string;
  setValue: (value: string) => void;
  requestRenameWindow: (deviceId: string, windowId: string) => void;
  requestRenamePane: (deviceId: string, paneId: string) => void;
  confirm: () => void;
  /** 清空自定义名，回落到 tmux 原生标题 */
  resetName: () => void;
  dismiss: () => void;
}

export function useRenameDialog(): RenameDialogState {
  const runtime = useRuntime();
  const renameWindow = useTmuxStore((state) => state.renameWindow);
  const renamePane = useTmuxStore((state) => state.renamePane);

  const [candidate, setCandidate] = useState<RenameCandidate | null>(null);
  const [value, setValue] = useState('');

  const requestRenameWindow = useCallback(
    (deviceId: string, windowId: string) => {
      const windows = runtime.stores.tmux.getState().snapshots[deviceId]?.session?.windows;
      const target = windows?.find((w) => w.id === windowId);
      if (!target) return;
      // 用 rawTitle：展示用 title 会补 U+FE0E 强制文本呈现，不能回写进 tmux 窗口名
      setValue(target.customName ?? buildWindowTitleParts(target).rawTitle);
      setCandidate({
        kind: 'window',
        deviceId,
        windowId,
        hasCustomName: Boolean(target.customName),
      });
    },
    [runtime]
  );

  const requestRenamePane = useCallback(
    (deviceId: string, paneId: string) => {
      const windows = runtime.stores.tmux.getState().snapshots[deviceId]?.session?.windows;
      const target = windows?.flatMap((w) => w.panes).find((p) => p.id === paneId);
      if (!target) return;
      setValue(target.customName ?? target.title ?? '');
      setCandidate({ kind: 'pane', deviceId, paneId, hasCustomName: Boolean(target.customName) });
    },
    [runtime]
  );

  const applyRename = useCallback(
    (name: string) => {
      if (!candidate) return;
      if (candidate.kind === 'window') {
        renameWindow(candidate.deviceId, candidate.windowId, name);
      } else {
        renamePane(candidate.deviceId, candidate.paneId, name);
      }
      setCandidate(null);
    },
    [candidate, renameWindow, renamePane]
  );

  const confirm = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed) return;
    applyRename(trimmed);
  }, [applyRename, value]);

  const resetName = useCallback(() => applyRename(''), [applyRename]);

  const dismiss = useCallback(() => setCandidate(null), []);

  return {
    candidate,
    value,
    setValue,
    requestRenameWindow,
    requestRenamePane,
    confirm,
    resetName,
    dismiss,
  };
}
