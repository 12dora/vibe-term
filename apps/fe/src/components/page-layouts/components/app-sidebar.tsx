import { Bot, ChevronRight, FolderClosed, Monitor, PanelsTopLeft } from 'lucide-react';
import { type ComponentProps, type ComponentType, type ReactNode, Suspense, lazy } from 'react';
import { useTranslation } from 'react-i18next';

import { type SidebarSection, useUIStore } from '@tmex/stores';
import { cn } from '@tmex/ui';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@tmex/ui/collapsible';
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader } from '@tmex/ui/sidebar';
import { NavMain } from './nav-main';
import { SideBarDeviceList } from './sidebar-device-list';
import { SidebarTitle } from './sidebar-title';

// AgentTab / FilesTab 仅在对应分区展开时渲染（Collapsible Panel 默认 keepMounted=false，
// 折叠即卸载），保持 React.lazy 懒加载：agent / files 两个子系统（含各自 store + 重组件链）
// 不进首屏 entry chunk。Panes、Files 默认展开，Agent 按需加载。
const AgentTab = lazy(() => import('@tmex/panels/agent').then((m) => ({ default: m.AgentTab })));
const FilesTab = lazy(() => import('@tmex/panels/files').then((m) => ({ default: m.FilesTab })));

const navMainItems = [
  {
    title: 'nav.manageDevices',
    url: '/devices',
    icon: Monitor,
  },
];

interface SidebarSectionBlockProps {
  section: SidebarSection;
  icon: ComponentType<{ className?: string }>;
  title: string;
  children: ReactNode;
}

// 三个功能分区并列平铺：展开的分区 flex-1 均分剩余高度，折叠的只留分区头。
function SidebarSectionBlock({ section, icon: Icon, title, children }: SidebarSectionBlockProps) {
  const open = useUIStore((state) => state.sidebarSections[section]);
  const setSidebarSectionOpen = useUIStore((state) => state.setSidebarSectionOpen);

  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => setSidebarSectionOpen(section, next)}
      data-testid={`sidebar-section-${section}`}
      className={cn('flex flex-col', open ? 'min-h-0 flex-1' : 'shrink-0')}
    >
      <CollapsibleTrigger
        data-testid={`sidebar-section-toggle-${section}`}
        className="text-sidebar-foreground/70 ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground flex w-full shrink-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[11px] font-semibold tracking-[0.01em] transition-colors focus-visible:ring-2 outline-hidden"
      >
        <ChevronRight
          className={cn('h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-90')}
        />
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1 truncate">{title}</span>
      </CollapsibleTrigger>
      {/* 分区分到的高度容不下内容最小高度（如 Agent 的 min-h）时，在分区内滚动 */}
      <CollapsibleContent className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function AppSidebar({ ...props }: ComponentProps<typeof Sidebar>) {
  const { t } = useTranslation();

  return (
    <Sidebar variant="inset" {...props}>
      <div className="h-[var(--tmex-safe-area-top)]" />
      <SidebarHeader className="gap-5 pt-3 pb-2">
        <SidebarTitle />
      </SidebarHeader>
      <SidebarContent className="flex min-h-0 flex-col gap-1 overflow-hidden pt-1.5">
        <SidebarSectionBlock section="agent" icon={Bot} title={t('sidebar.section.agent')}>
          <Suspense fallback={null}>
            <AgentTab />
          </Suspense>
        </SidebarSectionBlock>
        <SidebarSectionBlock
          section="panes"
          icon={PanelsTopLeft}
          title={t('sidebar.section.panes')}
        >
          <SideBarDeviceList />
        </SidebarSectionBlock>
        <SidebarSectionBlock section="files" icon={FolderClosed} title={t('sidebar.section.files')}>
          <Suspense fallback={null}>
            <FilesTab />
          </Suspense>
        </SidebarSectionBlock>
      </SidebarContent>
      <SidebarFooter>
        <NavMain items={navMainItems} />
        <div className="h-[var(--tmex-safe-area-bottom)]" />
      </SidebarFooter>
    </Sidebar>
  );
}
