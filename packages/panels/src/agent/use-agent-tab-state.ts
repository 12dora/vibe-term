// AgentTab 的原始输入：路由 pane、agent store 切片、设备列表与启动副作用。

import { useEffect, useMemo } from 'react';
import { useMatch } from 'react-router';

import { useQuery } from '@tanstack/react-query';
import { fetchDevices } from '@tmex/api-client';
import type {
  AgentMessageDto,
  AgentQueuedMessageDto,
  AgentSessionDto,
  AgentWriteMode,
  Device,
} from '@tmex/shared';
import type {
  AppRuntime,
  DraftSession,
  PendingConfirmationUi,
  SessionInProgress,
} from '@tmex/stores';
import { useAgentStore, useRuntime, useTmuxStore } from '@tmex/stores/react';

import { type SnapshotMap, findPaneTitle } from './agent-binding';
import { shouldRedraftForRoute } from './agent-route-sync';

export type AgentStoreHandle = AppRuntime['stores']['agent'];

interface RoutePane {
  routeDeviceId: string | null;
  routePaneId: string | null;
  /** 当前路由 pane 的 snapshot 标题，用作新建会话的起源元数据 */
  routePaneTitle: string | null;
}

interface AgentSessionSlice {
  activeSessionId: string | null;
  activeSession: AgentSessionDto | undefined;
  draft: DraftSession | null;
  messages: AgentMessageDto[] | undefined;
  inProgress: SessionInProgress | undefined;
  pendingConfirmations: PendingConfirmationUi[] | undefined;
  sending: boolean | undefined;
  materializingDraft: boolean;
  queued: AgentQueuedMessageDto[] | undefined;
  defaultWriteMode: AgentWriteMode;
}

interface DevicesSlice {
  devices: Device[] | undefined;
  /** devices 查询尚未拿到结果（首个 pending 或重试中） */
  devicesLoading: boolean;
  /** devices 查询失败：设备列表不可信，不能据此判定会话孤立 */
  devicesError: boolean;
}

export interface AgentTabState extends RoutePane, AgentSessionSlice, DevicesSlice {
  agentStore: AgentStoreHandle;
  snapshots: SnapshotMap;
}

function useRoutePane(snapshots: SnapshotMap): RoutePane {
  const paneMatch = useMatch('/devices/:deviceId/windows/:windowId/panes/:paneId');
  const routeDeviceId = paneMatch?.params.deviceId ?? null;
  const routePaneId = paneMatch?.params.paneId ?? null;
  const routePaneTitle = useMemo(
    () => findPaneTitle(snapshots, routeDeviceId, routePaneId),
    [snapshots, routeDeviceId, routePaneId]
  );
  return { routeDeviceId, routePaneId, routePaneTitle };
}

function useAgentSessionSlice(): AgentSessionSlice {
  const sessions = useAgentStore((state) => state.sessions);
  const activeSessionId = useAgentStore((state) => state.activeSessionId);
  const draft = useAgentStore((state) => state.draft);
  const messages = useAgentStore((state) =>
    state.activeSessionId ? state.messages[state.activeSessionId] : undefined
  );
  const inProgress = useAgentStore((state) =>
    state.activeSessionId ? state.inProgress[state.activeSessionId] : undefined
  );
  const pendingConfirmations = useAgentStore((state) =>
    state.activeSessionId ? state.pendingConfirmations[state.activeSessionId] : undefined
  );
  const sending = useAgentStore((state) =>
    state.activeSessionId ? state.sending[state.activeSessionId] : undefined
  );
  const materializingDraft = useAgentStore((state) => state.materializingDraft);
  const queued = useAgentStore((state) =>
    state.activeSessionId ? state.queued[state.activeSessionId] : undefined
  );
  const defaultWriteMode = useAgentStore((state) => state.defaultWriteMode);

  return {
    activeSessionId,
    activeSession: activeSessionId ? sessions[activeSessionId] : undefined,
    draft,
    messages,
    inProgress,
    pendingConfirmations,
    sending,
    materializingDraft,
    queued,
    defaultWriteMode,
  };
}

function useDevices(runtime: AppRuntime): DevicesSlice {
  const { data, isPending, isError } = useQuery({
    queryKey: ['devices'],
    queryFn: () => fetchDevices(runtime.apiClient),
    throwOnError: false,
  });
  return { devices: data?.devices, devicesLoading: isPending, devicesError: isError };
}

function useSessionsBootstrap(agentStore: AgentStoreHandle): void {
  useEffect(() => {
    const store = agentStore.getState();
    store.ensureInitialized();
    void store.loadSessions();
  }, [agentStore]);
}

/** 空态即草稿态：进入 agent tab 且有路由 pane 但无会话/草稿时自动起草 */
function useAutoDraft(
  agentStore: AgentStoreHandle,
  activeSession: AgentSessionDto | undefined,
  draft: DraftSession | null,
  route: RoutePane
): void {
  const { routeDeviceId, routePaneId, routePaneTitle } = route;
  useEffect(() => {
    if (!activeSession && !draft && routeDeviceId && routePaneId) {
      agentStore.getState().startDraft(routeDeviceId, routePaneId, routePaneTitle);
    }
  }, [activeSession, draft, routeDeviceId, routePaneId, routePaneTitle, agentStore]);
}

/**
 * 路由 pane 切换后草稿仍绑在旧 pane：按当前路由重新起草，
 * 否则发送会物化到上一个 pane。未发送的预填 prompt 一并带到新草稿。
 */
function useSyncDraftToRoute(
  agentStore: AgentStoreHandle,
  activeSession: AgentSessionDto | undefined,
  draft: DraftSession | null,
  route: RoutePane
): void {
  const { routeDeviceId, routePaneId, routePaneTitle } = route;
  useEffect(() => {
    if (!routeDeviceId || !routePaneId) return;
    const redraft = shouldRedraftForRoute(
      draft,
      { deviceId: routeDeviceId, paneId: routePaneId },
      Boolean(activeSession)
    );
    if (!redraft) return;
    agentStore
      .getState()
      .startDraft(routeDeviceId, routePaneId, routePaneTitle, draft?.prompt ?? null);
  }, [activeSession, draft, routeDeviceId, routePaneId, routePaneTitle, agentStore]);
}

export function useAgentTabState(): AgentTabState {
  const runtime = useRuntime();
  const agentStore = runtime.stores.agent;
  const snapshots = useTmuxStore((state) => state.snapshots);
  const devices = useDevices(runtime);
  const route = useRoutePane(snapshots);
  const session = useAgentSessionSlice();

  useSessionsBootstrap(agentStore);
  useAutoDraft(agentStore, session.activeSession, session.draft, route);
  useSyncDraftToRoute(agentStore, session.activeSession, session.draft, route);

  return { agentStore, snapshots, ...devices, ...route, ...session };
}
