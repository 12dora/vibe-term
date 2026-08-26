// AgentTab 的数据层：store 选择、路由绑定解析、派生态与全部动作，视图组件只消费返回值。

import { useEffect, useMemo } from 'react';
import { useMatch, useNavigate } from 'react-router';

import { useQuery } from '@tanstack/react-query';
import type {
  AgentQueuedMessageDto,
  AgentSessionDto,
  AgentWriteMode,
  Device,
  StateSnapshotPayload,
} from '@tmex/shared';
import type { DraftSession, UiThreadBlock } from '@tmex/stores';
import { buildTerminalLabel, buildThreadBlocks, lastUserMessageText } from '@tmex/stores';
import { useAgentStore, useRuntime, useTmuxStore, useUIStore } from '@tmex/stores/react';

export interface BindingInfo {
  label: string;
  state: 'valid' | 'invalid' | 'unknown';
  windowId: string | null;
}

export function resolveBinding(
  binding: { deviceId: string | null; paneId: string | null },
  snapshots: Record<string, StateSnapshotPayload | undefined>,
  devices: Device[] | undefined
): BindingInfo | null {
  if (!binding.deviceId || !binding.paneId) {
    return null;
  }
  const deviceName = devices?.find((device) => device.id === binding.deviceId)?.name ?? null;
  const snapshot = snapshots[binding.deviceId];
  if (!snapshot?.session) {
    return {
      label: `${binding.paneId}@${deviceName ?? '?'}`,
      state: 'unknown',
      windowId: null,
    };
  }
  for (const window of snapshot.session.windows) {
    const pane = window.panes.find((candidate) => candidate.id === binding.paneId);
    if (pane) {
      return {
        label: buildTerminalLabel({
          paneCustomName: pane.customName,
          paneTitle: pane.title,
          windowName: window.name,
          windowCustomName: window.customName,
          deviceName,
        }),
        state: 'valid',
        windowId: window.id,
      };
    }
  }
  return {
    label: `${binding.paneId}@${deviceName ?? '?'}`,
    state: 'invalid',
    windowId: null,
  };
}

