// 单个 node 运行时下的设备树（原 `sidebar-device-list.tsx` 的全部内容）。
// 聚合视图给每个在线且已登录的 node 各挂一份；standalone / 单 node 宿主直接用它。

import { useGlobalDevice } from '@/components/global-device-provider';
import {
  SideBarDeviceList as DeviceTreeSideBarDeviceList,
  type NodeBadgeInfo,
} from '@tmex/panels/device-tree';
import { useRuntime } from '@tmex/stores/react';
import { SidebarAgentSessionsProvider, useSidebarAgentAdapter } from './sidebar-agent-sessions';

export interface SideBarDeviceListForRuntimeProps {
  nodeBadge?: NodeBadgeInfo;
  /** 多 node 下把 UI store 的展开态按 node 隔离；self 传 undefined 保持旧 key。 */
  expansionKeyFor?: (deviceId: string) => string;
  emptyLabel?: string;
}

export function SideBarDeviceListForRuntime({
  nodeBadge,
  expansionKeyFor,
  emptyLabel,
}: SideBarDeviceListForRuntimeProps) {
  const { ensureDeviceSubscribed, connection } = useGlobalDevice();
  const agentUi = useRuntime().features.agentUi;
  const agentAdapter = useSidebarAgentAdapter();

  const tree = (
    <DeviceTreeSideBarDeviceList
      ensureDeviceSubscribed={ensureDeviceSubscribed}
      connection={connection}
      agent={agentUi ? agentAdapter : undefined}
      nodeBadge={nodeBadge}
      expansionKeyFor={expansionKeyFor}
      emptyLabel={emptyLabel}
    />
  );

  // agentUi 关断时设备树不渲染任何 agent 面，provider 一并跳过（省掉会话列表 bootstrap）
  if (!agentUi) return tree;
  return <SidebarAgentSessionsProvider>{tree}</SidebarAgentSessionsProvider>;
}
