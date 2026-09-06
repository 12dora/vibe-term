// `/api/mesh-internal/tmux/*` 的授权闸：peer 标记只回答「是不是本用户的节点」，
// 「能不能碰这个窗格」由授权回答。缺授权与授权无效分开报，源节点据此决定重签还是升级。

import { json } from '../../api/http';
import { verifyPaneGrant } from './store';
import type { PaneGrantRef } from './types';

export type { PaneGrantRef };

export type PaneGrantVerifier = (input: {
  grant: PaneGrantRef | null;
  peerNodeId: string;
  deviceId: string;
  paneId: string;
}) => { ok: true } | { ok: false; code: 'PANE_GRANT_REQUIRED' | 'PANE_GRANT_INVALID' };

export function readPaneGrantRef(raw: unknown): PaneGrantRef | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { grantId, token } = raw as { grantId?: unknown; token?: unknown };
  if (typeof grantId !== 'string' || typeof token !== 'string') return null;
  if (!grantId || !token) return null;
  return { grantId, token };
}

export const defaultPaneGrantVerifier: PaneGrantVerifier = (input) => {
  if (!input.grant) return { ok: false, code: 'PANE_GRANT_REQUIRED' };
  const checked = verifyPaneGrant({
    grantId: input.grant.grantId,
    token: input.grant.token,
    peerNodeId: input.peerNodeId,
    deviceId: input.deviceId,
    paneId: input.paneId,
  });
  return checked.ok ? { ok: true } : { ok: false, code: checked.code };
};

/** 通过返回 null；未通过返回 403 响应（供路由直接 return）。 */
export function guardPaneGrant(
  input: {
    grant: PaneGrantRef | null;
    peerNodeId: string;
    deviceId: string;
    paneId: string;
  },
  verify: PaneGrantVerifier = defaultPaneGrantVerifier
): Response | null {
  const result = verify(input);
  if (result.ok) return null;
  return json({ error: result.code, code: result.code }, 403);
}
