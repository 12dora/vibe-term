// AgentTab 的动作层：把视图事件翻译成 agent store 调用与路由跳转。
// 动作对象整个 tab 生命周期内保持同一引用（依赖走 ref 快照），
// 这样流式 delta flush 不会让 memo 化的输入区失效。

import { useRef } from 'react';
import type { NavigateFunction } from 'react-router';
import { useNavigate } from 'react-router';

import type { AgentSessionDto, AgentWriteMode } from '@tmex/shared';
import type { HostServices, SidebarTab } from '@tmex/stores';
import { encodePaneIdForUrl, hostAppPath } from '@tmex/stores';
import { useRuntime, useUIStore } from '@tmex/stores/react';

import type { BindingInfo } from './agent-binding';
import { canRebindToRoute } from './agent-route-sync';
import type { AgentTabView } from './agent-tab-view';
import type { AgentStoreHandle, AgentTabState } from './use-agent-tab-state';

export interface AgentTabActions {
  onDecide: (confirmationId: string, approved: boolean) => void;
  onBindingClick: () => void;
  onNewSession: () => void;
  onSwitchSession: () => void;
  onModelChange: (providerId: string | null, modelId: string) => void;
  onSend: (text: string) => void;
  onSteer: (text: string) => void;
  onStop: () => void;
  onRetry: () => void;
  onRebind: () => void;
  onQueueEdit: (itemId: string, text: string) => void;
  onQueueWithdraw: (itemId: string) => void;
  onQueueSteer: () => void;
  onWriteModeChange: (writeMode: AgentWriteMode) => void;
  onAllowControlCharsChange: (allow: boolean) => void;
}

export interface AgentTabActionDeps {
  state: AgentTabState;
  view: AgentTabView;
  navigate: NavigateFunction;
  host: HostServices;
  setSidebarTab: (tab: SidebarTab) => void;
}

/** 每次渲染刷新的依赖快照容器：动作只在调用时读它，自身引用恒定 */
export interface AgentTabActionDepsRef {
  current: AgentTabActionDeps;
}

// 会话绑定的 pane 属于本 tab 所在的 node，跳转必须带上该 node 的路由前缀
function navigateToBinding(
  navigate: NavigateFunction,
  host: HostServices,
  activeSession: AgentSessionDto | undefined,
  binding: BindingInfo | null
): void {
  if (!activeSession?.deviceId) return;
  if (binding?.state === 'valid' && binding.windowId && activeSession.paneId) {
    navigate(
      hostAppPath(
        host,
        `/devices/${activeSession.deviceId}/windows/${binding.windowId}/panes/${encodePaneIdForUrl(activeSession.paneId)}`
      )
    );
    return;
  }
  if (binding?.state === 'unknown') {
    navigate(hostAppPath(host, `/devices/${activeSession.deviceId}`));
  }
}

function createSessionActions(ref: AgentTabActionDepsRef) {
  return {
    onDecide: (confirmationId: string, approved: boolean) => {
      const { agentStore, activeSessionId } = ref.current.state;
      if (!activeSessionId) return;
      void agentStore.getState().decideConfirmation(activeSessionId, confirmationId, approved);
    },
    onNewSession: () => {
      const { agentStore, nodeId, routeDeviceId, routePaneId, routePaneTitle } = ref.current.state;
      if (!routeDeviceId || !routePaneId) return;
      agentStore.getState().startDraft({
        nodeId,
        deviceId: routeDeviceId,
        paneId: routePaneId,
        paneTitle: routePaneTitle,
      });
    },
    onStop: () => {
      const { agentStore, activeSession } = ref.current.state;
      if (!activeSession) return;
      void agentStore.getState().stopSession(activeSession.id);
    },
    onRetry: () => {
      const { state, view } = ref.current;
      if (!state.activeSession || !view.retryText) return;
      void state.agentStore.getState().sendMessage(state.activeSession.id, view.retryText);
    },
    onRebind: () => {
      // 后端只接受 paneId：跨设备的路由 pane 不能改绑，否则会把别的设备的 pane id 写进本会话
      const { agentStore, activeSession, routeDeviceId, routePaneId } = ref.current.state;
      if (!activeSession || !routePaneId) return;
      if (!canRebindToRoute(activeSession, { deviceId: routeDeviceId, paneId: routePaneId }))
        return;
      void agentStore.getState().rebindPane(activeSession.id, routePaneId);
    },
    onModelChange: (providerId: string | null, modelId: string) => {
      const { agentStore, activeSession, draft, nodeId } = ref.current.state;
      if (activeSession) {
        void agentStore.getState().setSessionModel(activeSession.id, providerId, modelId);
      } else if (draft) {
        agentStore.getState().updateDraft(nodeId, { providerId, modelId });
      }
    },
  };
}

