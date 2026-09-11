import { DialBreaker } from '@vibeterm/shared/net';

/** `/api/rtc/authorize` 5xx：30 s 起跳，封顶 5 min。跨控制器实例共享，避免切路由重开。 */
export const AUTHORIZE_BREAKER_BASE_MS = 30_000;
export const AUTHORIZE_BREAKER_MAX_MS = 5 * 60 * 1000;

const authorizeBreaker = new DialBreaker({
  breakerMs: AUTHORIZE_BREAKER_BASE_MS,
  maxMs: AUTHORIZE_BREAKER_MAX_MS,
  failLimit: 3,
});

export function authorizeBreakerShouldTry(nodeId: string, now?: number) {
  return authorizeBreaker.shouldTry(nodeId, now);
}

export function noteAuthorizeFailure(nodeId: string, now?: number) {
  return authorizeBreaker.noteFailure(nodeId, 'authorize-unavailable', undefined, now);
}

export function noteAuthorizeSuccess(nodeId: string): void {
  authorizeBreaker.reset(nodeId);
}

export function forceAuthorizeProbe(nodeId: string): void {
  authorizeBreaker.forceProbe(nodeId);
}

export function resetAuthorizeBreakerForTest(nodeId?: string): void {
  authorizeBreaker.reset(nodeId);
}
