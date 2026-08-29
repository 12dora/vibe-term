// 控制台操作区：输入模式切换、分屏、跳到最新、watch、终端设置、刷新页面。
// 路由参数由宿主显式传入；paneId 为路由段原值（React Router 已 decode 一次），归一在模型层完成。

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@tmex/ui/alert-dialog';
import { useTranslation } from 'react-i18next';
import { WatchDialog } from '../watch/watch-dialog';
import { DeferredTerminalSettingsSheet } from './deferred-terminal-settings-sheet';
import { DeviceConsoleActionsView } from './device-console-actions-view';
import { useDeviceConsoleActions } from './use-device-console-actions';

export interface DeviceConsoleActionsProps {
  deviceId?: string;
  windowId?: string;
  paneId?: string;
}

export function DeviceConsoleActions({ deviceId, windowId, paneId }: DeviceConsoleActionsProps) {
  const { t } = useTranslation();
  const model = useDeviceConsoleActions({ deviceId, windowId, paneId });

  return (
    <>
      <DeviceConsoleActionsView model={model} />

      <DeferredTerminalSettingsSheet
        open={model.showTerminalSettings}
        onOpenChange={model.setShowTerminalSettings}
      />

      {model.watchUi && deviceId && model.resolvedPaneId && (
        <WatchDialog
          open={model.showWatchDialog}
          onOpenChange={model.setShowWatchDialog}
          deviceId={deviceId}
          paneId={model.resolvedPaneId}
        />
      )}

      <AlertDialog open={model.showRefreshConfirm} onOpenChange={model.setShowRefreshConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('nav.refreshPage')}</AlertDialogTitle>
            <AlertDialogDescription>{t('nav.refreshPageConfirm')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => model.setShowRefreshConfirm(false)}>
              {t('common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction onClick={model.onConfirmRefresh}>
              {t('common.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
