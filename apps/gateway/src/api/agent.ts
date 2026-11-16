// Agent session REST API
// 用户消息 / 停止 / 确认决策统一走 REST（确认可能来自通知链接等非 WS 渠道）。

import { ensureAgentSupervisor, isAgentSupervisorReady, peekAgentRuntime } from '../agent/lazy';
import { paneGrantRoutes } from '../agent/pane-grant/routes';
import type { AgentSupervisor } from '../agent/supervisor';
import { createAgentConfirmationRoutes } from './agent-confirmation-routes';
import { createAgentMessageRoutes } from './agent-message-routes';
import { createAgentSessionRoutes } from './agent-session-routes';
import { routeNotFound } from './lazy-routes';
import type { ApiRoute } from './route';

function loadedSupervisor(): AgentSupervisor {
  const loaded = peekAgentRuntime();
  if (!loaded) throw new Error('agent supervisor is not loaded');
  return loaded.agentSupervisor;
}

/** 转发到懒加载的单例；写路由先确保已加载且（live 下）已运行，读路由（GET）不碰 supervisor。 */
const lazySupervisor = new Proxy({} as AgentSupervisor, {
  get(_target, key) {
    const supervisor = loadedSupervisor();
    const value = Reflect.get(supervisor, key);
    return typeof value === 'function' ? value.bind(supervisor) : value;
  },
});

function ensureBeforeWrite(entry: ApiRoute): ApiRoute {
  if (entry.method === 'GET') return entry;
  return {
    ...entry,
    handler: (req, params, ctx) => {
      if (isAgentSupervisorReady()) return entry.handler(req, params, ctx);
      return ensureAgentSupervisor().then(() => entry.handler(req, params, ctx) ?? routeNotFound());
    },
  };
}

function buildRoutes(supervisor: AgentSupervisor): ApiRoute[] {
  return [
    ...createAgentSessionRoutes(supervisor),
    ...createAgentMessageRoutes(supervisor),
    ...createAgentConfirmationRoutes(supervisor),
  ];
}

export function createAgentRoutes(supervisor?: AgentSupervisor): ApiRoute[] {
  const routes = supervisor
    ? buildRoutes(supervisor)
    : buildRoutes(lazySupervisor).map(ensureBeforeWrite);
  return [...routes, ...paneGrantRoutes];
}

export const agentRoutes = createAgentRoutes();
