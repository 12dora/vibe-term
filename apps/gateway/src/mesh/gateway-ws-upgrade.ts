import type { ShareScope } from '@tmex/shared/share';
import {
  MESH_GATEWAY_WS_KIND,
  MESH_REJECT_4401_KIND,
  MESH_SHARE_WS_KIND,
  MESH_VIA_SELF,
  type MeshUpgradeServer,
  X_TMEX_CONNECTION,
} from './mesh-deps';
import { jsonError } from './session-middleware';
import { type ShareWsClose, resolveShareWsAuth } from './share-credential';

export function isGatewayWsPath(path: string, nodeId: string): boolean {
  return path === '/ws' || path === '/n/self/ws' || path === `/n/${nodeId}/ws`;
}

export function connectionIdOf(req: Request): string {
  return (
    new URL(req.url).searchParams.get('cid')?.trim() ||
    req.headers.get(X_TMEX_CONNECTION)?.trim() ||
    ''
  );
}

export function upgradeSessionSocket(
  req: Request,
  server: MeshUpgradeServer,
  auth: { sid: string; uid: string }
): Response | undefined {
  const cid = connectionIdOf(req);
  const upgraded = server.upgrade(req, {
    data: {
      kind: MESH_GATEWAY_WS_KIND,
      sid: auth.sid,
      uid: auth.uid,
      via: MESH_VIA_SELF,
      ...(cid ? { cid } : {}),
    },
  });
  return upgraded ? undefined : jsonError('upgrade_failed', 500);
}

/** 分享页握手：凭证必须绑定 URL 里的 shareId，不匹配即 4401（分享已结束回 4410）。 */
export function upgradeBoundShareSocket(
  req: Request,
  server: MeshUpgradeServer,
  token: string | null,
  shareId: string,
  now: number
): Response | undefined {
  const bound = resolveShareWsAuth(token, shareId, now);
  if (!bound.ok) return rejectGatewayWs(req, server, bound.close);
  return upgradeShareSocket(req, server, bound.token, bound.verified, now);
}

export function upgradeShareSocket(
  req: Request,
  server: MeshUpgradeServer,
  token: string,
  verified: { scope: ShareScope; accessId: string },
  now: number
): Response | undefined {
  const cid = connectionIdOf(req);
  const upgraded = server.upgrade(req, {
    data: {
      kind: MESH_SHARE_WS_KIND,
      scope: verified.scope,
      accessId: verified.accessId,
      shareToken: token,
      shareVerifiedAt: now,
      via: MESH_VIA_SELF,
      ...(cid ? { cid } : {}),
    },
  });
  return upgraded ? undefined : jsonError('upgrade_failed', 500);
}

export function rejectGatewayWs(
  req: Request,
  server: MeshUpgradeServer,
  close: ShareWsClose | null
): Response | undefined {
  const upgraded = server.upgrade(req, {
    data: {
      kind: MESH_REJECT_4401_KIND,
      via: MESH_VIA_SELF,
      ...(close ? { closeCode: close.code, closeReason: close.reason } : {}),
    },
  });
  return upgraded ? undefined : jsonError('UNAUTHORIZED', 401);
}
