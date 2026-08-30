// 设备增改对话框：按设备种类（local / ssh / 远端节点上的 local / ssh）组合区块，
// 成功后按注入的 queryKey 失效缓存。类型创建后不可改（编辑态下拉禁用，update payload 也不含 type）。

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
import {
  type DeviceNodeContext,
  deviceDisplayKind,
  deviceKindLabel,
  isRemoteDeviceKind,
} from './device-node-context';
import { DeviceRemoteInfoFields } from './device-remote-info-fields';
import { DeviceSshConnectionFields } from './device-ssh-connection-fields';
import { type DeviceDialogMode, useDeviceDialogSubmit } from './use-device-dialog-submit';

export interface DeviceDialogProps {
  mode: DeviceDialogMode;
  device?: Device;
  /** 目标节点上下文：决定种类展示、远端只读信息块与新建时的描述文案 */
  nodeContext: DeviceNodeContext;
  onClose: () => void;
  queryKey: readonly unknown[];
  /** 所属节点离线：宿主会关掉对话框，这里再在提交时兜一次 */
  offline?: boolean;
}

export function DeviceDialog({
  mode,
  device,
  nodeContext,
  onClose,
  queryKey,
  offline,
}: DeviceDialogProps) {
  const { t } = useTranslation();
  const [values, setValues] = useState<DeviceFormValues>(createDefaultFormValues(device));
  const { attempted, isSubmitting, handleSubmit } = useDeviceDialogSubmit({
    mode,
    device,
    values,
    queryKey,
    onClose,
    offline,
  });

  const isEditMode = mode === 'edit';
  const onChange = (patch: Partial<DeviceFormValues>) =>
    setValues((current) => ({ ...current, ...patch }));
  const fieldsProps = { mode, values, attempted, onChange };

  const kind = deviceDisplayKind(values.type, nodeContext);
  const isRemote = isRemoteDeviceKind(kind);
  const description = isEditMode
    ? t('device.editDeviceDescription')
    : isRemote
      ? t('devices.nodes.addDevice', { name: nodeContext.name })
      : t('device.addDeviceDescription');

  return (
    <Dialog open={true} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        data-testid="device-dialog"
        data-device-kind={kind}
        className="flex max-h-[calc(100dvh-2rem)] w-full flex-col sm:max-w-2xl"
      >
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {isEditMode ? t('device.editDevice') : t('device.addDevice')}
            {isRemote && (
              <span
                data-testid="device-dialog-node-chip"
                className="rounded border border-border/60 px-1.5 py-px text-[10px] font-normal leading-none text-muted-foreground"
              >
                {nodeContext.name || deviceKindLabel(t, kind)}
              </span>
            )}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
          <div className="-mr-2 min-h-0 min-w-0 flex-1 space-y-5 overflow-y-auto pr-2">
            {isEditMode && isRemote && device && (
              <DeviceRemoteInfoFields device={device} nodeContext={nodeContext} />
            )}
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
