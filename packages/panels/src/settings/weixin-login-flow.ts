import type { WeixinAccountUser, WeixinLoginStatusResponse } from '@tmex/shared';

export const WEIXIN_LOGIN_POLL_INTERVAL_MS = 1500;

export type WeixinLoginPhase =
  | 'starting'
  | 'scanning'
  | 'awaitMessage'
  | 'binding'
  | 'expired'
  | 'error';

export type WeixinLoginClassification =
  | { kind: 'expired' }
  | { kind: 'error'; message: string }
  | { kind: 'confirmed' }
  | { kind: 'pending' };

export function classifyWeixinLoginStatus(
  data: WeixinLoginStatusResponse
): WeixinLoginClassification {
  if (data.status === 'expired') return { kind: 'expired' };
  if (data.status === 'error') return { kind: 'error', message: data.message ?? '' };
  if (data.loggedIn || data.status === 'confirmed') return { kind: 'confirmed' };
  return { kind: 'pending' };
}

/** userId → 扫码确认时刻的 lastInboundAt 快照（服务端时间，免客户端时钟漂移）。 */
export type WeixinUserBaseline = ReadonlyMap<string, string | null>;

export function buildUserBaseline(users: readonly WeixinAccountUser[]): WeixinUserBaseline {
  return new Map(users.map((u) => [u.userId, u.lastInboundAt]));
}

/** 新用户（首次绑定）或 lastInboundAt 变化（重新授权）＝扫码后的新消息。 */
export function findFreshUser(
  users: readonly WeixinAccountUser[],
  baseline: WeixinUserBaseline
): WeixinAccountUser | undefined {
  return users.find((u) => !baseline.has(u.userId) || u.lastInboundAt !== baseline.get(u.userId));
}

export interface WeixinLoginEndpoints {
  start: string;
  status: string;
  users: string;
  approve: (userId: string) => string;
}

export function weixinLoginEndpoints(accountId: string): WeixinLoginEndpoints {
  const base = `/api/settings/weixin/accounts/${accountId}`;
  return {
    start: `${base}/login/start`,
    status: `${base}/login/status`,
    users: `${base}/users`,
    approve: (userId) => `${base}/users/${encodeURIComponent(userId)}/approve`,
  };
}
