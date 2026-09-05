// 设备管理面板：设备卡片网格（节点内可拖拽排序，见 device-grid）+ 新建对话框 + 空态/加载/错误态；
// 每张卡片的编辑与删除由 DeviceCardHost 自己管，数据与拖拽状态在 useDeviceManagementState。
// 「添加设备」既可经全局事件（缺省监听，多面板宿主可关）也可经 ref 命令式打开。
//
// `offline`：所属节点离线。不再拉列表，卡片来自 query 缓存里最近一次成功的列表，缓存也没有时
// 退回宿主给的 `fallbackDevices`（本地快照 / 节点 inventory）；卡片带 offline 标记、排序禁用。
// 宽度与内边距由页面级容器统一负责，本面板只是 `w-full`。

import { devicesQueryKey as defaultDevicesQueryKey } from '@tmex/api-client';
import type { Device, DeviceType } from '@tmex/shared';
import { useRuntime } from '@tmex/stores/react';
import { cn } from '@tmex/ui';
import { Button } from '@tmex/ui/button';
import { Card, CardContent } from '@tmex/ui/card';
import { Monitor, Plus } from 'lucide-react';
import { type Ref, useCallback, useEffect, useImperativeHandle, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DeviceConnectionAdapter } from '../device-connection';
import { DeviceDialog } from './device-dialog';
import { DeviceGrid } from './device-grid';
import { describeDeviceLoadError, deviceLoadErrorMessageKey } from './device-load-error';
import type { DeviceNodeContext } from './device-node-context';
import { type AddDevicePreset, OPEN_ADD_DEVICE_EVENT, addDevicePresetFromEvent } from './events';
import { useDeviceManagementState } from './use-device-management-state';

export interface DeviceManagementPanelHandle {
  /** `preset` 预选设备类型（如 SSH 引导路径）；不给就用对话框默认值。 */
  openAddDevice(preset?: AddDevicePreset): void;
}

/**
 * 全局「添加设备」事件的订阅；`enabled` 为 false 时**不注册任何监听**，
 * 供聚合宿主（每个 node 一个面板）避免一次事件同时弹开所有面板的对话框。
 * 事件 detail 里的预选类型一并透出，standalone 兜底路径与 ref 路径行为一致。
 */
export function subscribeOpenAddDevice(
  enabled: boolean,
  onOpen: (preset?: AddDevicePreset) => void
): (() => void) | undefined {
  if (!enabled) return undefined;
  const listener = (event: Event) => onOpen(addDevicePresetFromEvent(event));
  window.addEventListener(OPEN_ADD_DEVICE_EVENT, listener);
  return () => window.removeEventListener(OPEN_ADD_DEVICE_EVENT, listener);
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
  /** 所属节点离线：不拉列表，卡片来自缓存 / fallbackDevices，并带 offline 标记 */
  offline?: boolean;
  /** 离线且缓存里没有列表时用的设备（本地快照 / 节点 inventory） */
  fallbackDevices?: readonly Device[];
  /** 每次成功拿到设备列表时回调（宿主用来写离线快照） */
  onDevicesLoaded?: (devices: Device[]) => void;
  className?: string;
  ref?: Ref<DeviceManagementPanelHandle>;
}

function NoticeCard({ text }: { text: string }) {
  return (
    <Card size="sm" className="tmex-reveal">
      <CardContent className="py-10 text-center text-sm text-muted-foreground">{text}</CardContent>
    </Card>
  );
}