export interface AgentTabModel {
  activeSession: AgentSessionDto | undefined;
  draft: DraftSession | null;
  binding: BindingInfo | null;
  blocks: UiThreadBlock[];
  confirmationByToolCallId: Map<string, string>;
  queuedItems: AgentQueuedMessageDto[];
  running: boolean;
  isOrphan: boolean;
  hasContext: boolean;
  /** 已选 pane、尚无 session 的空 Chat：隐藏大聊天卡片，输入框居中 */
  draftEmpty: boolean;
  showNewSession: boolean;
  newSessionDisabled: boolean;
  showPaneMismatch: boolean;
  canRebind: boolean;
  inputDisabled: boolean;
  sending: boolean;
  errorText: string | null;
  retryText: string | null;
  modelProviderId: string | null;
  modelId: string | null;
  writeMode: AgentWriteMode;
  allowControlChars: boolean;
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

export function useAgentTabModel(): AgentTabModel {
  const navigate = useNavigate();
  const runtime = useRuntime();
  const agentStore = runtime.stores.agent;
  const expandSidebarSection = useUIStore((state) => state.expandSidebarSection);

  const paneMatch = useMatch('/devices/:deviceId/windows/:windowId/panes/:paneId');
  const routeDeviceId = paneMatch?.params.deviceId ?? null;
  const routePaneId = paneMatch?.params.paneId ?? null;

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

  const snapshots = useTmuxStore((state) => state.snapshots);

  const { data: devicesData } = useQuery({
    queryKey: ['devices'],
    queryFn: async () => {
      const res = await runtime.apiClient.fetch('/api/devices');
      if (!res.ok) throw new Error('Failed to load devices');
      return res.json() as Promise<{ devices: Device[] }>;
    },
    throwOnError: false,
  });

  useEffect(() => {
    const store = agentStore.getState();
    store.ensureInitialized();
    void store.loadSessions();
  }, [agentStore]);

  const activeSession = activeSessionId ? sessions[activeSessionId] : undefined;

  // 当前路由 pane 的 snapshot 标题，用作新建会话的起源元数据
  const routePaneTitle = useMemo(() => {
    if (!routeDeviceId || !routePaneId) return null;
    const windows = snapshots[routeDeviceId]?.session?.windows;
    for (const window of windows ?? []) {
      const pane = window.panes.find((candidate) => candidate.id === routePaneId);
      if (pane) return pane.title ?? null;
    }
    return null;
  }, [routeDeviceId, routePaneId, snapshots]);

  // 空态即草稿态：进入 agent tab 且有路由 pane 但无会话/草稿时自动起草
  useEffect(() => {
    if (!activeSession && !draft && routeDeviceId && routePaneId) {
      agentStore.getState().startDraft(routeDeviceId, routePaneId, routePaneTitle);
    }
  }, [activeSession, draft, routeDeviceId, routePaneId, routePaneTitle, agentStore]);

  const confirmationByToolCallId = useMemo(() => {
    const map = new Map<string, string>();
    for (const confirmation of pendingConfirmations ?? []) {
      map.set(confirmation.toolCallId, confirmation.id);
    }
    return map;
  }, [pendingConfirmations]);

  const blocks = useMemo(() => {
    const merged = buildThreadBlocks(messages, inProgress);
    const knownToolCallIds = new Set<string>();
    for (const block of merged) {
      if (block.kind === 'tool-call') {
        knownToolCallIds.add(block.call.toolCallId);
      }
    }
    const extras: UiThreadBlock[] = [];
    for (const confirmation of pendingConfirmations ?? []) {
      if (knownToolCallIds.has(confirmation.toolCallId)) continue;
      extras.push({
        kind: 'tool-call',
        key: `confirmation-${confirmation.id}`,
        call: {
          toolCallId: confirmation.toolCallId,
          toolName: confirmation.toolName,
          input: confirmation.input,
          isError: false,
          denied: false,
          resolved: false,
        },
      });
    }
    return extras.length > 0 ? [...merged, ...extras] : merged;
  }, [messages, inProgress, pendingConfirmations]);

  // 草稿态（尚未创建 session）也显示绑定 chip：此时显示的是将要绑定的 pane
  const bindingSource =
    activeSession ?? (draft ? { deviceId: draft.deviceId, paneId: draft.paneId } : null);
  const binding = bindingSource
    ? resolveBinding(bindingSource, snapshots, devicesData?.devices)
    : null;
  const paneMismatch = Boolean(
    activeSession &&
      routePaneId &&
      routeDeviceId &&
      (activeSession.paneId !== routePaneId || activeSession.deviceId !== routeDeviceId)
  );

  const running = activeSession?.status === 'running';
  const retryText = lastUserMessageText(messages);

  // 孤立会话：设备缺失 / 不在列表 / pane 在快照中已不存在 → 仅可只读查看
  const isOrphan = Boolean(
    activeSession &&
      (!activeSession.deviceId ||
        !devicesData?.devices?.some((device) => device.id === activeSession.deviceId) ||
        binding?.state === 'invalid')
  );

  const queuedItems = queued ?? [];

  const onDecide = (confirmationId: string, approved: boolean): void => {
    if (!activeSessionId) return;
    void agentStore.getState().decideConfirmation(activeSessionId, confirmationId, approved);
  };

  const onBindingClick = (): void => {
    if (!activeSession?.deviceId) return;
    if (binding?.state === 'valid' && binding.windowId && activeSession.paneId) {
      navigate(
        `/devices/${activeSession.deviceId}/windows/${binding.windowId}/panes/${encodeURIComponent(activeSession.paneId)}`
      );
      return;
    }
    if (binding?.state === 'unknown') {
      navigate(`/devices/${activeSession.deviceId}`);
    }
  };

  const onNewSession = (): void => {
    if (!routeDeviceId || !routePaneId) return;
    agentStore.getState().startDraft(routeDeviceId, routePaneId, routePaneTitle);
  };

  const onModelChange = (providerId: string | null, modelId: string): void => {
    if (activeSession) {
      void agentStore.getState().setSessionModel(activeSession.id, providerId, modelId);
    } else if (draft) {
      agentStore.getState().updateDraft({ providerId, modelId });
    }
  };

  const onSend = (text: string): void => {
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
      // materializeDraft 对同一草稿去重：并发提交共享同一次建会话，消息落在同一 session
      void (async () => {
        const session = await store.materializeDraft();
        if (session) await store.sendMessage(session.id, text);
      })();
    }
  };

