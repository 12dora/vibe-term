// 已认证的分享视图：专用运行时 + 查询缓存注入后，头部（名称 / 剩余期限 / 断开）与
// 控制台一起挂在里面。控制台看到的 window 恒为分享的那一个，pane 由本页查询参数点名
// （包内的每一次导航都经 host.appPath 映射回来，见 ./share-route）。

import { QueryClientProvider } from '@tanstack/react-query';
import { DeviceConsole, DeviceConsoleActions } from '@tmex/panels/device-console';
import type { TmuxPane } from '@tmex/shared';
import { RuntimeProvider, useRuntime, useTmuxStore } from '@tmex/stores/react';
import { Button } from '@tmex/ui/button';
import { LogOut } from 'lucide-react';
import { useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { resolveSharePaneId } from './share-pane';
import { ShareRemaining } from './share-remaining';
import type { ShareRuntimeHandle } from './share-runtime';

export interface ShareConsoleProps {
  handle: ShareRuntimeHandle;
  name: string;
  expiresAt: number | null;
  deviceId: string;
  windowId: string;
  onDisconnect: () => void;
}

/** 分享 window 当前的 pane 列表；快照未到时为 undefined。 */
function useSharedWindowPanes(deviceId: string, windowId: string): readonly TmuxPane[] | undefined {
  return useTmuxStore(
    (state) =>
      state.snapshots[deviceId]?.session?.windows.find((window) => window.id === windowId)?.panes
  );
}

function ShareConsoleBody({
  name,
  expiresAt,
  deviceId,
  windowId,
  onDisconnect,
}: Omit<ShareConsoleProps, 'handle'>) {
  const { t } = useTranslation();
  const runtime = useRuntime();
  const [params] = useSearchParams();
  const panes = useSharedWindowPanes(deviceId, windowId);
  const paneId = resolveSharePaneId(panes, params.get('p'));

  useEffect(() => {
    runtime.stores.tmux.getState().connectDevice(deviceId);
  }, [deviceId, runtime]);

  // 浏览器标题只给分享名称：设备名 / 节点名一个都不该漏给访客。
  const formatBrowserTitle = useCallback(() => name, [name]);

  return (
    <>
      <header
        className="flex h-12 shrink-0 items-center justify-between gap-2 px-3 md:h-14"
        data-testid="share-header"
      >
        <span className="min-w-0 flex-1 truncate text-sm font-semibold" data-testid="share-name">
          {name}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <ShareRemaining expiresAt={expiresAt} />
          <DeviceConsoleActions deviceId={deviceId} windowId={windowId} paneId={paneId} />
          <Button variant="outline" size="sm" onClick={onDisconnect} data-testid="share-disconnect">
            <LogOut className="size-3.5" />
            {t('shareAccess.disconnect')}
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col p-2 pt-0 md:p-4 md:pt-0">
        <div className="min-h-0 flex-1 overflow-hidden rounded-xl bg-muted/50">
          <DeviceConsole
            deviceId={deviceId}
            windowId={windowId}
            paneId={paneId}
            formatBrowserTitle={formatBrowserTitle}
          />
        </div>
      </div>
    </>
  );
}

export function ShareConsole({ handle, ...rest }: ShareConsoleProps) {
  return (
    <RuntimeProvider runtime={handle.runtime}>
      <QueryClientProvider client={handle.queryClient}>
        <ShareConsoleBody {...rest} />
      </QueryClientProvider>
    </RuntimeProvider>
  );
}
