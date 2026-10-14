import { RELAY_UPLINK_PATH, type RelayRuntime } from '../../../../apps/gateway/src/relay';
import type { GatewayRuntime } from '../../../../apps/gateway/src/runtime';

type RelayHttpResult = Response | null | undefined;

/** 上行链路升级成功时 relay 回 `undefined`：必须终止分发，不能再落到后面的处理器去回包。 */
export async function relayHttp(
  relay: RelayRuntime | null,
  req: Request,
  server: Bun.Server<unknown>
): Promise<RelayHttpResult> {
  if (!relay) return null;
  const resp = await relay.handleRequest(req, server);
  if (resp instanceof Response) return resp;
  return new URL(req.url).pathname === RELAY_UPLINK_PATH ? undefined : null;
}

/** 纯 relay 的网关面兜底：只放行 `GET /healthz`（升级健康检查与自检用），其余一律不进 gateway。 */
export async function relayOnlyGatewayHttp(
  gateway: GatewayRuntime,
  req: Request,
  server: Bun.Server<unknown>
): Promise<RelayHttpResult> {
  if (req.method !== 'GET' || new URL(req.url).pathname !== '/healthz') return null;
  const resp = await gateway.handleRequest(req, server);
  return resp instanceof Response ? resp : null;
}

export async function relayOnlyNotFound(): Promise<Response> {
  return new Response(JSON.stringify({ error: { code: 'RELAY_NO_FRONTEND' } }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });
}
