// 设备增改对话框：local/ssh 表单（四种 authMode）、校验与提交，成功后按注入的 queryKey 失效缓存。

import type { Device } from '@tmex/shared';
import { Button } from '@tmex/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@tmex/ui/dialog';
import { useTranslation } from 'react-i18next';
import {
  DeviceAuthFields,
  DeviceBasicFields,
  DeviceSshConnectionFields,
  createDeviceFieldIds,
} from './device-dialog-fields';
import { useDeviceDialogModel } from './use-device-dialog-model';

export interface DeviceDialogProps {
  mode: 'create' | 'edit';
  device?: Device;
  onClose: () => void;
  queryKey: readonly unknown[];
}

export function DeviceDialog({ mode, device, onClose, queryKey }: DeviceDialogProps) {
  const { t } = useTranslation();
  const model = useDeviceDialogModel({ mode, device, onClose, queryKey });
  const ids = createDeviceFieldIds(mode);

  return (
    <Dialog open={true} onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="device-dialog" className="w-full max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {model.isEditMode ? t('device.editDevice') : t('device.addDevice')}
          </DialogTitle>
          <DialogDescription>
            {model.isEditMode
              ? t('device.editDeviceDescription')
              : t('device.addDeviceDescription')}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={model.handleSubmit} className="space-y-4">
          <div className="-mr-2 max-h-[min(70dvh,720px)] space-y-5 overflow-y-auto pr-2">
            <DeviceBasicFields ids={ids} model={model} />
            {model.isSSH && (
              <>
                <DeviceSshConnectionFields ids={ids} model={model} />
                <DeviceAuthFields ids={ids} model={model} />
              </>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              variant="default"
              data-testid="device-dialog-save"
              disabled={model.isSubmitting}
            >
              {model.isSubmitting ? t('common.saving') : t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
