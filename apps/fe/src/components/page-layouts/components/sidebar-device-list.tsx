// 侧边栏设备区：standalone / 单 node 下就是今天的单运行时设备树（零新增请求）；
// mesh 下拍平所有 node 的设备（self 在最前），每行带 node 徽标。

import { useMeshNodes, useSharedAuthMode } from '@/node/mesh-nodes';
import { SELF_NODE_ID } from '@tmex/api-client';
import type { MeshNode } from '@tmex/api-client/auth/index';
import { SortableVerticalList, useSortableRow } from '@tmex/panels/device-tree';
import { useUIStore } from '@tmex/stores/react';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { SideBarDeviceListForRuntime } from './sidebar-device-list-runtime';
import { type SidebarNodeEntry, SidebarNodeSection } from './sidebar-node-section';

const NODE_SORTABLE_PREFIX = 'sidebar-node:';

/** 分节的 sortable id 单独加前缀：分节内部还有设备/窗口/pane 三层排序，id 空间不能撞。 */
export function sidebarNodeSortableId(nodeId: string): string {
  return `${NODE_SORTABLE_PREFIX}${nodeId}`;
}

export function sidebarNodeIdFromSortableId(sortableId: string): string {
  return sortableId.startsWith(NODE_SORTABLE_PREFIX)
    ? sortableId.slice(NODE_SORTABLE_PREFIX.length)
    : sortableId;
}

/**
 * 手工顺序（本机 UI 偏好，见 UI store `sidebarNodeOrder`）优先：
 * 保存过且仍存在的 node 按保存顺序在前，其余按 API 顺序追加在后。
 */
export function applySidebarNodeOrder(
  entries: SidebarNodeEntry[],
  order: readonly string[]
): SidebarNodeEntry[] {
  if (order.length === 0) return entries;

  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const ordered: SidebarNodeEntry[] = [];
  const taken = new Set<string>();
  for (const id of order) {
    const entry = byId.get(id);
    if (!entry || taken.has(id)) continue;
    taken.add(id);
    ordered.push(entry);
  }
  for (const entry of entries) {
    if (!taken.has(entry.id)) ordered.push(entry);
  }
  return ordered;
}

/** mesh 节点列表 → 侧边栏分节。self 已由 `sortNodes` 排在最前，这里做字段映射并应用手工顺序。 */
export function toSidebarEntries(
  nodes: MeshNode[],
  entryNodeId: string | null,
  order: readonly string[] = []
): SidebarNodeEntry[] {
  const entries = nodes.map((node) => {
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
  return applySidebarNodeOrder(entries, order);
}

function SortableNodeSection({
  node,
  dragHandleLabel,
}: {
  node: SidebarNodeEntry;
  dragHandleLabel: string;
}) {
  const sortable = useSortableRow(sidebarNodeSortableId(node.id));
  return <SidebarNodeSection node={node} drag={{ sortable, dragHandleLabel }} />;
}

function MeshDeviceList({ entryNodeId }: { entryNodeId: string | null }) {
  const { t } = useTranslation();
  const { nodes } = useMeshNodes();
  const sidebarNodeOrder = useUIStore((state) => state.sidebarNodeOrder);
  const setSidebarNodeOrder = useUIStore((state) => state.setSidebarNodeOrder);

  const entries = useMemo(
    () => toSidebarEntries(nodes, entryNodeId, sidebarNodeOrder),
    [nodes, entryNodeId, sidebarNodeOrder]
  );
  const sortableIds = useMemo(
    () => entries.map((entry) => sidebarNodeSortableId(entry.id)),
    [entries]
  );

  const handleReorder = useCallback(
    (nextIds: string[]) => setSidebarNodeOrder(nextIds.map(sidebarNodeIdFromSortableId)),
    [setSidebarNodeOrder]
  );

  // mesh 列表还没回来时先渲染 self 的设备树，避免侧边栏首屏闪空。
  if (entries.length === 0) {
    return <SideBarDeviceListForRuntime />;
  }

  return (
    <div className="flex flex-col gap-1" data-testid="sidebar-node-list">
      <SortableVerticalList ids={sortableIds} onReorder={handleReorder}>
        {entries.map((entry) => (
          <SortableNodeSection
            key={entry.runtimeNodeId}
            node={entry}
            dragHandleLabel={t('sidebar.node.dragHandle')}
          />
        ))}
      </SortableVerticalList>
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
