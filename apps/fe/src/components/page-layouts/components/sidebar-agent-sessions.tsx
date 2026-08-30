// 侧边栏设备树的 agent 会话装饰：会话分支/孤立会话区/对话框与「新建会话」动作，
// 经 SidebarAgentAdapter 注入 @tmex/panels/device-tree（包内零 agent 依赖）。

import { selfAgentStore } from '@/node/self-agent-store';
import type { DeviceTreeNavigation, SidebarAgentAdapter } from '@tmex/panels/device-tree';
import type { AgentSessionDto, TmuxPane } from '@tmex/shared';
import type { AppRuntime } from '@tmex/stores';
import { normalizeAgentNodeId } from '@tmex/stores';
import { useRuntime, useUIStore } from '@tmex/stores/react';
import { cn } from '@tmex/ui';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@tmex/ui/collapsible';
import { ChevronRight, History } from 'lucide-react';
import { type ReactNode, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AgentSessionDialogs } from './agent-session-dialogs';
import { OrphanSessionRow, PaneSessionRow } from './agent-session-row';
import {
  SidebarAgentCommandsContext,
  SidebarAgentDialogsContext,
  isSessionAttached,
  isSessionPaused,
  useActiveSessionId,
  useKnownPaneIds,
  useNodeSessions,
  useSessionsForPane,
  useSidebarAgentCommands,
  useSidebarAgentSessionsController,
} from './use-sidebar-agent-sessions';

export function SidebarAgentSessionsProvider({ children }: { children: ReactNode }) {
  const { commands, dialogs } = useSidebarAgentSessionsController();
  return (
    <SidebarAgentCommandsContext.Provider value={commands}>
      <SidebarAgentDialogsContext.Provider value={dialogs}>
        {children}
      </SidebarAgentDialogsContext.Provider>
    </SidebarAgentCommandsContext.Provider>
  );
}

// Agent 聊天就在侧边栏内：导航到对应 pane 提供上下文，但移动端保持 Sheet 打开
function useSelectSession(nav: DeviceTreeNavigation) {
  const runtime = useRuntime();
  const setSidebarTab = useUIStore((state) => state.setSidebarTab);
  return useCallback(
    (session: AgentSessionDto) => {
      selfAgentStore().getState().setActiveSession(session.id);
      setSidebarTab('agent');
      if (session.deviceId && session.paneId) {
        const windows =
          runtime.stores.tmux.getState().snapshots[session.deviceId]?.session?.windows;
        const window = windows?.find((w) => w.panes.some((p) => p.id === session.paneId));
        if (window) {
          nav.navigateToPane(session.deviceId, window.id, session.paneId, {
            keepSidebarOpen: true,
          });
        }
      }
    },
    [setSidebarTab, nav, runtime]
  );
}

// 会话由 entry（self）网关持有并运行，草稿只是带上目标 pane 所在的 node
function createSessionForPane(
  runtime: AppRuntime,
  nav: DeviceTreeNavigation,
  deviceId: string,
  windowId: string,
  pane: TmuxPane
) {
  nav.navigateToPane(deviceId, windowId, pane.id, { keepSidebarOpen: true });
  selfAgentStore()
    .getState()
    .startDraft({
      nodeId: normalizeAgentNodeId(runtime.nodeId),
      deviceId,
      paneId: pane.id,
      paneTitle: pane.title ?? null,
    });
  runtime.stores.ui.getState().setSidebarTab('agent');
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
  const { nodeOffline } = useSidebarAgentCommands();
  const handleSelectSession = useSelectSession(nav);
  const sessions = useSessionsForPane(deviceId, paneId);
  const activeSessionId = useActiveSessionId();
  return (
    <div className="mt-1 space-y-0.5 [@media(any-pointer:coarse)]:space-y-1">
      {sessions.map((session) => (
        <PaneSessionRow
          key={session.id}
          session={session}
          isActive={session.id === activeSessionId}
          paused={isSessionPaused(session, nodeOffline)}
          onSelect={handleSelectSession}
        />
      ))}
    </div>
  );
}

function AgentOrphanSessions({
  nav,
  knownDeviceIds,
  devicesReady,
}: {
  nav: DeviceTreeNavigation;
  knownDeviceIds: readonly string[];
  devicesReady: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { nodeOffline } = useSidebarAgentCommands();
  const orderedSessions = useNodeSessions();
  const activeSessionId = useActiveSessionId();
  const handleSelectSession = useSelectSession(nav);
  // 直接选派生出的 pane 索引：pane 结构没变的 metadata 事件返回同一引用，本分节不重渲染
  const panesByDevice = useKnownPaneIds();

  // 会话按 device:pane 挂到对应 pane 节点；设备缺失或 pane 已关闭的归为孤立
  const orphanSessions = useMemo(() => {
    const known = new Set(knownDeviceIds);
    return orderedSessions.filter(
      (session) => !isSessionAttached(session, known, panesByDevice, devicesReady)
    );
  }, [orderedSessions, knownDeviceIds, panesByDevice, devicesReady]);

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
            'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-(--tmex-motion-standard) ease-out motion-reduce:transition-none',
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
            paused={isSessionPaused(session, nodeOffline)}
            onSelect={handleSelectSession}
          />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

// 适配器按当前 node 运行时构造：onCreateSessionForPane 不是 hook，只能闭包捕获 runtime。
export function useSidebarAgentAdapter(): SidebarAgentAdapter {
  const runtime = useRuntime();
  return useMemo<SidebarAgentAdapter>(
    () => ({
      onCreateSessionForPane: (nav, deviceId, windowId, pane) =>
        createSessionForPane(runtime, nav, deviceId, windowId, pane),
      PaneSessions: AgentPaneSessions,
      OrphanSessions: AgentOrphanSessions,
      Dialogs: AgentSessionDialogs,
    }),
    [runtime]
  );
}
