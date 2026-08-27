import { useRuntime } from '@tmex/stores/react';
import { type ReactNode, useCallback, useState } from 'react';
import { WatchDialog } from '../watch/watch-dialog';
import { CloseConfirmDialog } from './close-confirm-dialog';
import { RenameDialog } from './rename-dialog';
import { type UseCloseDialogOptions, useCloseDialog } from './use-close-dialog';
import { useRenameDialog } from './use-rename-dialog';

export type DeviceTreeDialogsOptions = UseCloseDialogOptions;

export interface DeviceTreeDialogsController {
  requestCloseWindow: (deviceId: string, windowId: string) => void;
  requestClosePane: (deviceId: string, windowId: string, paneId: string) => void;
  requestRenameWindow: (deviceId: string, windowId: string) => void;
  requestRenamePane: (deviceId: string, paneId: string) => void;
  requestWatchPane: (deviceId: string, paneId: string) => void;
  /** 关闭确认 / 重命名 / 监视三个对话框，由设备树根节点挂载 */
  dialogs: ReactNode;
}

export function useDeviceTreeDialogs({
  onCloseWindow,
}: DeviceTreeDialogsOptions): DeviceTreeDialogsController {
  const runtime = useRuntime();
  const close = useCloseDialog({ onCloseWindow });
  const rename = useRenameDialog();

  const [watchTarget, setWatchTarget] = useState<{ deviceId: string; paneId: string } | null>(null);
  const requestWatchPane = useCallback((deviceId: string, paneId: string) => {
    setWatchTarget({ deviceId, paneId });
  }, []);

  const dialogs = (
    <>
      <CloseConfirmDialog state={close} />
      <RenameDialog state={rename} />
      {runtime.features.watchUi && watchTarget && (
        <WatchDialog
          open
          onOpenChange={(open) => !open && setWatchTarget(null)}
          deviceId={watchTarget.deviceId}
          paneId={watchTarget.paneId}
        />
      )}
    </>
  );

  return {
    requestCloseWindow: close.requestCloseWindow,
    requestClosePane: close.requestClosePane,
    requestRenameWindow: rename.requestRenameWindow,
    requestRenamePane: rename.requestRenamePane,
    requestWatchPane,
    dialogs,
  };
}
