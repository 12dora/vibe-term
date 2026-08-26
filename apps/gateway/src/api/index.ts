import type { Server } from 'bun';
import { t } from '../i18n';
import { agentRoutes } from './agent-routes';
import { deviceRoutes } from './device-routes';
import { json } from './http';
import { telegramRoutes, webhookRoutes, weixinRoutes } from './messaging-routes';
import {
  type ApiRoute,
  type ApiRouteContext,
  type SystemApiHandler,
  dispatchRoutes,
} from './route';
import { settingsRoutes } from './settings-routes';
import {
  capabilitiesRoutes,
  filesRoutes,
  healthRoutes,
  systemPrefixRoutes,
  tmuxTreeRoutes,
} from './system-routes';

export type { SystemApiHandler };

const apiRoutes: ApiRoute[] = [
  ...capabilitiesRoutes,
  ...deviceRoutes,
  ...tmuxTreeRoutes,
  ...settingsRoutes,
  ...telegramRoutes,
  ...weixinRoutes,
  ...agentRoutes,
  ...filesRoutes,
  ...systemPrefixRoutes,
  ...webhookRoutes,
  ...healthRoutes,
];

export function handleApiRequest(
  req: Request,
  _server: Server<unknown>,
  systemApiHandler?: SystemApiHandler
): Response | Promise<Response> {
  const path = new URL(req.url).pathname;
  const ctx: ApiRouteContext = { server: _server, path, systemApiHandler };
  const matched = dispatchRoutes(req, path, apiRoutes, ctx);
  if (matched) return matched;
  return json({ error: t('apiError.notFound') }, 404);
}
