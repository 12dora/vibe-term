import { guardBrowserRequest } from '../mesh/browser-request-guard';
import { guardEntryAccess } from './access-guard';

/**
 * 独立 gateway 入口（裸 dev gateway、managed 二进制）的 Bun `fetch` 外壳：运行时本身免登录，
 * 先过浏览器请求门（按免登录单机处理），再过 Access。装配版入口在 `createHttpDispatch` 里各自调用这两道门。
 */
export async function guardedGatewayFetch(
  req: Request,
  handle: (
    req: Request,
    bunServer: Bun.Server<unknown>
  ) => Response | Promise<Response | undefined> | undefined,
  bunServer: Bun.Server<unknown>,
  notFound: () => Response = () => new Response('Not Found', { status: 404 })
): Promise<Response> {
  const foreign = guardBrowserRequest(req, { openAccess: () => true });
  if (foreign) return foreign;
  const denied = await guardEntryAccess(req);
  if (denied) return denied;
  const response = await handle(req, bunServer);
  if (response !== undefined) return response;
  return notFound();
}