  const onSteer = (text: string): void => {
    if (!activeSession) return;
    void agentStore.getState().enqueueMessage(activeSession.id, text, true);
  };

  const onQueueSteer = (): void => {
    if (!activeSession) return;
    const first = queuedItems[0];
    if (!first) return;
    const store = agentStore.getState();
    void (async () => {
      await store.withdrawQueuedMessage(activeSession.id, first.id);
      await store.enqueueMessage(activeSession.id, first.text, true);
    })();
  };

  const modelProviderId = activeSession ? activeSession.providerId : (draft?.providerId ?? null);
  const modelId = activeSession ? activeSession.modelId : (draft?.modelId ?? null);
  const hasContext = Boolean(activeSession || draft);
  const draftEmpty = Boolean(draft && !activeSession);
  // 有活动 session 时反映该 session 的写入模式；否则用浏览器记忆的默认值（新 session 的初值）
  const writeMode = activeSession ? activeSession.writeMode : defaultWriteMode;
  const allowControlChars = activeSession?.allowControlChars ?? false;
  // 新建按钮仅在「有内容的活动会话」时显示；草稿态/空会话本身即新会话，隐藏之
  const showNewSession = Boolean(activeSession && (messages?.length ?? 0) > 0);
  // 草稿物化在途时同样禁用输入，避免同一草稿被重复提交
  const inputDisabled =
    isOrphan ||
    !hasContext ||
    activeSession?.status === 'waiting_confirmation' ||
    Boolean(sending) ||
    materializingDraft;

  return {
    activeSession,
    draft,
    binding,
    blocks,
    confirmationByToolCallId,
    queuedItems,
    running: Boolean(running),
    isOrphan,
    hasContext,
    draftEmpty,
    showNewSession,
    newSessionDisabled: !routeDeviceId || !routePaneId,
    showPaneMismatch: Boolean(activeSession && !isOrphan && paneMismatch),
    canRebind: Boolean(routePaneId),
    inputDisabled,
    sending: Boolean(sending),
    errorText: activeSession?.status === 'error' ? activeSession.lastError : null,
    retryText,
    modelProviderId,
    modelId,
    writeMode,
    allowControlChars,
    onDecide,
    onBindingClick,
    onNewSession,
    onSwitchSession: () => {
      expandSidebarSection('panes');
    },
    onModelChange,
    onSend,
    onSteer,
    onStop: () => {
      if (activeSession) {
        void agentStore.getState().stopSession(activeSession.id);
      }
    },
    onRetry: () => {
      if (!activeSession || !retryText) return;
      void agentStore.getState().sendMessage(activeSession.id, retryText);
    },
    onRebind: () => {
      if (!activeSession || !routePaneId) return;
      void agentStore.getState().rebindPane(activeSession.id, routePaneId);
    },
    onQueueEdit: (itemId, text) => {
      if (!activeSession) return;
      void agentStore.getState().editQueuedMessage(activeSession.id, itemId, text);
    },
    onQueueWithdraw: (itemId) => {
      if (!activeSession) return;
      void agentStore.getState().withdrawQueuedMessage(activeSession.id, itemId);
    },
    onQueueSteer,
    onWriteModeChange: (next) => {
      // 记忆为默认值（影响后续新 session）；有活动 session 时同时改该 session
      agentStore.getState().setDefaultWriteMode(next);
      if (activeSession) {
        void agentStore.getState().setWriteMode(activeSession.id, next);
      }
    },
    onAllowControlCharsChange: (allow) => {
      if (!activeSession) return;
      void agentStore.getState().setAllowControlChars(activeSession.id, allow);
    },
  };
}
