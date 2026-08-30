// 远端节点上的设备：只读的归属信息（节点名 / 节点 id / 设备 id）+「显示在侧栏」偏好。
// 连接参数由该节点自己管理，这里不提供任何可写的连接字段。

import type { Device } from '@tmex/shared';
import { isSidebarDeviceVisible, sidebarDeviceVisibilityKey } from '@tmex/stores';
import { useUIStore } from '@tmex/stores/react';
import { Switch } from '@tmex/ui/switch';
import { useTranslation } from 'react-i18next';
import { SectionHeading } from './device-field-primitives';
import type { DeviceNodeContext } from './device-node-context';

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="w-20 shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground" title={value}>
        {value}
      </span>
    </div>
  );
}

interface DeviceRemoteInfoFieldsProps {
  device: Device;
  nodeContext: DeviceNodeContext;
}

export function DeviceRemoteInfoFields({ device, nodeContext }: DeviceRemoteInfoFieldsProps) {
  const { t } = useTranslation();
  const sidebarVisible = useUIStore((state) =>
    isSidebarDeviceVisible(state.sidebarDeviceVisibility, nodeContext.runtimeNodeId, device.id)
  );
  const setSidebarVisible = useUIStore((state) => state.setSidebarDeviceVisibility);

  return (
    <section className="space-y-2.5" data-testid="device-dialog-remote-info">
      <SectionHeading>{t('device.remoteInfo.title')}</SectionHeading>
      <div className="space-y-1.5 rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5">
        <InfoRow label={t('device.remoteInfo.node')} value={nodeContext.name} />
        <InfoRow label={t('device.remoteInfo.nodeId')} value={nodeContext.runtimeNodeId} />
        <InfoRow label={t('device.remoteInfo.deviceId')} value={device.id} />
        <p className="pt-0.5 text-[11px] text-muted-foreground">{t('device.remoteInfo.hint')}</p>
      </div>
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2">
        <div className="min-w-0">
          <div className="text-xs font-medium text-foreground">{t('device.sidebar.show')}</div>
          <p className="text-[11px] text-muted-foreground">{t('device.sidebar.hint')}</p>
        </div>
        <Switch
          size="sm"
          checked={sidebarVisible}
          data-testid={`device-dialog-sidebar-${device.id}`}
          aria-label={t('device.sidebar.show')}
          onCheckedChange={(checked) =>
            setSidebarVisible(
              sidebarDeviceVisibilityKey(nodeContext.runtimeNodeId, device.id),
              Boolean(checked)
            )
          }
        />
      </div>
    </section>
  );
}
