// 侧边栏设备区：standalone / 单 node 下就是今天的单运行时设备树（零新增请求）；
// mesh 下拍平所有 node 的设备（self 在最前），每行带 node 徽标。

import { useMeshNodes, useSharedAuthMode } from '@/node/mesh-nodes';
import { SELF_NODE_ID } from '@tmex/api-client';
import type { MeshNode } from '@tmex/api-client/auth/index';
import { SideBarDeviceListForRuntime } from './sidebar-device-list-runtime';
import { type SidebarNodeEntry, SidebarNodeSection } from './sidebar-node-section';

/** mesh 节点列表 → 侧边栏分节。self 已由 `sortNodes` 排在最前，这里只做字段映射。 */
export function toSidebarEntries(
  nodes: MeshNode[],
  entryNodeId: string | null
): SidebarNodeEntry[] {
  return nodes.map((node) => {
    const isSelf = entryNodeId != null && node.id === entryNodeId;
    return {
      id: node.id,
      runtimeNodeId: isSelf ? SELF_NODE_ID : node.id,
      name: node.name,
      online: node.online,
      // self 永远视为已登录：本地 UI 已经过 localUiGuard，再显示登录按钮是死循环。
      loggedIn: isSelf ? true : node.loggedIn,
      isSelf,
      inventory: node.inventory ?? null,
    } satisfies SidebarNodeEntry;
  });
}

function MeshDeviceList({ entryNodeId }: { entryNodeId: string | null }) {
  const { nodes } = useMeshNodes();
  const entries = toSidebarEntries(nodes, entryNodeId);

  // mesh 列表还没回来时先渲染 self 的设备树，避免侧边栏首屏闪空。
  if (entries.length === 0) {
    return <SideBarDeviceListForRuntime />;
  }

  return (
    <div className="flex flex-col gap-2" data-testid="sidebar-node-list">
      {entries.map((entry) => (
        <SidebarNodeSection key={entry.runtimeNodeId} node={entry} />
      ))}
    </div>
  );
}

export function SideBarDeviceList() {
  const { meshEnabled, entryNodeId } = useSharedAuthMode();
  if (!meshEnabled) {
    return <SideBarDeviceListForRuntime />;
  }
  return <MeshDeviceList entryNodeId={entryNodeId} />;
}
