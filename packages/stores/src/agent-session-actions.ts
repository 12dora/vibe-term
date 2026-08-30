// 会话维度 REST 动作的组合根：按域拼装 CRUD、消息、草稿、确认四组动作。

import { createAgentSessionConfirmationActions } from './agent-session-confirmation-actions';
import { createAgentSessionCrudActions } from './agent-session-crud-actions';
import type { AgentSessionActionsDeps } from './agent-session-deps';
import { createAgentSessionDraftActions } from './agent-session-draft-actions';
import { createAgentSessionMessageActions } from './agent-session-message-actions';
import type { AgentActions } from './agent-state';

export type { AgentSessionActionsDeps } from './agent-session-deps';
export { mergeFetchedSessions, sortSessionOrder, withSessionOrder } from './agent-session-map';

export type AgentSessionActions = Omit<AgentActions, 'ensureInitialized'> & {
  evictHistories: () => void;
};

export function createAgentSessionActions(deps: AgentSessionActionsDeps): AgentSessionActions {
  return {
    ...createAgentSessionCrudActions(deps),
    ...createAgentSessionMessageActions(deps),
    ...createAgentSessionDraftActions(deps),
    ...createAgentSessionConfirmationActions(deps),
  };
}
