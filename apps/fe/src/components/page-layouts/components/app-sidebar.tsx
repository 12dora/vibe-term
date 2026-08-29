import { Bot, FolderClosed, Monitor, PanelsTopLeft } from 'lucide-react';
import { type ComponentProps, Suspense, lazy } from 'react';
import { useTranslation } from 'react-i18next';

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
            否则设备树与文件树会失去可滚动高度。 */}
        <Reveal key={sidebarTab} className="flex min-h-0 flex-1 flex-col">
          {sidebarTab === 'panes' && <SideBarDeviceList />}
          {sidebarTab === 'agent' && (
            <Suspense fallback={null}>
              <AgentTab />
            </Suspense>
          )}
          {sidebarTab === 'files' && (
            <Suspense fallback={null}>
              <FilesTab />
            </Suspense>
          )}
        </Reveal>
      </SidebarContent>
      <SidebarFooter>
        <NavMain items={navMainItems} />
        <div className="h-[var(--tmex-safe-area-bottom)]" />
      </SidebarFooter>
    </Sidebar>
  );
}
