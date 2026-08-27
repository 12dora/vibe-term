import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  devicesQueryKey as defaultDevicesQueryKey,
  fetchDevices,
  reorderDevices,
} from '@tmex/api-client';
import type { Device } from '@tmex/shared';
import { toBCP47 } from '@tmex/shared';
import { hostAppPath } from '@tmex/stores';
import { useRuntime, useSiteStore, useTmuxStore, useUIStore } from '@tmex/stores/react';
import { Button } from '@tmex/ui/button';
import { ScrollArea } from '@tmex/ui/scroll-area';
import { SidebarGroup } from '@tmex/ui/sidebar';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { DeviceConnectionAdapter } from '../device-connection';
import type { SidebarAgentAdapter } from './agent-adapter';
import { DeviceRow } from './device-row';
import { useDeviceTreeDialogs } from './device-tree-dialogs';
import { SortableVerticalList } from './device-tree-dnd';
import { useDeviceTreeNavigationApi, useDeviceTreeSelection } from './device-tree-navigation';

type DeviceListItem = Device & {
  lastError?: string | null;
  lastErrorType?: string | null;
};

const identityExpansionKey = (deviceId: string) => deviceId;

export interface SideBarDeviceListProps {
  /** 展开/选中设备时保证已订阅其 tmux 快照（宿主接自己的连接管理） */
  ensureDeviceSubscribed: (deviceId: string) => void;
  /** ui store sidebarDeviceExpanded 的 key 映射；多 runtime 宿主传复合 key，缺省恒等 */
  expansionKeyFor?: (deviceId: string) => string;
  /** 设备列表 react-query key；缺省沿用 ['devices'] */
  devicesQueryKey?: readonly unknown[];
  /** agent 会话装饰；未传时不渲染任何 agent 面 */
  agent?: SidebarAgentAdapter;
  /** 宿主连接管理；未传时不渲染连接开关，展开仍走 ensureDeviceSubscribed */
  connection?: DeviceConnectionAdapter;
}

