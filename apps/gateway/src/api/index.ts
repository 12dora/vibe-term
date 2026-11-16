import type { Server } from 'bun';
import { runWithFileAccessPrincipal } from '../auth/token-scope';
import { getMeshRequestContext } from '../mesh/mesh-deps';
import { ensurePortMapManagerStarted } from '../portmap/lazy';
import { shareAccessRoutes, shareRoutes } from '../share';
import { transferRoutes } from '../transfer/routes';
import { accessTokenRoutes } from './access-token-routes';
import { deviceFolderRoutes } from './device-folder-routes';
import { deviceRoutes } from './device-routes';
import { domainAccessRoutes } from './domain-access-routes';
import { execRoutes } from './exec-routes';
import { filesRoutes } from './files';
import { lazyRouteGroup, routeNotFound } from './lazy-routes';
import { notificationsMeshRoutes } from './notifications-mesh-routes';
import {
  type ApiRoute,
  type ApiRouteContext,
  type SystemApiHandler,
  dispatchRoutes,
} from './route';
import { sessionsMemoryRoutes } from './sessions-memory-routes';
import { settingsRoutes } from './settings-routes';
import { healthRoutes, systemPrefixRoutes } from './system-routes';
import { webhookRoutes } from './webhook-routes';

export type { SystemApiHandler };

const tunnelRoutes = lazyRouteGroup('/api/tunnel/', async () => {
  return (await import('./tunnel-routes')).tunnelRoutes;
});
const telegramRoutes = lazyRouteGroup('/api/settings/telegram/', async () => {
  return (await import('./telegram-routes')).telegramRoutes;
});
const weixinRoutes = lazyRouteGroup('/api/settings/weixin/', async () => {
  return (await import('./weixin-routes')).weixinRoutes;
});
const llmRoutes = lazyRouteGroup('/api/llm/', async () => {
  return (await import('./llm')).llmRoutes;
});
const agentRoutes = lazyRouteGroup('/api/agent/', async () => {
  return (await import('./agent')).agentRoutes;
});
const watchRoutes = lazyRouteGroup('/api/watch/', async () => {
  return (await import('./watch')).watchRoutes;
});
const portMapRoutes = lazyRouteGroup('/api/portmap', async () => {
  await ensurePortMapManagerStarted();
  return (await import('../portmap/routes')).portMapRoutes;
});

const apiRoutes: ApiRoute[] = [
  ...deviceRoutes,
  ...deviceFolderRoutes,
  ...settingsRoutes,
  ...sessionsMemoryRoutes,
  ...shareRoutes,
  ...shareAccessRoutes,
  tunnelRoutes,
  telegramRoutes,
  weixinRoutes,
  llmRoutes,
  ...notificationsMeshRoutes,
  agentRoutes,
  watchRoutes,
  ...filesRoutes,
  ...execRoutes,
  ...transferRoutes,
  portMapRoutes,
  ...domainAccessRoutes,
  ...accessTokenRoutes,
  ...systemPrefixRoutes,
  ...webhookRoutes,
  ...healthRoutes,
];

export function handleApiRequest(
  req: Request,
  _server?: Server<unknown>,
  systemApiHandler?: SystemApiHandler
): Response | Promise<Response> {
  return runWithFileAccessPrincipal(
    getMeshRequestContext(req).tokenId ? 'token' : 'session',
    () => {
      const path = new URL(req.url).pathname;
      const ctx: ApiRouteContext = { server: _server, path, systemApiHandler };
      const matched = dispatchRoutes(req, path, apiRoutes, ctx);
      if (matched) return matched;
      return routeNotFound();
    }
  );
}
