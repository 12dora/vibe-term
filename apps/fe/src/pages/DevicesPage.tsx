// 设备管理页。standalone / 单 node 下就是今天的单面板（零新增请求）；
// mesh 下按 node 分组，每组自带节点状态与自己的运行时（离线组不建连接）。

import { useMeshNodes, useSharedAuthMode } from '@/node/mesh-nodes';
import { DeviceManagementActions, DeviceManagementPanel } from '@tmex/panels/device-management';
import { Loader2 } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { AddDeviceMenu } from './devices/add-device-menu';
import { useAddDeviceTargets } from './devices/add-device-targets';
import { NodeDeviceGroup, toNodeDeviceGroups } from './devices/node-device-group';

function MeshDevices({ entryNodeId }: { entryNodeId: string | null }) {
  const { nodes } = useMeshNodes();
  const groups = useMemo(() => toNodeDeviceGroups(nodes, entryNodeId), [nodes, entryNodeId]);

  // mesh 列表还没回来时先渲染 self 的面板，避免首屏闪空。
  if (groups.length === 0) {
    return <DeviceManagementPanel />;
  }

  return (
    <div
      data-testid="devices-node-groups"
      className="mx-auto flex w-full max-w-6xl flex-col gap-3 p-3 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:gap-4 sm:p-5"
    >
      {groups.map((group) => (
        <NodeDeviceGroup key={group.runtimeNodeId} node={group} />
      ))}
    </div>
  );
}

export default function DevicesPage() {
  const { loaded, meshEnabled, entryNodeId } = useSharedAuthMode();

  if (!loaded) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
      </div>
    );
  }
  if (!meshEnabled) {
    return <DeviceManagementPanel />;
  }
  return <MeshDevices entryNodeId={entryNodeId} />;
}

// Page title component
export function PageTitle() {
  const { t } = useTranslation();
  return <>{t('sidebar.manageDevices')}</>;
}

// Page actions component
//
// 全页唯一的「+」：多个 ready 节点先选目标，单个直接开该节点的对话框；
// 一个都没登记（standalone / 单面板）时退回派发全局事件，与旧行为一致。
export function PageActions() {
  const targets = useAddDeviceTargets();

  if (targets.length > 1) {
    return <AddDeviceMenu targets={targets} />;
  }
  return <DeviceManagementActions onAddDevice={targets[0]?.open} />;
}
