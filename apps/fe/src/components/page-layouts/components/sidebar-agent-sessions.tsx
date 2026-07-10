// 侧边栏设备树的 agent 会话装饰：会话分支/孤立会话区/对话框与「新建会话」动作，
// 经 SidebarAgentAdapter 注入 @tmex/panels/device-tree（包内零 agent 依赖）。

import type { DeviceTreeNavigation, SidebarAgentAdapter } from '@tmex/panels/device-tree';
import type { AgentSessionDto, TmuxPane } from '@tmex/shared';
import { toBCP47 } from '@tmex/shared';
import { useAgentStore, useSiteStore, useTmuxStore, useUIStore } from '@tmex/stores';
import { cn } from '@tmex/ui';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@tmex/ui/alert-dialog';
import { Button } from '@tmex/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@tmex/ui/collapsible';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@tmex/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@tmex/ui/dropdown-menu';
import { Input } from '@tmex/ui/input';
import { useSidebar } from '@tmex/ui/sidebar';
import { Bot, ChevronRight, History, MoreHorizontal, Pencil, Trash2, X } from 'lucide-react';
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';

function StatusDot({ status }: { status: AgentSessionDto['status'] }) {
  return (
    <span
      className={cn(
        'size-2 shrink-0 rounded-full',
        status === 'running'
          ? 'bg-emerald-500 animate-pulse'
          : status === 'error'
            ? 'bg-destructive'
            : status === 'waiting_confirmation'
              ? 'bg-amber-500'
              : 'bg-muted-foreground/40'
      )}
    />
  );
}

interface SidebarAgentSessionsContextValue {
  sessionRenameCandidate: AgentSessionDto | null;
  sessionRenameValue: string;
  setSessionRenameValue: (value: string) => void;
  closeRenameDialog: () => void;
  confirmRenameSession: () => void;
  sessionDeleteCandidate: AgentSessionDto | null;
  closeDeleteDialog: () => void;
  confirmDeleteSession: () => void;
  requestRenameSession: (session: AgentSessionDto) => void;
  requestDeleteSession: (session: AgentSessionDto) => void;
}

const SidebarAgentSessionsContext = createContext<SidebarAgentSessionsContextValue | null>(null);

function useSidebarAgentSessions(): SidebarAgentSessionsContextValue {
  const ctx = useContext(SidebarAgentSessionsContext);
  if (!ctx) {
    throw new Error('sidebarAgentAdapter must be used within SidebarAgentSessionsProvider');
  }
  return ctx;
}

export function SidebarAgentSessionsProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    const store = useAgentStore.getState();
    store.ensureInitialized();
    void store.loadSessions();
  }, []);

  const [sessionRenameCandidate, setSessionRenameCandidate] = useState<AgentSessionDto | null>(
    null
  );
  const [sessionRenameValue, setSessionRenameValue] = useState('');
  const [sessionDeleteCandidate, setSessionDeleteCandidate] = useState<AgentSessionDto | null>(
    null
  );

  const requestRenameSession = useCallback((session: AgentSessionDto) => {
    setSessionRenameValue(session.title);
    setSessionRenameCandidate(session);
  }, []);

  const confirmRenameSession = useCallback(() => {
    if (!sessionRenameCandidate) return;
    const trimmed = sessionRenameValue.trim();
    if (!trimmed) return;
    void useAgentStore.getState().renameSession(sessionRenameCandidate.id, trimmed);
    setSessionRenameCandidate(null);
  }, [sessionRenameCandidate, sessionRenameValue]);

  const requestDeleteSession = useCallback((session: AgentSessionDto) => {
    setSessionDeleteCandidate(session);
  }, []);

  const confirmDeleteSession = useCallback(() => {
    if (!sessionDeleteCandidate) return;
    void useAgentStore.getState().deleteSession(sessionDeleteCandidate.id);
    setSessionDeleteCandidate(null);
  }, [sessionDeleteCandidate]);

  const closeRenameDialog = useCallback(() => setSessionRenameCandidate(null), []);
  const closeDeleteDialog = useCallback(() => setSessionDeleteCandidate(null), []);

  const value = useMemo(
    () => ({
      sessionRenameCandidate,
      sessionRenameValue,
      setSessionRenameValue,
      closeRenameDialog,
      confirmRenameSession,
      sessionDeleteCandidate,
      closeDeleteDialog,
      confirmDeleteSession,
      requestRenameSession,
      requestDeleteSession,
    }),
    [
      sessionRenameCandidate,
      sessionRenameValue,
      closeRenameDialog,
      confirmRenameSession,
      sessionDeleteCandidate,
      closeDeleteDialog,
      confirmDeleteSession,
      requestRenameSession,
      requestDeleteSession,
    ]
  );

  return (
    <SidebarAgentSessionsContext.Provider value={value}>
      {children}
    </SidebarAgentSessionsContext.Provider>
  );
}

function useOrderedSessions(): AgentSessionDto[] {
  const agentSessions = useAgentStore((state) => state.sessions);
  return useMemo(
    () =>
      Object.values(agentSessions)
        .filter((session): session is AgentSessionDto => Boolean(session))
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)),
    [agentSessions]
  );
}

