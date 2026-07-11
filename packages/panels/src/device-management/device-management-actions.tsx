// 「添加设备」动作按钮（宿主外壳右上 +）：缺省派发全局事件，宿主可注入显式回调。

import { Button } from '@tmex/ui/button';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { OPEN_ADD_DEVICE_EVENT } from './events';

export interface DeviceManagementActionsProps {
  onAddDevice?: () => void;
}

export function DeviceManagementActions({ onAddDevice }: DeviceManagementActionsProps) {
  const { t } = useTranslation();

  const handleAdd = () => {
    if (onAddDevice) {
      onAddDevice();
      return;
    }
    window.dispatchEvent(new CustomEvent(OPEN_ADD_DEVICE_EVENT));
  };

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      data-testid="devices-add"
      onClick={handleAdd}
      aria-label={t('sidebar.addDevice')}
      title={t('sidebar.addDevice')}
    >
      <Plus className="h-4 w-4" />
    </Button>
  );
}
