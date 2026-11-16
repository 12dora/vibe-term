import { t } from '../i18n';
import { createMemoizedLoader } from '../lazy-load';
import { json } from './http';
import { type ApiRoute, dispatchRoutes } from './route';

export function routeNotFound(): Response {
  return json({ error: t('apiError.notFound'), code: 'route_not_found' }, 404);
}

/**
 * 整组路由按路径前缀懒加载：首个命中前缀的请求才 import 路由模块（及其服务）。
 * 已加载时同步分发，未命中照常落到后续路由；首次加载期间未命中直接 404——
 * 前缀必须独占，后续路由里不能再有同前缀路径。
 */
export function lazyRouteGroup(prefix: string, load: () => Promise<ApiRoute[]>): ApiRoute {
  const loader = createMemoizedLoader(load);
  return {
    method: '*',
    path: `${prefix}*`,
    handler: (req, _params, ctx) => {
      const loaded = loader.peek();
      if (loaded) return dispatchRoutes(req, ctx.path, loaded, ctx);
      return loader
        .load()
        .then((routes) => dispatchRoutes(req, ctx.path, routes, ctx) ?? routeNotFound());
    },
  };
}
