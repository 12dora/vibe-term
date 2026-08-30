// AgentTab 的数据层：组合 state / 派生态 / 动作，视图组件只消费返回值。

import { useMemo } from 'react';

import type { UiThreadBlock } from '@tmex/stores';

import { type AgentTabView, deriveAgentTabView } from './agent-tab-view';
import { buildBlocksWithConfirmations, buildConfirmationMap } from './agent-thread-blocks';
import { type AgentTabActions, useAgentTabActions } from './use-agent-tab-actions';
import { type AgentTabHost, useAgentTabState } from './use-agent-tab-state';

export { type BindingInfo, resolveBinding } from './agent-binding';

export interface AgentTabModel extends AgentTabView, AgentTabActions {
  blocks: UiThreadBlock[];
  confirmationByToolCallId: Map<string, string>;
}

export function useAgentTabModel(host: AgentTabHost = {}): AgentTabModel {
  const state = useAgentTabState(host);
  const { messages, inProgress, pendingConfirmations } = state;

  const confirmationByToolCallId = useMemo(
    () => buildConfirmationMap(pendingConfirmations),
    [pendingConfirmations]
  );
  const blocks = useMemo(
    () => buildBlocksWithConfirmations(messages, inProgress, pendingConfirmations),
    [messages, inProgress, pendingConfirmations]
  );

  const view = deriveAgentTabView(state);
  const actions = useAgentTabActions(state, view);

  return { ...view, ...actions, blocks, confirmationByToolCallId };
}
