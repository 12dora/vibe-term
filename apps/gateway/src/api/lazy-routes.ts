import { t } from '../i18n';
import { createMemoizedLoader } from '../lazy-load';
import { json } from './http';
import { type ApiRoute, type ApiRouteContext, dispatchRoutes } from './route';

export function routeNotFound(): Response {
  return json({ error: t('apiError.notFound'), code: 'route_not_found' }, 404);
}

export type LazyRouteGroupOptions = {
  /** 每次请求的同步判定：为 false 时先走 prepare（如确保服务已运行）再分发。 */
  ready?: () => boolean;
  prepare?: () => Promise<void>;
};

/**
 * 整组路由按路径懒加载：只认 `base` 本身与 `base/…`，首个命中的请求才 import 路由模块（及其服务）。
 * 已加载且 ready 时同步分发，未命中照常落到后续路由；需要异步准备时未命中直接 404——
 * 该路径段必须由本组独占。
 */
export function lazyRouteGroup(
  base: string,
  load: () => Promise<ApiRoute[]>,
  options: LazyRouteGroupOptions = {}
): ApiRoute {
  const loader = createMemoizedLoader(load);
  const owns = (path: string) => path === base || path.startsWith(`${base}/`);
  const dispatchAsync = async (req: Request, ctx: ApiRouteContext): Promise<Response> => {
    const routes = await loader.load();
    await options.prepare?.();
    return (await dispatchRoutes(req, ctx.path, routes, ctx)) ?? routeNotFound();
  };
  return {
    method: '*',
    path: `${base}*`,
    handler: (req, _params, ctx) => {
      if (!owns(ctx.path)) return undefined;
      const loaded = loader.peek();
      if (loaded && (options.ready?.() ?? true)) return dispatchRoutes(req, ctx.path, loaded, ctx);
      return dispatchAsync(req, ctx);
    },
  };
}