/** 加载失败的一张卡：文案按失败性质分档，节点打不通时优先用后端给的原因串。 */
function LoadErrorCard({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { t } = useTranslation();
  const info = describeDeviceLoadError(error);
  const text = info.reason
    ? t('device.loadFailedUnreachableReason', { reason: info.reason })
    : t(deviceLoadErrorMessageKey(info.kind));
  return (
    <Card size="sm" className="tmex-reveal">
      <CardContent className="space-y-3 py-10 text-center" data-testid="devices-load-error">
        <p className="text-sm text-destructive" data-error-kind={info.kind}>
          {text}
        </p>
        <Button variant="outline" size="sm" data-testid="devices-load-retry" onClick={onRetry}>
          {t('common.retry')}
        </Button>
      </CardContent>
    </Card>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  const { t } = useTranslation();
  return (
    <Card size="sm" className="tmex-reveal">
      <CardContent className="space-y-3 py-8 text-center">
        <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-muted">
          <Monitor className="h-5 w-5 text-muted-foreground" />
        </div>
        <div className="space-y-0.5">
          <h2 className="text-sm font-medium">{t('device.noDevices')}</h2>
          <p className="text-xs text-muted-foreground">{t('device.addDevice')}</p>
        </div>
        <Button variant="default" size="sm" data-testid="devices-add-empty" onClick={onAdd}>
          <Plus className="h-4 w-4" />
          {t('device.addDevice')}
        </Button>
      </CardContent>
    </Card>
  );
}

export function DeviceManagementPanel({
  devicesQueryKey = defaultDevicesQueryKey,
  listenOpenAddDeviceEvent = true,
  nodeContext,
  connection,
  offline = false,
  fallbackDevices,
  onDevicesLoaded,
  className,
  ref,
}: DeviceManagementPanelProps) {
  const { t } = useTranslation();
  const runtime = useRuntime();
  // null = 未打开；对象里带本次打开的预选类型（对话框每次都是新挂载，预选自然跟着重置）。
  const [addDialog, setAddDialog] = useState<{ initialType?: DeviceType } | null>(null);
  const openAddDevice = useCallback(
    (preset?: AddDevicePreset) => setAddDialog({ initialType: preset?.type }),
    []
  );

  const resolvedNodeContext = useMemo<DeviceNodeContext>(
    () => nodeContext ?? { runtimeNodeId: runtime.nodeId, name: '', isSelf: true },
    [nodeContext, runtime.nodeId]
  );

  useImperativeHandle(ref, () => ({ openAddDevice }), [openAddDevice]);
  useEffect(
    () => subscribeOpenAddDevice(listenOpenAddDeviceEvent, openAddDevice),
    [listenOpenAddDeviceEvent, openAddDevice]
  );
  useEffect(() => {
    if (offline) setAddDialog(null);
  }, [offline]);

  const state = useDeviceManagementState({
    devicesQueryKey,
    offline,
    fallbackDevices,
    onDevicesLoaded,
  });
  const empty = state.devices.length === 0;

  return (
    <div className={cn('flex w-full min-w-0 flex-col gap-3', className)} data-testid="devices-page">
      {offline && !empty && (
        <p data-testid="devices-offline-hint" className="text-[11px] text-muted-foreground/70">
          {t('devices.nodes.offlineSnapshot')}
        </p>
      )}

      {state.status === 'error' ? (
        <LoadErrorCard error={state.error} onRetry={state.retry} />
      ) : state.status !== 'ready' ? (
        <NoticeCard text={t('common.loading')} />
      ) : !empty ? (
        <DeviceGrid
          state={state}
          card={{
            queryKey: devicesQueryKey,
            nodeContext: resolvedNodeContext,
            connection,
            offline,
          }}
        />
      ) : offline ? (
        <div
          data-testid="devices-offline-empty"
          className="rounded-lg border border-dashed border-border/60 bg-muted/20 px-3 py-3 text-xs text-muted-foreground/70"
        >
          {t('devices.nodes.noKnownDevices')}
        </div>
      ) : (
        <EmptyState onAdd={() => openAddDevice()} />
      )}

      {addDialog && !offline && (
        <DeviceDialog
          mode="create"
          initialType={addDialog.initialType}
          nodeContext={resolvedNodeContext}
          queryKey={devicesQueryKey}
          offline={offline}
          onClose={() => setAddDialog(null)}
        />
      )}
    </div>
  );
}
