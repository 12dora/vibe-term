// 设备卡片上的「目录」弹窗：在设备所属节点的 runtime 里，用单设备模式复用文件根设置卡。
// 卡片本身已经挂在该 node 的 `NodeRuntimeScope` 下，弹窗直接沿用 `useRuntime()` 的 client，
// 增删改与列表都落在这台设备所属的 gateway 上。

import type { Device } from '@tmex/shared';
import { useTranslation } from 'react-i18next';

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@tmex/ui/dialog';

import { FilesSettingsTab } from './files-tab';

export interface DeviceFilesModalProps {
  device: Device;
  /** 设备所属节点（运行时 id），仅用于标记弹窗归属 */
  nodeId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DeviceFilesModal({ device, nodeId, open, onOpenChange }: DeviceFilesModalProps) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-2xl"
        data-testid={`device-files-modal-${device.id}`}
        data-node-id={nodeId}
      >
        <DialogHeader>
          <DialogTitle>{t('settings.files.deviceModalTitle', { name: device.name })}</DialogTitle>
        </DialogHeader>

        <div className="-mr-2 min-h-0 flex-1 overflow-y-auto pr-2">
          <FilesSettingsTab lockedDeviceId={device.id} title={t('settings.files.roots')} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
