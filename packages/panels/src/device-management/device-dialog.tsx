// 设备增改对话框：组合基础/连接/认证字段与提交逻辑，成功后按注入的 queryKey 失效缓存。

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
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DeviceAuthFields } from './device-auth-fields';
import { DeviceBasicFields } from './device-basic-fields';
import { type DeviceFormValues, createDefaultFormValues } from './device-form';
import { DeviceSshConnectionFields } from './device-ssh-connection-fields';
import { type DeviceDialogMode, useDeviceDialogSubmit } from './use-device-dialog-submit';

export interface DeviceDialogProps {
  mode: DeviceDialogMode;
  device?: Device;
  onClose: () => void;
  queryKey: readonly unknown[];
}

export function DeviceDialog({ mode, device, onClose, queryKey }: DeviceDialogProps) {
  const { t } = useTranslation();
  const [values, setValues] = useState<DeviceFormValues>(createDefaultFormValues(device));
  const { attempted, isSubmitting, handleSubmit } = useDeviceDialogSubmit({
    mode,
    device,
    values,
    queryKey,
    onClose,
  });

  const isEditMode = mode === 'edit';
  const onChange = (patch: Partial<DeviceFormValues>) =>
    setValues((current) => ({ ...current, ...patch }));
  const fieldsProps = { mode, values, attempted, onChange };

  return (
    <Dialog open={true} onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="device-dialog" className="w-full max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEditMode ? t('device.editDevice') : t('device.addDevice')}</DialogTitle>
          <DialogDescription>
            {isEditMode ? t('device.editDeviceDescription') : t('device.addDeviceDescription')}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="-mr-2 max-h-[min(70dvh,720px)] space-y-5 overflow-y-auto pr-2">
            <DeviceBasicFields {...fieldsProps} />
            {values.type === 'ssh' && (
              <>
                <DeviceSshConnectionFields {...fieldsProps} />
                <DeviceAuthFields {...fieldsProps} />
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
              disabled={isSubmitting}
            >
              {isSubmitting ? t('common.saving') : t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
