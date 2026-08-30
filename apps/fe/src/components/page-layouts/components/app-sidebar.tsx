import { Bot, FolderClosed, Monitor, PanelsTopLeft } from 'lucide-react';
import { type ComponentProps, Suspense, lazy } from 'react';
import { useTranslation } from 'react-i18next';

import { useMeshNodes } from '@/node/mesh-nodes';
import { isNodeOffline } from '@/node/node-offline';
import { useRouteNodeId } from '@/node/node-runtime-boundary';
import { NodeRuntimeScope } from '@/node/node-runtime-scope';
import { selfAgentStore } from '@/node/self-agent-store';
import { useUIStore } from '@tmex/stores/react';
import { Reveal } from '@tmex/ui/motion';
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader } from '@tmex/ui/sidebar';
import { Tabs, TabsList, TabsTrigger, pillTabTriggerClassName } from '@tmex/ui/tabs';
import { NavMain } from './nav-main';
import { SideBarDeviceList } from './sidebar-device-list';
import { SidebarTitle } from './sidebar-title';

// AgentTab / FilesTab 仅在选中对应 tab 时才渲染，改 React.lazy 懒加载，
// 把 agent / files 两个子系统（含各自 store + 重组件链）移出首屏 entry chunk。
const AgentTab = lazy(() => import('@tmex/panels/agent').then((m) => ({ default: m.AgentTab })));
const FilesTab = lazy(() => import('@tmex/panels/files').then((m) => ({ default: m.FilesTab })));

/**
 * `enabled: false` 只订阅宿主级 mesh 快照，不发 `/api/mesh/*` 也不订阅事件流
 * ——拉取与订阅是设备区 `SideBarDeviceList` 的活。
 */
function useRouteNodeOffline(routeNodeId: string): boolean {
  const { nodes, entryNodeId } = useMeshNodes({ enabled: false });
  return isNodeOffline(nodes, entryNodeId, routeNodeId);
}

const navMainItems = [
  {
    title: 'nav.manageDevices',
    url: '/devices',
    icon: Monitor,
  },
];

export function AppSidebar({ ...props }: ComponentProps<typeof Sidebar>) {
  const { t } = useTranslation();
  const sidebarTab = useUIStore((state) => state.sidebarTab);
  const setSidebarTab = useUIStore((state) => state.setSidebarTab);
  // 外壳常驻在 self 运行时下；智能体 / 文件两个标签服务的是当前路由所在的 node，
  // 单独套一层该 node 的运行时（切 node 时这两块重挂是预期的，设备树不受影响）
  const routeNodeId = useRouteNodeId();
  const routeNodeOffline = useRouteNodeOffline(routeNodeId);

  return (
    <Sidebar variant="inset" {...props}>
      <div className="h-[var(--tmex-safe-area-top)]" />
      <SidebarHeader className="gap-5 pt-3 pb-0">
        <SidebarTitle />
        <Tabs
          className="mb-2.5"
          value={sidebarTab}
          onValueChange={(value) => setSidebarTab(value as typeof sidebarTab)}
        >
          <TabsList className="w-full p-1 rounded-xl border border-border/60 group-data-horizontal/tabs:h-11">
            <TabsTrigger
              value="panes"
              data-testid="sidebar-tab-panes"
              className={pillTabTriggerClassName}
            >
              <PanelsTopLeft />
              {t('sidebar.tab.panes')}
            </TabsTrigger>
            <TabsTrigger
              value="agent"
              data-testid="sidebar-tab-agent"
              className={pillTabTriggerClassName}
            >
              <Bot />
              {t('sidebar.tab.agent')}
            </TabsTrigger>
            <TabsTrigger
              value="files"
              data-testid="sidebar-tab-files"
              className={pillTabTriggerClassName}
            >
              <FolderClosed />
              {t('sidebar.tab.files')}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </SidebarHeader>
      <SidebarContent className="flex min-h-0 flex-col overflow-hidden">
        {/* 换 tab 时只让新内容淡入；壳的 flex 链（min-h-0 / flex-1）必须原样透下去，
            否则设备树与文件树会失去可滚动高度。
            设备树的 key 只能是 tab 本身：切 node 时它不重挂（展开态/滚动位置都得留着）。
            智能体 / 文件两块本来就随 routeNodeId 重挂，key 带上 node 让重挂淡入而不是直接弹出。 */}
        {sidebarTab === 'panes' && (
          <Reveal key="panes" className="flex min-h-0 flex-1 flex-col">
            <SideBarDeviceList />
          </Reveal>
        )}
        {sidebarTab !== 'panes' && (
          <Reveal key={`${sidebarTab}:${routeNodeId}`} className="flex min-h-0 flex-1 flex-col">
            <NodeRuntimeScope nodeId={routeNodeId}>
              <Suspense fallback={null}>
                {sidebarTab === 'agent' ? (
                  /* 智能体状态固定由 entry（self）网关提供：绑远端 pane 的会话也由它运行，
                     路由 node 只决定展示哪一批会话、以及设备树/快照来自谁。 */
                  <AgentTab agentStore={selfAgentStore()} nodeOffline={routeNodeOffline} />
                ) : (
                  <FilesTab nodeOffline={routeNodeOffline} />
                )}
              </Suspense>
            </NodeRuntimeScope>
          </Reveal>
        )}
      </SidebarContent>
      <SidebarFooter>
        <NavMain items={navMainItems} />
        <div className="h-[var(--tmex-safe-area-bottom)]" />
      </SidebarFooter>
    </Sidebar>
  );
}
