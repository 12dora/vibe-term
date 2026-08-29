// 设备管理面板：设备卡片网格 + 新建对话框 + 空态/加载/错误态（每张卡片的编辑与删除
// 由 DeviceCardHost 自己管）。数据自取（fetchDevices + 注入 queryKey），REST 一律经
// runtime.apiClient；「添加设备」既可经全局事件（缺省监听，多面板宿主可关）也可经 ref 命令式打开。

import { useQuery } from '@tanstack/react-query';
import { devicesQueryKey as defaultDevicesQueryKey, fetchDevices } from '@tmex/api-client';
import type { Device } from '@tmex/shared';
import { toBCP47 } from '@tmex/shared';
import { useRuntime, useSiteStore, useTmuxStore } from '@tmex/stores/react';
import { cn } from '@tmex/ui';
import { Button } from '@tmex/ui/button';
import { Card, CardContent } from '@tmex/ui/card';
import { staggerItemStyle } from '@tmex/ui/motion';
import { Monitor, Plus } from 'lucide-react';
import {
  Fragment,
  type ReactNode,
  type Ref,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { DeviceConnectionAdapter } from '../device-connection';
import { DeviceCardHost } from './device-card-host';
import { DeviceDialog } from './device-dialog';
import type { DeviceNodeContext } from './device-node-context';
import { OPEN_ADD_DEVICE_EVENT } from './events';

/** 首屏逐项入场的延迟档位上限（35ms/档），超出的卡片与最后一档同时进场 */
const STAGGER_MAX_INDEX = 11;

export interface DeviceManagementPanelHandle {
  openAddDevice(): void;
}

/**
 * 全局「添加设备」事件的订阅；`enabled` 为 false 时**不注册任何监听**，
 * 供聚合宿主（每个 node 一个面板）避免一次事件同时弹开所有面板的对话框。
 */
export function subscribeOpenAddDevice(
  enabled: boolean,
  onOpen: () => void
): (() => void) | undefined {
  if (!enabled) return undefined;
  window.addEventListener(OPEN_ADD_DEVICE_EVENT, onOpen);
  return () => window.removeEventListener(OPEN_ADD_DEVICE_EVENT, onOpen);
}

export interface DeviceManagementPanelProps {
  /** 设备列表查询 key；多实例宿主按 gateway 区分，缺省与既有共享缓存一致 */
  devicesQueryKey?: readonly unknown[];
  /** 是否监听全局 OPEN_ADD_DEVICE_EVENT 打开新建对话框；多面板宿主可关掉改用 ref 控制 */
  listenOpenAddDeviceEvent?: boolean;
  /** 该面板所展示的 node；缺省视为 entry 自身 */
  nodeContext?: DeviceNodeContext;
  /** 有它卡片才显示真实连接/断开开关；没有时退化为只有「打开」 */
  connection?: DeviceConnectionAdapter;
  /** 这些设备不在本面板网格里渲染（已被宿主放进文件夹之类的容器） */
  excludeDeviceIds?: ReadonlySet<string>;
  /** 宿主在卡片外再包一层（拖拽把手等） */
  renderCard?: (card: ReactNode, device: Device, index: number) => ReactNode;
  /** 列表为空/全被排除时不渲染空态卡片，只留对话框 */
  hideEmptyState?: boolean;
  className?: string;
  ref?: Ref<DeviceManagementPanelHandle>;
}

export function DeviceManagementPanel({
  devicesQueryKey = defaultDevicesQueryKey,
  listenOpenAddDeviceEvent = true,
  nodeContext,
  connection,
  excludeDeviceIds,
  renderCard,
  hideEmptyState = false,
  className,
  ref,
}: DeviceManagementPanelProps) {
  const { t } = useTranslation();
  const runtime = useRuntime();
  const [showAddModal, setShowAddModal] = useState(false);
  const language = useSiteStore((state) => state.settings?.language ?? 'en_US');

  const resolvedNodeContext = useMemo<DeviceNodeContext>(
    () => nodeContext ?? { runtimeNodeId: runtime.nodeId, name: '', isSelf: true },
    [nodeContext, runtime.nodeId]
  );

  useImperativeHandle(ref, () => ({ openAddDevice: () => setShowAddModal(true) }), []);

  useEffect(
    () => subscribeOpenAddDevice(listenOpenAddDeviceEvent, () => setShowAddModal(true)),
    [listenOpenAddDeviceEvent]
  );

  const { data, isLoading, isError } = useQuery({
    queryKey: devicesQueryKey,
    queryFn: () => fetchDevices(runtime.apiClient),
    throwOnError: false,
  });

  const hydrateDeviceErrors = useTmuxStore((state) => state.hydrateDeviceErrors);

  useEffect(() => {
    if (!data?.devices) return;
    hydrateDeviceErrors(
      data.devices.map((d) => ({
        deviceId: d.id,
        lastError: d.lastError ?? null,
        lastErrorType: d.lastErrorType ?? null,
      }))
    );
  }, [data, hydrateDeviceErrors]);

  // 卡片顺序与侧边栏 Panes Tab 一致：先 sortOrder，再按设备名 locale 感知排序
  const devices = useMemo(() => {
    const list = data?.devices ?? [];
    return [...list].sort(
      (a, b) =>
        a.sortOrder - b.sortOrder ||
        a.name.localeCompare(b.name, toBCP47(language), { numeric: true, sensitivity: 'base' })
    );
  }, [data?.devices, language]);

  const visibleDevices = useMemo(
    () =>
      excludeDeviceIds ? devices.filter((device) => !excludeDeviceIds.has(device.id)) : devices,
    [devices, excludeDeviceIds]
  );

  // 逐项入场只做首屏那一批：之后 refetch/新增设备不再整列表重放（新卡片按 index 0 单独淡入）。
  // 延迟档位封顶 STAGGER_MAX_INDEX，避免长列表拖尾。
  const initialBatchRef = useRef<ReadonlySet<string> | null>(null);
  if (initialBatchRef.current === null && data) {
    initialBatchRef.current = new Set(devices.map((device) => device.id));
  }
  const initialBatch = initialBatchRef.current;

  const emptyState = hideEmptyState ? null : (
    <Card size="sm" className="tmex-reveal">
      <CardContent className="space-y-3 py-8 text-center">
        <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-muted">
          <Monitor className="h-5 w-5 text-muted-foreground" />
        </div>
        <div className="space-y-0.5">
          <h2 className="text-sm font-medium">{t('device.noDevices')}</h2>
          <p className="text-xs text-muted-foreground">{t('device.addDevice')}</p>
        </div>
        <Button
          variant="default"
          size="sm"
          data-testid="devices-add-empty"
          onClick={() => setShowAddModal(true)}
        >
          <Plus className="h-4 w-4" />
          {t('device.addDevice')}
        </Button>
      </CardContent>
    </Card>
  );

  return (
    <div
      className={cn(
        'mx-auto flex w-full max-w-6xl flex-col gap-3 p-3 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:p-5',
        className
      )}
      data-testid="devices-page"
    >
      {isLoading ? (
        <Card size="sm" className="tmex-reveal">
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {t('common.loading')}
          </CardContent>
        </Card>
      ) : isError ? (
        <Card size="sm" className="tmex-reveal">
          <CardContent className="py-10 text-center text-sm text-destructive">
            {t('device.loadFailed')}
          </CardContent>
        </Card>
      ) : visibleDevices.length === 0 ? (
        emptyState
      ) : (
        <div className="tmex-stagger grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {visibleDevices.map((device, index) => {
            const card = (
              <DeviceCardHost
                device={device}
                queryKey={devicesQueryKey}
                nodeContext={resolvedNodeContext}
                connection={connection}
                style={
                  initialBatch?.has(device.id)
                    ? staggerItemStyle(Math.min(index, STAGGER_MAX_INDEX))
                    : undefined
                }
              />
            );
            return (
              <Fragment key={device.id}>
                {renderCard ? renderCard(card, device, index) : card}
              </Fragment>
            );
          })}
        </div>
      )}

      {showAddModal && (
        <DeviceDialog
          mode="create"
          nodeContext={resolvedNodeContext}
          queryKey={devicesQueryKey}
          onClose={() => setShowAddModal(false)}
        />
      )}
    </div>
  );
}
