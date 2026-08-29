import type { Server } from 'bun';
import { t } from '../i18n';
import { agentRoutes } from './agent';
import { deviceFolderRoutes } from './device-folder-routes';
import { deviceRoutes } from './device-routes';
import { filesRoutes } from './files';
import { json } from './http';
import { llmRoutes } from './llm';
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
  healthRoutes,
  systemPrefixRoutes,
  tmuxTreeRoutes,
} from './system-routes';
import { watchRoutes } from './watch';

export type { SystemApiHandler };

const apiRoutes: ApiRoute[] = [
  ...capabilitiesRoutes,
  ...deviceRoutes,
  ...deviceFolderRoutes,
  ...tmuxTreeRoutes,
  ...settingsRoutes,
  ...telegramRoutes,
  ...weixinRoutes,
  ...llmRoutes,
  ...agentRoutes,
  ...watchRoutes,
  ...filesRoutes,
  ...systemPrefixRoutes,
  ...webhookRoutes,
  ...healthRoutes,
];

export function handleApiRequest(
  req: Request,
  _server?: Server<unknown>,
  systemApiHandler?: SystemApiHandler
): Response | Promise<Response> {
  const path = new URL(req.url).pathname;
  const ctx: ApiRouteContext = { server: _server, path, systemApiHandler };
  const matched = dispatchRoutes(req, path, apiRoutes, ctx);
  if (matched) return matched;
  return json({ error: t('apiError.notFound') }, 404);
}
