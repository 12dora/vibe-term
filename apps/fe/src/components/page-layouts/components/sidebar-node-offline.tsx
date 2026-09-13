// 离线分节：灰显最近一次已知的设备（本地快照优先，其次 node inventory）。

import { offlineDevices } from '@/pages/devices/device-snapshot-store';
import { nodeAppPath } from '@vibeterm/api-client';
import { shouldHideSidebarNodeSection } from '@vibeterm/panels/device-tree';
import { useUIStore } from '@vibeterm/stores/react';
import { cn } from '@vibeterm/ui';
import { Monitor } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router';
import { SectionHeader } from './sidebar-node-header';
import {
  type SidebarNodeEntry,
  type SidebarNodeSortable,
  inventoryDevices,
  offlineSidebarDevices,
  selectedDeviceIdForNode,
} from './sidebar-node-model';
import { useSectionPresence } from './use-section-presence';

/**
 * 离线分节：灰显最近一次已知的设备（本地快照优先，其次 node inventory），名字取不到就用
 * device id。一台可见设备都不剩时整节隐藏——过 `useSectionPresence` 淡出后再卸载，
 * 退场期间沿用锁住的设备列表，不会先掉内容再消失。
 */
export function SidebarNodeOffline({
  node,
  drag,
}: {
  node: SidebarNodeEntry;
  drag?: SidebarNodeSortable;
}) {
  const { t } = useTranslation();
  // UI store 是宿主级共享实例（所有 node 同一份），离线分节没有自己的 runtime 也读得到。
  const visibility = useUIStore((state) => state.sidebarDeviceVisibility);
  const selectedDeviceId = selectedDeviceIdForNode(useLocation().pathname, node.runtimeNodeId);

  // 快照读 localStorage 并解析 JSON，按 node 与 inventory 记一次即可（离线期间不会变）。
  const knownDevices = useMemo(() => {
    const snapshot = offlineDevices(node.runtimeNodeId, node.inventory);
    return snapshot.length > 0
      ? snapshot.map((device) => ({ id: device.id, name: device.name }))
      : inventoryDevices(node.inventory);
  }, [node.runtimeNodeId, node.inventory]);
  const devices = offlineSidebarDevices(
    visibility,
    node.runtimeNodeId,
    knownDevices,
    selectedDeviceId
  );
  // 一台可见设备都没有时整节隐藏（与在线分节同一条规则）；self 例外，留空态。
  const hidden = shouldHideSidebarNodeSection(
    { total: knownDevices.length, visible: devices.length },
    node.isSelf
  );
  const presence = useSectionPresence(!hidden, devices);
  if (!presence.rendered) return null;

  return (
    <div
      ref={drag?.sortable.setNodeRef}
      style={drag?.sortable.style}
      data-testid={`sidebar-node-offline-${node.runtimeNodeId}`}
      className={cn('space-y-0.5', presence.className, drag?.sortable.isDragging && 'opacity-60')}
    >
      <SectionHeader node={node} hint={t('sidebar.node.offline')} drag={drag} />
      {presence.value.length === 0 ? (
        <div className="px-2 py-1 text-[11px] text-muted-foreground/60">
          {t('sidebar.node.noKnownDevices')}
        </div>
      ) : (
        presence.value.map((device) => (
          <Link
            key={device.id}
            to={nodeAppPath(node.runtimeNodeId, `/devices/${encodeURIComponent(device.id)}`)}
            data-testid={`sidebar-node-offline-device-${device.id}`}
            className="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground/60"
          >
            <Monitor className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{device.name}</span>
          </Link>
        ))
      )}
    </div>
  );
}
