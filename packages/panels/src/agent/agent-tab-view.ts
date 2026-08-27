// AgentTab 的派生态：由 AgentTabState 纯函数推导，无副作用。

import type { AgentQueuedMessageDto, AgentSessionDto, AgentWriteMode } from '@tmex/shared';
import type { DraftSession } from '@tmex/stores';
import { lastUserMessageText } from '@tmex/stores';

import { type BindingInfo, resolveBinding } from './agent-binding';
import type { AgentTabState } from './use-agent-tab-state';

export interface AgentTabView {
  activeSession: AgentSessionDto | undefined;
  draft: DraftSession | null;
  binding: BindingInfo | null;
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
}

/** 草稿态（尚未创建 session）也显示绑定 chip：此时显示的是将要绑定的 pane */
function deriveBinding(state: AgentTabState): BindingInfo | null {
  const { activeSession, draft } = state;
  const source =
    activeSession ?? (draft ? { deviceId: draft.deviceId, paneId: draft.paneId } : null);
  return source ? resolveBinding(source, state.snapshots, state.devices) : null;
}

/** 孤立会话：设备缺失 / 不在列表 / pane 在快照中已不存在 → 仅可只读查看 */
function isOrphanSession(state: AgentTabState, binding: BindingInfo | null): boolean {
  const { activeSession, devices } = state;
  if (!activeSession) return false;
  return (
    !activeSession.deviceId ||
    !devices?.some((device) => device.id === activeSession.deviceId) ||
    binding?.state === 'invalid'
  );
}

function hasPaneMismatch(state: AgentTabState): boolean {
  const { activeSession, routeDeviceId, routePaneId } = state;
  if (!activeSession || !routePaneId || !routeDeviceId) return false;
  return activeSession.paneId !== routePaneId || activeSession.deviceId !== routeDeviceId;
}

function deriveComposerView(state: AgentTabState, isOrphan: boolean, hasContext: boolean) {
  const { activeSession, draft, sending } = state;
  return {
    modelProviderId: activeSession ? activeSession.providerId : (draft?.providerId ?? null),
    modelId: activeSession ? activeSession.modelId : (draft?.modelId ?? null),
    // 有活动 session 时反映该 session 的写入模式；否则用浏览器记忆的默认值（新 session 的初值）
    writeMode: activeSession ? activeSession.writeMode : state.defaultWriteMode,
    allowControlChars: activeSession?.allowControlChars ?? false,
    // 草稿物化在途时同样禁用输入，避免同一草稿被重复提交
    inputDisabled:
      isOrphan ||
      !hasContext ||
      activeSession?.status === 'waiting_confirmation' ||
      Boolean(sending) ||
      state.materializingDraft,
    sending: Boolean(sending),
  };
}

function deriveStatusView(state: AgentTabState, isOrphan: boolean) {
  const { activeSession, messages, routeDeviceId, routePaneId } = state;
  return {
    running: activeSession?.status === 'running',
    // 新建按钮仅在「有内容的活动会话」时显示；草稿态/空会话本身即新会话，隐藏之
    showNewSession: Boolean(activeSession && (messages?.length ?? 0) > 0),
    newSessionDisabled: !routeDeviceId || !routePaneId,
    showPaneMismatch: Boolean(activeSession && !isOrphan && hasPaneMismatch(state)),
    canRebind: Boolean(routePaneId),
    errorText: activeSession?.status === 'error' ? activeSession.lastError : null,
    retryText: lastUserMessageText(messages),
  };
}

export function deriveAgentTabView(state: AgentTabState): AgentTabView {
  const { activeSession, draft, queued } = state;
  const binding = deriveBinding(state);
  const isOrphan = isOrphanSession(state, binding);
  const hasContext = Boolean(activeSession || draft);
  return {
    activeSession,
    draft,
    binding,
    queuedItems: queued ?? [],
    isOrphan,
    hasContext,
    draftEmpty: Boolean(draft && !activeSession),
    ...deriveStatusView(state, isOrphan),
    ...deriveComposerView(state, isOrphan, hasContext),
  };
}
