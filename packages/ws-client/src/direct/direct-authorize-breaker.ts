import { DialBreaker } from '@vibeterm/shared/net';

/** `/api/rtc/authorize` 5xx：30 s 起跳，封顶 5 min。跨控制器实例共享，避免切路由重开。 */
export const AUTHORIZE_BREAKER_BASE_MS = 30_000;
export const AUTHORIZE_BREAKER_MAX_MS = 5 * 60 * 1000;

const authorizeBreaker = new DialBreaker({
  breakerMs: AUTHORIZE_BREAKER_BASE_MS,
  maxMs: AUTHORIZE_BREAKER_MAX_MS,
  failLimit: 3,
});

/** 登录世代：登出 / 重新登录后 +1，旧 nodeId 冷却不得带到新会话。 */
let authGeneration = 0;

function breakerPeer(nodeId: string): string {
  return `${authGeneration}:${nodeId}`;
}

export function authorizeBreakerShouldTry(nodeId: string, now?: number) {
  return authorizeBreaker.shouldTry(breakerPeer(nodeId), now);
}

export function noteAuthorizeFailure(nodeId: string, now?: number) {
  return authorizeBreaker.noteFailure(breakerPeer(nodeId), 'authorize-unavailable', undefined, now);
}

export function noteAuthorizeSuccess(nodeId: string): void {
  authorizeBreaker.reset(breakerPeer(nodeId));
}

export function forceAuthorizeProbe(nodeId: string): void {
  authorizeBreaker.forceProbe(breakerPeer(nodeId));
}

/** 登出 / 登录世代变化时清掉全部冷却。 */
export function resetDirectAuthorizeBreakers(): void {
  authGeneration += 1;
  authorizeBreaker.reset();
}

export function resetAuthorizeBreakerForTest(nodeId?: string): void {
  if (nodeId) authorizeBreaker.reset(breakerPeer(nodeId));
  else resetDirectAuthorizeBreakers();
}
