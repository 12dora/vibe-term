import { useGlobalDevice } from '@/components/global-device-provider';
import { SideBarDeviceList as DeviceTreeSideBarDeviceList } from '@tmex/panels/device-tree';
import { SidebarAgentSessionsProvider, useSidebarAgentAdapter } from './sidebar-agent-sessions';

export function SideBarDeviceList() {
  const { ensureDeviceSubscribed } = useGlobalDevice();
  const agentAdapter = useSidebarAgentAdapter();
  return (
    <SidebarAgentSessionsProvider>
      <DeviceTreeSideBarDeviceList
        ensureDeviceSubscribed={ensureDeviceSubscribed}
        agent={agentAdapter}
      />
    </SidebarAgentSessionsProvider>
  );
}