// Agent 聊天就在侧边栏内：导航到对应 pane 提供上下文，但移动端保持 Sheet 打开
function useSelectSession(nav: DeviceTreeNavigation) {
  const expandSidebarSection = useUIStore((state) => state.expandSidebarSection);
  return useCallback(
    (session: AgentSessionDto) => {
      useAgentStore.getState().setActiveSession(session.id);
      expandSidebarSection('agent');
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
    [expandSidebarSection, nav]
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
  useUIStore.getState().expandSidebarSection('agent');
}

function SessionActionsMenu({
  session,
  onRenameSession,
  onDeleteSession,
  className,
  enlargeOnTouch = false,
}: {
  session: AgentSessionDto;
  onRenameSession: (session: AgentSessionDto) => void;
  onDeleteSession: (session: AgentSessionDto) => void;
  className?: string;
  enlargeOnTouch?: boolean;
}) {
  const { t } = useTranslation();
  const { isMobile } = useSidebar();
  const enlarged = enlargeOnTouch && isMobile;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            data-testid={`agent-session-menu-${session.id}`}
            aria-label={t('agent.session.rename')}
            onClick={(e) => e.stopPropagation()}
            className={cn(
              'size-5 shrink-0 text-muted-foreground transition-opacity data-popup-open:opacity-100',
              isMobile
                ? 'opacity-100'
                : 'opacity-0 group-hover:opacity-100 [@media(any-pointer:coarse)]:opacity-100',
              enlarged && 'size-9',
              className
            )}
          />
        }
      >
        <MoreHorizontal className={cn('size-3.5', enlarged && 'size-5')} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        backdrop
        className="w-auto min-w-36 [@media(any-pointer:coarse)]:min-w-48"
      >
        <DropdownMenuItem
          data-testid="agent-session-rename"
          className={cn(
            '[@media(any-pointer:coarse)]:py-2.5 [@media(any-pointer:coarse)]:px-2',
            isMobile && 'py-3 px-2.5 text-base gap-2.5'
          )}
          onClick={() => onRenameSession(session)}
        >
          <Pencil className={cn('h-4 w-4', isMobile && 'h-5 w-5')} />
          {t('agent.session.rename')}
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          data-testid="agent-session-delete"
          className={cn(
            '[@media(any-pointer:coarse)]:py-2.5 [@media(any-pointer:coarse)]:px-2',
            isMobile && 'py-3 px-2.5 text-base gap-2.5'
          )}
          onClick={() => onDeleteSession(session)}
        >
          <Trash2 className={cn('h-4 w-4', isMobile && 'h-5 w-5')} />
          {t('agent.session.delete')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PaneSessionBranch({
  sessions,
  activeSessionId,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
}: {
  sessions: AgentSessionDto[] | undefined;
  activeSessionId: string | null;
  onSelectSession: (session: AgentSessionDto) => void;
  onRenameSession: (session: AgentSessionDto) => void;
  onDeleteSession: (session: AgentSessionDto) => void;
}) {
  const { isMobile } = useSidebar();
  return (
    <div className="mt-1 space-y-0.5 [@media(any-pointer:coarse)]:space-y-1">
      {sessions?.map((session) => {
        const isActive = session.id === activeSessionId;
        return (
          <div key={session.id} className="group relative">
            <button
              type="button"
              data-testid={`agent-session-item-${session.id}`}
              onClick={() => onSelectSession(session)}
              className={cn(
                'w-full flex items-center gap-1.5 px-2 py-1 pr-7 rounded-md text-left transition-colors [@media(any-pointer:coarse)]:min-h-11 [@media(any-pointer:coarse)]:py-2 [@media(any-pointer:coarse)]:pr-12',
                isMobile && 'min-h-11 py-2 pr-12',
                isActive ? 'bg-primary/10 text-primary' : 'hover:bg-accent/30 text-muted-foreground'
              )}
            >
              <Bot className="size-3 shrink-0 opacity-70" />
              <span className="min-w-0 flex-1 truncate text-[11px]">{session.title}</span>
              <StatusDot status={session.status} />
            </button>
            <div className="absolute right-0.5 top-1/2 -translate-y-1/2">
              <SessionActionsMenu
                session={session}
                onRenameSession={onRenameSession}
                onDeleteSession={onDeleteSession}
                enlargeOnTouch
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function OrphanSessionsList({
  sessions,
  activeSessionId,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
}: {
  sessions: AgentSessionDto[];
  activeSessionId: string | null;
  onSelectSession: (session: AgentSessionDto) => void;
  onRenameSession: (session: AgentSessionDto) => void;
  onDeleteSession: (session: AgentSessionDto) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const language = useSiteStore((state) => state.settings?.language ?? 'en_US');

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
          {t('agent.orphan.title', { count: sessions.length })}
        </span>
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90'
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-0.5 px-1.5 pb-1.5">
        {sessions.map((session) => {
          const isActive = session.id === activeSessionId;
          const meta = [
            session.originPaneTitle,
            session.originProcessName,
            session.createdAt
              ? new Date(session.createdAt).toLocaleString(toBCP47(language))
              : null,
          ].filter((value): value is string => Boolean(value));
          return (
            <div key={session.id} className="group relative">
              <button
                type="button"
                data-testid={`agent-orphan-session-${session.id}`}
                onClick={() => onSelectSession(session)}
                className={cn(
                  'w-full flex flex-col gap-0.5 px-2 py-1.5 pr-7 rounded-lg text-left transition-colors',
                  isActive ? 'bg-primary/10 text-primary' : 'hover:bg-accent/30'
                )}
              >
                <span className="flex items-center gap-1.5">
                  <Bot className="size-3 shrink-0 opacity-70" />
                  <span className="min-w-0 flex-1 truncate text-[11px]">{session.title}</span>
                  <StatusDot status={session.status} />
                </span>
                {meta.length > 0 && (
                  <span className="truncate pl-[18px] text-[10px] text-muted-foreground">
                    {meta.join(' · ')}
                  </span>
                )}
              </button>
              <div className="absolute right-0.5 top-1.5">
                <SessionActionsMenu
                  session={session}
                  onRenameSession={onRenameSession}
                  onDeleteSession={onDeleteSession}
                />
              </div>
            </div>
          );
        })}
      </CollapsibleContent>
    </Collapsible>
  );
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
  const ordered = useOrderedSessions();
  const activeSessionId = useAgentStore((state) => state.activeSessionId);
  const { requestRenameSession, requestDeleteSession } = useSidebarAgentSessions();
  const handleSelectSession = useSelectSession(nav);
  const sessions = useMemo(
    () => ordered.filter((session) => session.deviceId === deviceId && session.paneId === paneId),
    [ordered, deviceId, paneId]
  );
  return (
    <PaneSessionBranch
      sessions={sessions.length > 0 ? sessions : undefined}
      activeSessionId={activeSessionId}
      onSelectSession={handleSelectSession}
      onRenameSession={requestRenameSession}
      onDeleteSession={requestDeleteSession}
    />
  );
}

function AgentOrphanSessions({
  nav,
  knownDeviceIds,
}: {
  nav: DeviceTreeNavigation;
  knownDeviceIds: readonly string[];
}) {
  const ordered = useOrderedSessions();
  const activeSessionId = useAgentStore((state) => state.activeSessionId);
  const { requestRenameSession, requestDeleteSession } = useSidebarAgentSessions();
  const handleSelectSession = useSelectSession(nav);
  // 会话按 device:pane 挂到对应 pane 节点；设备缺失/不在列表的归为孤立
  const orphanSessions = useMemo(() => {
    const known = new Set(knownDeviceIds);
    return ordered.filter(
      (session) => !session.deviceId || !session.paneId || !known.has(session.deviceId)
    );
  }, [ordered, knownDeviceIds]);

  if (orphanSessions.length === 0) return null;
  return (
    <OrphanSessionsList
      sessions={orphanSessions}
      activeSessionId={activeSessionId}
      onSelectSession={handleSelectSession}
      onRenameSession={requestRenameSession}
      onDeleteSession={requestDeleteSession}
    />
  );
}

function AgentSessionDialogs() {
  const { t } = useTranslation();
  const {
    sessionRenameCandidate,
    sessionRenameValue,
    setSessionRenameValue,
    closeRenameDialog,
    confirmRenameSession,
    sessionDeleteCandidate,
    closeDeleteDialog,
    confirmDeleteSession,
  } = useSidebarAgentSessions();

  return (
    <>
      <Dialog
        open={sessionRenameCandidate !== null}
        onOpenChange={(open) => !open && closeRenameDialog()}
      >
        <DialogContent data-testid="agent-session-rename-dialog">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              confirmRenameSession();
            }}
          >
            <DialogHeader>
              <DialogTitle>{t('agent.session.renameTitle')}</DialogTitle>
            </DialogHeader>
            <div className="py-4">
              <Input
                autoFocus
                maxLength={120}
                value={sessionRenameValue}
                onChange={(e) => setSessionRenameValue(e.target.value)}
                placeholder={t('agent.session.renamePlaceholder')}
                data-testid="agent-session-rename-input"
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={closeRenameDialog}>
                {t('agent.session.cancel')}
              </Button>
              <Button
                type="submit"
                disabled={!sessionRenameValue.trim()}
                data-testid="agent-session-rename-save"
              >
                {t('agent.session.save')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={sessionDeleteCandidate !== null}
        onOpenChange={(open) => !open && closeDeleteDialog()}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-destructive/10">
              <X className="h-5 w-5 text-destructive" />
            </AlertDialogMedia>
            <AlertDialogTitle>{t('agent.session.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('agent.session.deleteDesc', { title: sessionDeleteCandidate?.title ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={!sessionDeleteCandidate}
              onClick={confirmDeleteSession}
              data-testid="agent-session-delete-confirm"
            >
              {t('agent.session.deleteConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export const sidebarAgentAdapter: SidebarAgentAdapter = {
  onCreateSessionForPane: createSessionForPane,
  PaneSessions: AgentPaneSessions,
  OrphanSessions: AgentOrphanSessions,
  Dialogs: AgentSessionDialogs,
};