export function SideBarDeviceList({
  ensureDeviceSubscribed,
  expansionKeyFor,
  devicesQueryKey,
  agent,
  connection,
}: SideBarDeviceListProps) {
  const { t } = useTranslation();
  const runtime = useRuntime();
  const { host } = runtime;

  const expansionKey = expansionKeyFor ?? identityExpansionKey;
  const queryKey = devicesQueryKey ?? defaultDevicesQueryKey;
  const agentAdapter = runtime.features.agentUi ? agent : undefined;

  const sidebarDeviceExpanded = useUIStore((state) => state.sidebarDeviceExpanded);
  const setSidebarDeviceExpanded = useUIStore((state) => state.setSidebarDeviceExpanded);

  const { selectedDeviceId, selectedWindowId, selectedPaneId } = useDeviceTreeSelection();

  const snapshots = useTmuxStore((state) => state.snapshots);
  const deviceConnected = useTmuxStore((state) => state.deviceConnected);
  const deviceErrors = useTmuxStore((state) => state.deviceErrors);
  const deviceReconnecting = useTmuxStore((state) => state.deviceReconnecting);
  const closeWindow = useTmuxStore((state) => state.closeWindow);
  const language = useSiteStore((state) => state.settings?.language ?? 'en_US');

  const devicesQuery = useQuery({
    queryKey,
    queryFn: () => fetchDevices(runtime.apiClient),
    throwOnError: false,
  });
  const devicesData = devicesQuery.data;

  const hydrateDeviceErrors = useTmuxStore((state) => state.hydrateDeviceErrors);

  useEffect(() => {
    if (!devicesData?.devices) return;
    hydrateDeviceErrors(
      devicesData.devices.map((d) => ({
        deviceId: d.id,
        lastError: d.lastError ?? null,
        lastErrorType: d.lastErrorType ?? null,
      }))
    );
  }, [devicesData, hydrateDeviceErrors]);

  const { handleNavigate, navigateToPane, navigateToWindow, nav } = useDeviceTreeNavigationApi();

  const handleCloseWindow = useCallback(
    (deviceId: string, windowId: string) => {
      // If closing the currently selected window, navigate to fallback
      if (deviceId === selectedDeviceId && windowId === selectedWindowId) {
        handleNavigate(hostAppPath(host, '/devices'));
      }
      closeWindow(deviceId, windowId);
    },
    [closeWindow, selectedDeviceId, selectedWindowId, handleNavigate, host]
  );

  const {
    requestCloseWindow,
    requestClosePane,
    requestRenameWindow,
    requestRenamePane,
    requestWatchPane,
    dialogs,
  } = useDeviceTreeDialogs({ onCloseWindow: handleCloseWindow });

  const handleCreateWindow = useCallback(
    (deviceId: string) => {
      runtime.stores.tmux.getState().createWindow(deviceId);
    },
    [runtime]
  );

  const queryClient = useQueryClient();

  const reorderDevicesMutation = useMutation({
    mutationFn: (deviceIds: string[]) => reorderDevices(deviceIds, runtime.apiClient),
    onMutate: async (deviceIds: string[]) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<{ devices: DeviceListItem[] }>(queryKey);
      if (previous) {
        const byId = new Map(previous.devices.map((d) => [d.id, d]));
        const reordered = deviceIds
          .map((id, index) => {
            const d = byId.get(id);
            return d ? { ...d, sortOrder: index } : undefined;
          })
          .filter((d): d is DeviceListItem => d !== undefined);
        const rest = previous.devices.filter((d) => !deviceIds.includes(d.id));
        queryClient.setQueryData(queryKey, { devices: [...reordered, ...rest] });
      }
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(queryKey, context.previous);
      toast.error(t('device.reorderFailed'));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  // 必须锁住引用：本组件订阅了 snapshots，终端每次输出都会重渲染。
  // 若每次渲染都新建数组，下面两个 effect 会跟着空跑（对每台设备调 ensureDeviceSubscribed），
  // sortedDevices / knownDeviceIds 两个 useMemo 也永远命中不了缓存。
  const devices = useMemo(() => devicesData?.devices ?? [], [devicesData]);
  const autoExpandedDeviceIdsRef = useRef(new Set<string>());

  const handleDeviceExpandedChange = useCallback(
    (deviceId: string, expanded: boolean) => {
      setSidebarDeviceExpanded(expansionKey(deviceId), expanded);
      // 收起只影响树的可见性，断开必须走 Power 按钮
      if (!expanded) return;
      if (connection) {
        connection.connect(deviceId);
      } else {
        ensureDeviceSubscribed(deviceId);
      }
    },
    [connection, ensureDeviceSubscribed, setSidebarDeviceExpanded, expansionKey]
  );

  useEffect(() => {
    if (!selectedDeviceId || !devices.some((device) => device.id === selectedDeviceId)) return;
    if (autoExpandedDeviceIdsRef.current.has(selectedDeviceId)) return;

    autoExpandedDeviceIdsRef.current.add(selectedDeviceId);
    if (
      !Object.prototype.hasOwnProperty.call(sidebarDeviceExpanded, expansionKey(selectedDeviceId))
    ) {
      setSidebarDeviceExpanded(expansionKey(selectedDeviceId), true);
    }
    ensureDeviceSubscribed(selectedDeviceId);
  }, [
    devices,
    ensureDeviceSubscribed,
    selectedDeviceId,
    setSidebarDeviceExpanded,
    sidebarDeviceExpanded,
    expansionKey,
  ]);

  useEffect(() => {
    for (const device of devices) {
      if (sidebarDeviceExpanded[expansionKey(device.id)] !== false) {
        ensureDeviceSubscribed(device.id);
      }
    }
  }, [devices, ensureDeviceSubscribed, sidebarDeviceExpanded, expansionKey]);

  const sortedDevices = useMemo(
    () =>
      [...devices].sort(
        (a, b) =>
          a.sortOrder - b.sortOrder ||
          a.name.localeCompare(b.name, toBCP47(language), { numeric: true, sensitivity: 'base' })
      ),
    [devices, language]
  );

  const knownDeviceIds = useMemo(() => devices.map((device) => device.id), [devices]);

  return (
    <SidebarGroup className="flex flex-col flex-1 min-h-0 pt-0">
      <ScrollArea className="flex-1 min-h-0">
        <div className="space-y-1.5 pb-2 pt-1 select-none [-webkit-user-select:none] [-webkit-touch-callout:none]">
          <SortableVerticalList
            ids={sortedDevices.map((d) => d.id)}
            disabled={reorderDevicesMutation.isPending}
            onReorder={(nextIds) => reorderDevicesMutation.mutate(nextIds)}
          >
            {sortedDevices.map((device) => (
              <DeviceRow
                key={device.id}
                device={device}
                windows={snapshots[device.id]?.session?.windows ?? null}
                isExpanded={sidebarDeviceExpanded[expansionKey(device.id)] !== false}
                isOnline={
                  deviceConnected[device.id] === true &&
                  !deviceErrors[device.id] &&
                  !deviceReconnecting[device.id]
                }
                isSelected={device.id === selectedDeviceId}
                selectedWindowId={selectedWindowId}
                selectedPaneId={selectedPaneId}
                onExpandedChange={handleDeviceExpandedChange}
                onCreateWindow={handleCreateWindow}
                onCloseWindow={requestCloseWindow}
                onClosePane={requestClosePane}
                onRenameWindow={requestRenameWindow}
                onRenamePane={requestRenamePane}
                onPaneClick={navigateToPane}
                onWindowClick={navigateToWindow}
                onWatchPane={requestWatchPane}
                agent={agentAdapter}
                nav={nav}
                connection={connection}
              />
            ))}
          </SortableVerticalList>
          {sortedDevices.length === 0 &&
            (devicesQuery.isError ? (
              <div
                data-testid="sidebar-devices-error"
                className="flex flex-col items-center gap-2 py-4 text-center"
              >
                <span className="text-sm text-muted-foreground">{t('device.loadFailed')}</span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  data-testid="sidebar-devices-retry"
                  disabled={devicesQuery.isFetching}
                  onClick={() => void devicesQuery.refetch()}
                >
                  {t('common.retry')}
                </Button>
              </div>
            ) : (
              <div className="text-center text-sm text-muted-foreground py-4">
                {t('sidebar.noDevices')}
              </div>
            ))}

          {agentAdapter && (
            <agentAdapter.OrphanSessions nav={nav} knownDeviceIds={knownDeviceIds} />
          )}
        </div>
      </ScrollArea>

      {dialogs}

      {agentAdapter && <agentAdapter.Dialogs />}
    </SidebarGroup>
  );
}