type AgentStoreState = ReturnType<AgentStoreHandle['getState']>;

function sendToDraft(store: AgentStoreState, nodeId: string | null, text: string): void {
  // materializeDraft 对同一草稿去重：并发提交共享同一次建会话，消息落在同一 session
  void (async () => {
    const session = await store.materializeDraft(nodeId);
    if (session) await store.sendMessage(session.id, text);
  })();
}

function createMessageActions(ref: AgentTabActionDepsRef) {
  return {
    onSend: (text: string) => {
      const { agentStore, activeSession, draft, nodeId } = ref.current.state;
      const store = agentStore.getState();
      if (activeSession) {
        if (activeSession.status === 'running') {
          void store.enqueueMessage(activeSession.id, text);
        } else {
          void store.sendMessage(activeSession.id, text);
        }
        return;
      }
      if (draft) {
        sendToDraft(store, nodeId, text);
      }
    },
    onSteer: (text: string) => {
      const { agentStore, activeSession } = ref.current.state;
      if (!activeSession) return;
      void agentStore.getState().enqueueMessage(activeSession.id, text, true);
    },
  };
}

function createQueueActions(ref: AgentTabActionDepsRef) {
  return {
    onQueueEdit: (itemId: string, text: string) => {
      const { agentStore, activeSession } = ref.current.state;
      if (!activeSession) return;
      void agentStore.getState().editQueuedMessage(activeSession.id, itemId, text);
    },
    onQueueWithdraw: (itemId: string) => {
      const { agentStore, activeSession } = ref.current.state;
      if (!activeSession) return;
      void agentStore.getState().withdrawQueuedMessage(activeSession.id, itemId);
    },
    onQueueSteer: () => {
      const { state, view } = ref.current;
      const first = view.queuedItems[0];
      if (!state.activeSession || !first) return;
      const sessionId = state.activeSession.id;
      const store = state.agentStore.getState();
      void (async () => {
        await store.withdrawQueuedMessage(sessionId, first.id);
        await store.enqueueMessage(sessionId, first.text, true);
      })();
    },
  };
}

function createSettingActions(ref: AgentTabActionDepsRef) {
  return {
    onWriteModeChange: (next: AgentWriteMode) => {
      // 记忆为默认值（影响后续新 session）；有活动 session 时同时改该 session
      const { agentStore, activeSession } = ref.current.state;
      agentStore.getState().setDefaultWriteMode(next);
      if (activeSession) {
        void agentStore.getState().setWriteMode(activeSession.id, next);
      }
    },
    onAllowControlCharsChange: (allow: boolean) => {
      const { agentStore, activeSession } = ref.current.state;
      if (!activeSession) return;
      void agentStore.getState().setAllowControlChars(activeSession.id, allow);
    },
  };
}

export function createAgentTabActions(ref: AgentTabActionDepsRef): AgentTabActions {
  return {
    ...createSessionActions(ref),
    ...createMessageActions(ref),
    ...createQueueActions(ref),
    ...createSettingActions(ref),
    onBindingClick: () => {
      const { state, view, navigate, host } = ref.current;
      navigateToBinding(navigate, host, state.activeSession, view.binding);
    },
    onSwitchSession: () => {
      ref.current.setSidebarTab('panes');
    },
  };
}

export function useAgentTabActions(state: AgentTabState, view: AgentTabView): AgentTabActions {
  const navigate = useNavigate();
  const { host } = useRuntime();
  const setSidebarTab = useUIStore((uiState) => uiState.setSidebarTab);
  const deps = useRef<AgentTabActionDeps>({ state, view, navigate, host, setSidebarTab });
  deps.current = { state, view, navigate, host, setSidebarTab };
  const actions = useRef<AgentTabActions | null>(null);
  actions.current ??= createAgentTabActions(deps);
  return actions.current;
}
