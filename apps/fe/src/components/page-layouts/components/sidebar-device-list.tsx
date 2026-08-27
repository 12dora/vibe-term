import { useGlobalDevice } from '@/components/global-device-provider';
import { SideBarDeviceList as DeviceTreeSideBarDeviceList } from '@tmex/panels/device-tree';
import { useRuntime } from '@tmex/stores/react';
import { SidebarAgentSessionsProvider, sidebarAgentAdapter } from './sidebar-agent-sessions';

export function SideBarDeviceList() {
  const { ensureDeviceSubscribed, connection } = useGlobalDevice();
  const agentUi = useRuntime().features.agentUi;

  const tree = (
    <DeviceTreeSideBarDeviceList
      ensureDeviceSubscribed={ensureDeviceSubscribed}
      connection={connection}
      agent={agentUi ? sidebarAgentAdapter : undefined}
    />
  );

  // agentUi 关断时设备树不渲染任何 agent 面，provider 一并跳过（省掉会话列表 bootstrap）
  if (!agentUi) return tree;
  return <SidebarAgentSessionsProvider>{tree}</SidebarAgentSessionsProvider>;
}
