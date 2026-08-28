// Agent session REST API
// 用户消息 / 停止 / 确认决策统一走 REST（确认可能来自通知链接等非 WS 渠道）。

import { type AgentSupervisor, agentSupervisor } from '../agent/supervisor';
import { createAgentConfirmationRoutes } from './agent-confirmation-routes';
import { createAgentMessageRoutes } from './agent-message-routes';
import { createAgentSessionRoutes } from './agent-session-routes';
import type { ApiRoute } from './route';

export function createAgentRoutes(supervisor: AgentSupervisor = agentSupervisor): ApiRoute[] {
  return [
    ...createAgentSessionRoutes(supervisor),
    ...createAgentMessageRoutes(supervisor),
    ...createAgentConfirmationRoutes(supervisor),
  ];
}

export const agentRoutes = createAgentRoutes();
