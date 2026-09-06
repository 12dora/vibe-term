// 浏览器接口：在目标节点 Y 上签发 / 吊销窗格授权。
// 走常规节点会话鉴权——浏览器能看到 Y 的窗格，就已经登录过 Y。

import { json, readJsonObjectBody } from '../../api/http';
import { type ApiRoute, route } from '../../api/route';
import { getDeviceById } from '../../db';
import { readMeshPeerMarker } from '../../mesh/peer-request-marker';
import { isTmuxPaneId } from '../../tmux-client/snapshot-format';
import { deletePaneGrant, issuePaneGrant } from './store';

export const PANE_GRANT_ROUTE = '/api/agent/pane-grants';

const NODE_ID_RE = /^[0-9a-f]{32}$/;

/**
 * 授权绑到哪个源节点：请求经 mesh 转发过来时以 peer 标记为准（发起 RPC 的正是这台），
 * 请求体里的值只做一致性校验；浏览器直连签发时才信请求体。
 */
function resolveFromNodeId(
  req: Request,
  raw: unknown
): { ok: true; value: string } | { ok: false } {
  const peer = readMeshPeerMarker(req);
  const claimed = typeof raw === 'string' ? raw.trim() : '';
  if (peer) {
    if (claimed && claimed !== peer) return { ok: false };
    return { ok: true, value: peer };
  }
  if (!NODE_ID_RE.test(claimed)) return { ok: false };
  return { ok: true, value: claimed };
}

async function handleIssue(req: Request): Promise<Response> {
  const raw = await readJsonObjectBody(req);
  if (!raw) return json({ error: 'invalid_request' }, 400);
  const fromNodeId = resolveFromNodeId(req, raw.fromNodeId);
  const deviceId = typeof raw.deviceId === 'string' ? raw.deviceId.trim() : '';
  const paneId = typeof raw.paneId === 'string' ? raw.paneId : '';
  if (!fromNodeId.ok || !deviceId || !isTmuxPaneId(paneId)) {
    return json({ error: 'invalid_request' }, 400);
  }
  if (!getDeviceById(deviceId)) {
    return json({ error: 'device_not_found' }, 404);
  }
  return json(issuePaneGrant({ fromNodeId: fromNodeId.value, deviceId, paneId }), 201);
}

function handleRevoke(id: string): Response {
  if (!deletePaneGrant(id)) return json({ error: 'not_found' }, 404);
  return json({ ok: true });
}

export const paneGrantRoutes: ApiRoute[] = [
  route({ method: 'POST', path: PANE_GRANT_ROUTE, handler: (req) => handleIssue(req) }),
  route({
    method: 'DELETE',
    path: `${PANE_GRANT_ROUTE}/:id`,
    handler: (_req, params) => handleRevoke(params.id),
  }),
];
