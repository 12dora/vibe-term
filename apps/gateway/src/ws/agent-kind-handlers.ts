import { wsBorsh } from '@tmex/shared';
import { agentWsHub } from '../agent/ws-hub';
import { type BorshDispatchHost, type BorshKindHandler, schemaHandler } from './borsh-kind-types';

export function createAgentKindHandlers(
  host: BorshDispatchHost
): Array<[number, BorshKindHandler<unknown>]> {
  return [
    [
      wsBorsh.KIND_AGENT_SUBSCRIBE,
      schemaHandler(wsBorsh.schema.AgentSubscribeSchema, async (ws, decoded) => {
        await agentWsHub.subscribe(ws, decoded.sessionId);
      }),
    ],
    [
      wsBorsh.KIND_AGENT_UNSUBSCRIBE,
      schemaHandler(wsBorsh.schema.AgentUnsubscribeSchema, (ws, decoded) => {
        agentWsHub.unsubscribe(ws, decoded.sessionId);
      }),
    ],
    [
      wsBorsh.KIND_SITE_THEME_UPDATE,
      schemaHandler(wsBorsh.schema.SiteThemeUpdateC2SSchema, (ws, decoded) => {
        host.handleSiteThemeUpdate(ws, decoded);
      }),
    ],
  ];
}
