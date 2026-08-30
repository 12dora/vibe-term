// AgentTab 的动作层：把视图事件翻译成 agent store 调用与路由跳转。

import type { NavigateFunction } from 'react-router';
import { useNavigate } from 'react-router';

import type { AgentSessionDto, AgentWriteMode } from '@tmex/shared';
import type { HostServices } from '@tmex/stores';
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

function createSessionActions(state: AgentTabState, view: AgentTabView) {
  const { agentStore, activeSession, activeSessionId, draft, nodeId } = state;
  const { routeDeviceId, routePaneId, routePaneTitle } = state;
  return {
    onDecide: (confirmationId: string, approved: boolean) => {
      if (!activeSessionId) return;
      void agentStore.getState().decideConfirmation(activeSessionId, confirmationId, approved);
    },
    onNewSession: () => {
      if (!routeDeviceId || !routePaneId) return;
      agentStore.getState().startDraft({
        nodeId,
        deviceId: routeDeviceId,
        paneId: routePaneId,
        paneTitle: routePaneTitle,
      });
    },
    onStop: () => {
      if (!activeSession) return;
      void agentStore.getState().stopSession(activeSession.id);
    },
    onRetry: () => {
      if (!activeSession || !view.retryText) return;
      void agentStore.getState().sendMessage(activeSession.id, view.retryText);
    },
    onRebind: () => {
      // 后端只接受 paneId：跨设备的路由 pane 不能改绑，否则会把别的设备的 pane id 写进本会话
      if (!activeSession || !routePaneId) return;
      if (!canRebindToRoute(activeSession, { deviceId: routeDeviceId, paneId: routePaneId }))
        return;
      void agentStore.getState().rebindPane(activeSession.id, routePaneId);
    },
    onModelChange: (providerId: string | null, modelId: string) => {
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

function createMessageActions(state: AgentTabState) {
  const { agentStore, activeSession, draft, nodeId } = state;
  return {
    onSend: (text: string) => {
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
      if (!activeSession) return;
      void agentStore.getState().enqueueMessage(activeSession.id, text, true);
    },
  };
}

function createQueueActions(state: AgentTabState, view: AgentTabView) {
  const { agentStore, activeSession } = state;
  return {
    onQueueEdit: (itemId: string, text: string) => {
      if (!activeSession) return;
      void agentStore.getState().editQueuedMessage(activeSession.id, itemId, text);
    },
    onQueueWithdraw: (itemId: string) => {
      if (!activeSession) return;
      void agentStore.getState().withdrawQueuedMessage(activeSession.id, itemId);
    },
    onQueueSteer: () => {
      const first = view.queuedItems[0];
      if (!activeSession || !first) return;
      const store = agentStore.getState();
      void (async () => {
        await store.withdrawQueuedMessage(activeSession.id, first.id);
        await store.enqueueMessage(activeSession.id, first.text, true);
      })();
    },
  };
}

function createSettingActions(state: AgentTabState) {
  const { agentStore, activeSession } = state;
  return {
    onWriteModeChange: (next: AgentWriteMode) => {
      // 记忆为默认值（影响后续新 session）；有活动 session 时同时改该 session
      agentStore.getState().setDefaultWriteMode(next);
      if (activeSession) {
        void agentStore.getState().setWriteMode(activeSession.id, next);
      }
    },
    onAllowControlCharsChange: (allow: boolean) => {
      if (!activeSession) return;
      void agentStore.getState().setAllowControlChars(activeSession.id, allow);
    },
  };
}

export function useAgentTabActions(state: AgentTabState, view: AgentTabView): AgentTabActions {
  const navigate = useNavigate();
  const { host } = useRuntime();
  const setSidebarTab = useUIStore((uiState) => uiState.setSidebarTab);
  return {
    ...createSessionActions(state, view),
    ...createMessageActions(state),
    ...createQueueActions(state, view),
    ...createSettingActions(state),
    onBindingClick: () => {
      navigateToBinding(navigate, host, state.activeSession, view.binding);
    },
    onSwitchSession: () => {
      setSidebarTab('panes');
    },
  };
}
