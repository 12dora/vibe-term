import type { LocalRouteDeps } from './local-routes';

export {
  disableDirectLazily as lazyDisableDirect,
  enableDirectLazily as lazyEnableDirect,
} from '../commands/direct-lazy';

const SETUP_PATH_PREFIX = '/api/setup/';

/** 接入向导（成为 / 加入中继）路由只在 `/api/setup/*` 首次请求时加载。 */
export async function lazySetupRequest(
  req: Request,
  deps: LocalRouteDeps
): Promise<Response | null> {
  if (!new URL(req.url).pathname.startsWith(SETUP_PATH_PREFIX)) return null;
  const { handleSetupRequest } = await import('./setup-routes');
  return handleSetupRequest(req, deps);
}
