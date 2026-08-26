import { buildWindowDisplayName, buildWindowTitleParts } from '@tmex/stores';
import { useRuntime, useTmuxStore } from '@tmex/stores/react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@tmex/ui/alert-dialog';
import { Button } from '@tmex/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@tmex/ui/dialog';
import { Input } from '@tmex/ui/input';
import { X } from 'lucide-react';
import { type ReactNode, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { WatchDialog } from '../watch/watch-dialog';

type CloseCandidate =
  | { kind: 'window'; deviceId: string; windowId: string; name: string }
  | { kind: 'pane'; deviceId: string; paneId: string; name: string };

type RenameCandidate =
  | { kind: 'window'; deviceId: string; windowId: string; hasCustomName: boolean }
  | { kind: 'pane'; deviceId: string; paneId: string; hasCustomName: boolean };

export interface DeviceTreeDialogsOptions {
  /** 确认关闭窗口时执行；由设备树根负责关闭前的路由回退 */
  onCloseWindow: (deviceId: string, windowId: string) => void;
}

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
  const { t } = useTranslation();
  const runtime = useRuntime();
  const closePane = useTmuxStore((state) => state.closePane);
  const renameWindow = useTmuxStore((state) => state.renameWindow);
  const renamePane = useTmuxStore((state) => state.renamePane);

  const [closeCandidate, setCloseCandidate] = useState<CloseCandidate | null>(null);
  const [renameCandidate, setRenameCandidate] = useState<RenameCandidate | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [watchTarget, setWatchTarget] = useState<{ deviceId: string; paneId: string } | null>(null);

  const requestCloseWindow = useCallback(
    (deviceId: string, windowId: string) => {
      const windows = runtime.stores.tmux.getState().snapshots[deviceId]?.session?.windows;
      const target = windows?.find((w) => w.id === windowId);
      setCloseCandidate({
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
      setCloseCandidate({
        kind: 'pane',
        deviceId,
        paneId,
        name: pane?.title || `Pane ${pane?.index ?? ''}`,
      });
    },
    [runtime]
  );

  const confirmClose = useCallback(() => {
    if (!closeCandidate) return;
    if (closeCandidate.kind === 'window') {
      onCloseWindow(closeCandidate.deviceId, closeCandidate.windowId);
    } else {
      closePane(closeCandidate.deviceId, closeCandidate.paneId);
    }
    setCloseCandidate(null);
  }, [closeCandidate, onCloseWindow, closePane]);

  const requestRenameWindow = useCallback(
    (deviceId: string, windowId: string) => {
      const windows = runtime.stores.tmux.getState().snapshots[deviceId]?.session?.windows;
      const target = windows?.find((w) => w.id === windowId);
      if (!target) return;
      setRenameValue(target.customName ?? buildWindowTitleParts(target).title);
      setRenameCandidate({
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
      setRenameValue(target.customName ?? target.title ?? '');
      setRenameCandidate({
        kind: 'pane',
        deviceId,
        paneId,
        hasCustomName: Boolean(target.customName),
      });
    },
    [runtime]
  );

  const applyRename = useCallback(
    (name: string) => {
      if (!renameCandidate) return;
      if (renameCandidate.kind === 'window') {
        renameWindow(renameCandidate.deviceId, renameCandidate.windowId, name);
      } else {
        renamePane(renameCandidate.deviceId, renameCandidate.paneId, name);
      }
      setRenameCandidate(null);
    },
    [renameCandidate, renameWindow, renamePane]
  );

  const confirmRename = useCallback(() => {
    const trimmed = renameValue.trim();
    if (!trimmed) return;
    applyRename(trimmed);
  }, [applyRename, renameValue]);

  const resetRename = useCallback(() => {
    applyRename('');
  }, [applyRename]);

  const requestWatchPane = useCallback((deviceId: string, paneId: string) => {
    setWatchTarget({ deviceId, paneId });
  }, []);

  const dialogs = (
    <>
      <AlertDialog
        open={closeCandidate !== null}
        onOpenChange={(open) => !open && setCloseCandidate(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-destructive/10">
              <X className="h-5 w-5 text-destructive" />
            </AlertDialogMedia>
            <AlertDialogTitle>
              {closeCandidate?.kind === 'pane'
                ? t('window.closePaneConfirmTitle')
                : t('window.closeConfirmTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('window.closeConfirmDesc', { name: closeCandidate?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={!closeCandidate}
              onClick={confirmClose}
            >
              {t('common.close')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={renameCandidate !== null}
        onOpenChange={(open) => !open && setRenameCandidate(null)}
      >
        <DialogContent data-testid="window-rename-dialog">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              confirmRename();
            }}
          >
            <DialogHeader>
              <DialogTitle>{t('window.rename')}</DialogTitle>
              <DialogDescription>{t('window.renameDesc')}</DialogDescription>
            </DialogHeader>
            <div className="py-4">
              <Input
                autoFocus
                maxLength={64}
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                placeholder={t('window.renamePlaceholder')}
                data-testid="window-rename-input"
              />
            </div>
            <DialogFooter>
              {renameCandidate?.hasCustomName && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={resetRename}
                  data-testid="window-rename-reset"
                >
                  {t('window.renameReset')}
                </Button>
              )}
              <Button type="button" variant="outline" onClick={() => setRenameCandidate(null)}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={!renameValue.trim()} data-testid="window-rename-save">
                {t('common.save')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

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
    requestCloseWindow,
    requestClosePane,
    requestRenameWindow,
    requestRenamePane,
    requestWatchPane,
    dialogs,
  };
}
