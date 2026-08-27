// 侧边栏设备树的 agent 会话装饰：会话分支/孤立会话区/对话框与「新建会话」动作，
// 经 SidebarAgentAdapter 注入 @tmex/panels/device-tree（包内零 agent 依赖）。

import type { DeviceTreeNavigation, SidebarAgentAdapter } from '@tmex/panels/device-tree';
import type { AgentSessionDto, TmuxPane } from '@tmex/shared';
import { useAgentStore, useTmuxStore, useUIStore } from '@tmex/stores';
import { cn } from '@tmex/ui';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@tmex/ui/collapsible';
import { ChevronRight, History } from 'lucide-react';
import { type ReactNode, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AgentSessionDialogs } from './agent-session-dialogs';
import { OrphanSessionRow, PaneSessionRow } from './agent-session-row';
import {
  SidebarAgentSessionsContext,
  collectKnownPaneIds,
  isSessionAttached,
  paneKey,
  useSidebarAgentSessions,
  useSidebarAgentSessionsController,
} from './use-sidebar-agent-sessions';

export function SidebarAgentSessionsProvider({ children }: { children: ReactNode }) {
  const value = useSidebarAgentSessionsController();
  return (
    <SidebarAgentSessionsContext.Provider value={value}>
      {children}
    </SidebarAgentSessionsContext.Provider>
  );
}

// Agent 聊天就在侧边栏内：导航到对应 pane 提供上下文，但移动端保持 Sheet 打开
function useSelectSession(nav: DeviceTreeNavigation) {
  const setSidebarTab = useUIStore((state) => state.setSidebarTab);
  return useCallback(
    (session: AgentSessionDto) => {
      useAgentStore.getState().setActiveSession(session.id);
      setSidebarTab('agent');
      if (session.deviceId && session.paneId) {
        const windows = useTmuxStore.getState().snapshots[session.deviceId]?.session?.windows;
        const window = windows?.find((w) => w.panes.some((p) => p.id === session.paneId));
        if (window) {
          nav.navigateToPane(session.deviceId, window.id, session.paneId, {
            keepSidebarOpen: true,
          });
        }
      }
    },
    [setSidebarTab, nav]
  );
}

function createSessionForPane(
  nav: DeviceTreeNavigation,
  deviceId: string,
  windowId: string,
  pane: TmuxPane
) {
  nav.navigateToPane(deviceId, windowId, pane.id, { keepSidebarOpen: true });
  useAgentStore.getState().startDraft(deviceId, pane.id, pane.title ?? null);
  useUIStore.getState().setSidebarTab('agent');
}

function AgentPaneSessions({
  nav,
  deviceId,
  paneId,
}: {
  nav: DeviceTreeNavigation;
  deviceId: string;
  paneId: string;
}) {
  const { sessionsByPane, activeSessionId } = useSidebarAgentSessions();
  const handleSelectSession = useSelectSession(nav);
  const sessions = sessionsByPane.get(paneKey(deviceId, paneId));
  return (
    <div className="mt-1 space-y-0.5 [@media(any-pointer:coarse)]:space-y-1">
      {sessions?.map((session) => (
        <PaneSessionRow
          key={session.id}
          session={session}
          isActive={session.id === activeSessionId}
          onSelect={handleSelectSession}
        />
      ))}
    </div>
  );
}

function AgentOrphanSessions({
  nav,
  knownDeviceIds,
}: {
  nav: DeviceTreeNavigation;
  knownDeviceIds: readonly string[];
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { orderedSessions, activeSessionId } = useSidebarAgentSessions();
  const handleSelectSession = useSelectSession(nav);
  const snapshots = useTmuxStore((state) => state.snapshots);

  // 会话按 device:pane 挂到对应 pane 节点；设备缺失或 pane 已关闭的归为孤立
  const orphanSessions = useMemo(() => {
    const known = new Set(knownDeviceIds);
    const panesByDevice = collectKnownPaneIds(snapshots);
    return orderedSessions.filter((session) => !isSessionAttached(session, known, panesByDevice));
  }, [orderedSessions, knownDeviceIds, snapshots]);

  if (orphanSessions.length === 0) return null;
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="rounded-xl border border-border/60 bg-muted/20"
    >
      <CollapsibleTrigger
        data-testid="agent-orphan-sessions-trigger"
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left"
      >
        <History className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate text-xs font-medium text-muted-foreground">
          {t('agent.orphan.title', { count: orphanSessions.length })}
        </span>
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90'
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-0.5 px-1.5 pb-1.5">
        {orphanSessions.map((session) => (
          <OrphanSessionRow
            key={session.id}
            session={session}
            isActive={session.id === activeSessionId}
            onSelect={handleSelectSession}
          />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

export const sidebarAgentAdapter: SidebarAgentAdapter = {
  onCreateSessionForPane: createSessionForPane,
  PaneSessions: AgentPaneSessions,
  OrphanSessions: AgentOrphanSessions,
  Dialogs: AgentSessionDialogs,
};
