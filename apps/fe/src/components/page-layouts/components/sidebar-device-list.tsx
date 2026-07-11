import { useGlobalDevice } from '@/components/global-device-provider';
import { SideBarDeviceList as DeviceTreeSideBarDeviceList } from '@tmex/panels/device-tree';
import { SidebarAgentSessionsProvider, sidebarAgentAdapter } from './sidebar-agent-sessions';

export function SideBarDeviceList() {
  const { ensureDeviceSubscribed } = useGlobalDevice();
  return (
    <SidebarAgentSessionsProvider>
      <DeviceTreeSideBarDeviceList
        ensureDeviceSubscribed={ensureDeviceSubscribed}
        agent={sidebarAgentAdapter}
      />
    </SidebarAgentSessionsProvider>
  );
}
