// 设备管理面板：设备卡片网格 + 增改对话框 + 删除确认 + 空态/加载/错误态。
// 数据自取（fetchDevices + 注入 queryKey），REST 一律经 runtime.apiClient；
// 「添加设备」既可经全局事件（缺省监听，多面板宿主可关）也可经 ref 命令式打开。

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  devicesQueryKey as defaultDevicesQueryKey,
  deleteDevice as deleteDeviceApi,
  fetchDevices,
} from '@tmex/api-client';
import type { Device } from '@tmex/shared';
import { toBCP47 } from '@tmex/shared';
import { useRuntime, useSiteStore, useTmuxStore } from '@tmex/stores/react';
import { cn } from '@tmex/ui';
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
import { Card, CardContent } from '@tmex/ui/card';
import { Monitor, Plus, Trash2 } from 'lucide-react';
import { type Ref, useEffect, useImperativeHandle, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { DeviceCard } from './device-card';
import { DeviceDialog } from './device-dialog';
import { OPEN_ADD_DEVICE_EVENT } from './events';

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
  className?: string;
  ref?: Ref<DeviceManagementPanelHandle>;
}

export function DeviceManagementPanel({
  devicesQueryKey = defaultDevicesQueryKey,
  listenOpenAddDeviceEvent = true,
  className,
  ref,
}: DeviceManagementPanelProps) {
  const { t } = useTranslation();
  const runtime = useRuntime();
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingDevice, setEditingDevice] = useState<Device | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<Device | null>(null);
  const queryClient = useQueryClient();
  const language = useSiteStore((state) => state.settings?.language ?? 'en_US');

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

  const deleteDevice = useMutation({
    mutationFn: (id: string) => deleteDeviceApi(id, t('device.deleteFailed'), runtime.apiClient),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: devicesQueryKey });
      toast.success(t('common.success'));
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    },
  });

  // 卡片顺序与侧边栏 Panes Tab 一致：先 sortOrder，再按设备名 locale 感知排序
  const devices = useMemo(() => {
    const list = data?.devices ?? [];
    return [...list].sort(
      (a, b) =>
        a.sortOrder - b.sortOrder ||
        a.name.localeCompare(b.name, toBCP47(language), { numeric: true, sensitivity: 'base' })
    );
  }, [data?.devices, language]);

  return (
    <div
      className={cn(
        'mx-auto flex w-full max-w-6xl flex-col gap-3 p-3 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:p-5',
        className
      )}
      data-testid="devices-page"
    >
      {isLoading ? (
        <Card size="sm">
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {t('common.loading')}
          </CardContent>
        </Card>
      ) : isError ? (
        <Card size="sm">
          <CardContent className="py-10 text-center text-sm text-destructive">
            {t('device.loadFailed')}
          </CardContent>
        </Card>
      ) : devices.length === 0 ? (
        <Card size="sm">
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
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {devices.map((device) => (
            <DeviceCard
              key={device.id}
              device={device}
              onEdit={() => setEditingDevice(device)}
              onDelete={() => setDeleteCandidate(device)}
            />
          ))}
        </div>
      )}

      {showAddModal && (
        <DeviceDialog
          mode="create"
          queryKey={devicesQueryKey}
          onClose={() => setShowAddModal(false)}
        />
      )}
      {editingDevice && (
        <DeviceDialog
          mode="edit"
          device={editingDevice}
          queryKey={devicesQueryKey}
          onClose={() => setEditingDevice(null)}
        />
      )}

      <AlertDialog
        open={deleteCandidate !== null}
        onOpenChange={(open) => !open && setDeleteCandidate(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-destructive/10">
              <Trash2 className="h-5 w-5 text-destructive" />
            </AlertDialogMedia>
            <AlertDialogTitle>{t('device.deleteConfirm')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('device.deleteDescription', { name: deleteCandidate?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={!deleteCandidate || deleteDevice.isPending}
              onClick={() => {
                if (!deleteCandidate) return;
                deleteDevice.mutate(deleteCandidate.id);
                setDeleteCandidate(null);
              }}
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
