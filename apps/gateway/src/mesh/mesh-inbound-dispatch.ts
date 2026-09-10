import { type DispatchContext, requestDispatchContext, setMeshRequestContext } from './mesh-deps';

/**
 * peer 入站请求的可信上下文：via / uid / sid 一律以流入口验过的值为准，OPEN 里的伪造值不参与。
 * sid 会一路带到本机路由——`/api/mesh/connection`、`/api/rtc/authorize` 要拿它在会话注册表里
 * 定位这条浏览器连接。返回的对象同时写进 `requestDispatchContext`，两处必须是同一份。
 */
export function applyInboundDispatchContext(
  request: Request,
  ctx: DispatchContext
): DispatchContext {
  const trusted = requestDispatchContext.get(request);
  const via = trusted?.viaNodeId ?? ctx.viaNodeId;
  const uid = trusted?.uid ?? ctx.uid;
  const sid = trusted?.sid ?? ctx.sid ?? null;
  const renewedExpiresAt = trusted?.renewedExpiresAt ?? ctx.renewedExpiresAt;
  const extra = renewedExpiresAt !== undefined ? { renewedExpiresAt } : {};
  const dispatchContext: DispatchContext = {
    uid,
    viaNodeId: via,
    ...(sid ? { sid } : {}),
    ...extra,
  };
  setMeshRequestContext(request, { via, uid, auth: sid, clientIp: `peer:${via}`, ...extra });
  requestDispatchContext.set(request, dispatchContext);
  return dispatchContext;
}
