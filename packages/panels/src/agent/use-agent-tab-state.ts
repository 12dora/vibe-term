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
  StateSnapshotPayload,
} from '@tmex/shared';
import type {
  AppRuntime,
  DraftSession,
  HostServices,
  PendingConfirmationUi,
  SessionInProgress,
} from '@tmex/stores';
import {
  activeSessionIdOnNode,
  draftOnNode,
  hostAppPath,
  isDraftMaterializingOnNode,
  normalizeAgentNodeId,
  resolveAgentStore,
} from '@tmex/stores';
import { useRuntime, useTmuxStore } from '@tmex/stores/react';

import { bindingSource, deviceSnapshot, findPaneTitle } from './agent-binding';
import { shouldRedraftForRoute } from './agent-route-sync';

export type AgentStoreHandle = AppRuntime['stores']['agent'];

/** 路由 pane 的匹配 pattern；多 node 宿主经 host.appPath 带上 `/n/<id>` 前缀。 */
export const AGENT_PANE_ROUTE_PATH = '/devices/:deviceId/windows/:windowId/panes/:paneId';

/**
 * 宿主注入面。多 node 宿主里 agent 状态一律由 entry（self）网关提供：
 * 远端 pane 的会话也由它持有并运行，所以 store 与路由 runtime 是分开的两件事。
 */
export interface AgentTabHost {
  /** 服务 agent 状态的 store；缺省用当前 runtime 的（单 node 宿主行为不变） */
  agentStore?: AgentStoreHandle;
  /** 路由 node 是否离线；`undefined` 表示宿主没有 mesh 状态 */
  nodeOffline?: boolean;
}

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
  /** 绑定 chip 解析所需的那一台设备（会话/草稿所在设备）的快照 */
  bindingSnapshot: StateSnapshotPayload | undefined;
  /** 本 tab 服务的 node（null 即 entry 自身）；创建/草稿一律带上它 */
  nodeId: string | null;
  nodeOffline: boolean | undefined;
}

function useRouteMatch(host: HostServices): Omit<RoutePane, 'routePaneTitle'> {
  const paneMatch = useMatch(hostAppPath(host, AGENT_PANE_ROUTE_PATH));
  return {
    routeDeviceId: paneMatch?.params.deviceId ?? null,
    routePaneId: paneMatch?.params.paneId ?? null,
  };
}

/**
 * 按设备窄订阅 tmux 快照：selector 只返回目标设备那一份，
 * 其他设备的 snapshot/patch 虽然会换掉整张 map，本 tab 不会因此重渲染。
 */
function useDeviceSnapshot(deviceId: string | null): StateSnapshotPayload | undefined {
  return useTmuxStore((state) => deviceSnapshot(state.snapshots, deviceId));
}

function useAgentSessionSlice(
  agentStore: AgentStoreHandle,
  nodeId: string | null
): AgentSessionSlice {
  const activeSessionId = agentStore((state) => activeSessionIdOnNode(state, nodeId));
  const activeSession = agentStore((state) => {
    const id = activeSessionIdOnNode(state, nodeId);
    return id ? state.sessions[id] : undefined;
  });
  const draft = agentStore((state) => draftOnNode(state, nodeId));
  const messages = agentStore((state) => {
    const id = activeSessionIdOnNode(state, nodeId);
    return id ? state.messages[id] : undefined;
  });
  const inProgress = agentStore((state) => {
    const id = activeSessionIdOnNode(state, nodeId);
    return id ? state.inProgress[id] : undefined;
  });
  const pendingConfirmations = agentStore((state) => {
    const id = activeSessionIdOnNode(state, nodeId);
    return id ? state.pendingConfirmations[id] : undefined;
  });
  const sending = agentStore((state) => {
    const id = activeSessionIdOnNode(state, nodeId);
    return id ? state.sending[id] : undefined;
  });
  const materializingDraft = agentStore((state) => isDraftMaterializingOnNode(state, nodeId));
  const queued = agentStore((state) => {
    const id = activeSessionIdOnNode(state, nodeId);
    return id ? state.queued[id] : undefined;
  });
  const defaultWriteMode = agentStore((state) => state.defaultWriteMode);

  return {
    activeSessionId,
    activeSession,
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
  nodeId: string | null,
  activeSession: AgentSessionDto | undefined,
  draft: DraftSession | null,
  route: RoutePane
): void {
  const { routeDeviceId, routePaneId, routePaneTitle } = route;
  useEffect(() => {
    if (!activeSession && !draft && routeDeviceId && routePaneId) {
      agentStore.getState().startDraft({
        nodeId,
        deviceId: routeDeviceId,
        paneId: routePaneId,
        paneTitle: routePaneTitle,
      });
    }
  }, [activeSession, draft, nodeId, routeDeviceId, routePaneId, routePaneTitle, agentStore]);
}

/**
 * 路由 pane 切换后草稿仍绑在旧 pane：按当前路由重新起草，
 * 否则发送会物化到上一个 pane。未发送的预填 prompt 一并带到新草稿。
 */
function useSyncDraftToRoute(
  agentStore: AgentStoreHandle,
  nodeId: string | null,
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
    agentStore.getState().startDraft({
      nodeId,
      deviceId: routeDeviceId,
      paneId: routePaneId,
      paneTitle: routePaneTitle,
      prompt: draft?.prompt ?? null,
    });
  }, [activeSession, draft, nodeId, routeDeviceId, routePaneId, routePaneTitle, agentStore]);
}

export function useAgentTabState(host: AgentTabHost = {}): AgentTabState {
  const runtime = useRuntime();
  const agentStore = host.agentStore ?? resolveAgentStore(runtime.stores.agent);
  const nodeId = normalizeAgentNodeId(runtime.nodeId);
  const devices = useDevices(runtime);
  const { routeDeviceId, routePaneId } = useRouteMatch(runtime.host);
  const session = useAgentSessionSlice(agentStore, nodeId);

  // 绑定设备与路由设备可以不同（会话绑在旧 pane、路由已切走），两份快照分别订阅
  const routeSnapshot = useDeviceSnapshot(routeDeviceId);
  const bindingSnapshot = useDeviceSnapshot(
    bindingSource(session.activeSession, session.draft)?.deviceId ?? null
  );
  const routePaneTitle = useMemo(
    () => findPaneTitle(routeSnapshot, routePaneId),
    [routeSnapshot, routePaneId]
  );
  const route: RoutePane = { routeDeviceId, routePaneId, routePaneTitle };

  useSessionsBootstrap(agentStore);
  useAutoDraft(agentStore, nodeId, session.activeSession, session.draft, route);
  useSyncDraftToRoute(agentStore, nodeId, session.activeSession, session.draft, route);

  return {
    agentStore,
    bindingSnapshot,
    nodeId,
    nodeOffline: host.nodeOffline,
    ...devices,
    ...route,
    ...session,
  };
}
