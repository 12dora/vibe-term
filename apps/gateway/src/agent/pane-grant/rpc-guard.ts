// `/api/mesh-internal/tmux/*` 的授权闸：peer 标记只回答「是不是本用户的节点」，
// 「能不能碰这个窗格」由授权回答。缺授权与授权无效分开报，源节点据此决定重签还是升级。
//
// 两段式：连 tmux 之前先验绑定（未获授权的对端不该把目标的 tmux 拉起来），
// 拿到运行时之后再比对 server 世代——tmux 重启后窗格号会重号，只有世代能区分新旧窗格。

import { json } from '../../api/http';
import { deletePaneGrant, verifyPaneGrant } from './store';
import type { PaneGrantRef } from './types';

export type { PaneGrantRef };

export type PaneGrantVerdict =
  | { ok: true; grantId: string | null; serverEpoch: string | null }
  | { ok: false; code: 'PANE_GRANT_REQUIRED' | 'PANE_GRANT_INVALID' };

export type PaneGrantVerifier = (input: {
  grant: PaneGrantRef | null;
  peerNodeId: string;
  deviceId: string;
  paneId: string;
}) => PaneGrantVerdict;

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
  if (!checked.ok) return { ok: false, code: checked.code };
  return { ok: true, grantId: checked.grant.id, serverEpoch: checked.grant.serverEpoch };
};

export function paneGrantDenied(code: 'PANE_GRANT_REQUIRED' | 'PANE_GRANT_INVALID'): Response {
  return json({ error: code, code }, 403);
}

/** 第一段：绑定校验。通过返回结论，未通过返回 403 响应（供路由直接 return）。 */
export function guardPaneGrant(
  input: {
    grant: PaneGrantRef | null;
    peerNodeId: string;
    deviceId: string;
    paneId: string;
  },
  verify: PaneGrantVerifier = defaultPaneGrantVerifier
):
  | { ok: true; grantId: string | null; serverEpoch: string | null }
  | { ok: false; denied: Response } {
  const result = verify(input);
  if (result.ok) return result;
  return { ok: false, denied: paneGrantDenied(result.code) };
}

/** 由第二段抛出：世代对不上说明窗格号已被新 tmux server 重用，授权当场作废。 */
export class PaneGenerationError extends Error {
  constructor() {
    super('PANE_GRANT_INVALID');
    this.name = 'PaneGenerationError';
  }
}

export function toServerEpochHex(epoch: Uint8Array | null | undefined): string | null {
  if (!epoch || epoch.byteLength === 0) return null;
  return Array.from(epoch, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * 第二段：拿到目标运行时之后比对 server 世代。不一致即删授权——重签才能拿到新世代的那张。
 */
export function assertPaneGeneration(
  granted: { grantId: string | null; serverEpoch: string | null },
  live: string | null
): void {
  if (granted.serverEpoch === live) return;
  if (granted.grantId) deletePaneGrant(granted.grantId);
  throw new PaneGenerationError();
}
