// 设备删除确认：删除 mutation 与确认框成对，随卡片宿主一起挂载。

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { deleteDevice as deleteDeviceApi } from '@tmex/api-client';
import type { Device } from '@tmex/shared';
import { useRuntime } from '@tmex/stores/react';
import { ConfirmDialog } from '@tmex/ui/confirm-dialog';
import { Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

export interface DeviceDeleteDialogProps {
  /** 为 null 时对话框关闭 */
  device: Device | null;
  queryKey: readonly unknown[];
  onClose: () => void;
}

export function DeviceDeleteDialog({ device, queryKey, onClose }: DeviceDeleteDialogProps) {
  const { t } = useTranslation();
  const runtime = useRuntime();
  const queryClient = useQueryClient();

  const deleteDevice = useMutation({
    mutationFn: (id: string) => deleteDeviceApi(id, t('device.deleteFailed'), runtime.apiClient),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      toast.success(t('common.success'));
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    },
  });

  return (
    <ConfirmDialog
      open={device !== null}
      onOpenChange={(open) => !open && onClose()}
      media={<Trash2 className="h-5 w-5 text-destructive" />}
      title={t('device.deleteConfirm')}
      cancelLabel={t('common.cancel')}
      confirmLabel={t('common.delete')}
      confirmDisabled={!device || deleteDevice.isPending}
      onConfirm={() => {
        if (!device) return;
        deleteDevice.mutate(device.id);
        onClose();
      }}
    >
      {t('device.deleteDescription', { name: device?.name ?? '' })}
    </ConfirmDialog>
  );
}
