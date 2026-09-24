import { DialBreaker, type DialBreakerDecision } from '@vibeterm/shared/net';

/** `/api/rtc/authorize` 5xx：30 s 起跳，封顶 5 min。跨控制器实例共享，避免切路由重开。 */
export const AUTHORIZE_BREAKER_BASE_MS = 30_000;
export const AUTHORIZE_BREAKER_MAX_MS = 5 * 60 * 1000;
/** 目标 node 答 `DIRECT_UNAVAILABLE`：这段时间内不再问它。 */
export const DIRECT_UNAVAILABLE_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * `node-unreachable`：转发器打不通目标（mesh 链路），与这条 WS 是谁无关；
 * `authorize-unavailable`：其余 5xx。
 */
export type AuthorizeFailureKind = 'node-unreachable' | 'authorize-unavailable';

const authorizeBreaker = new DialBreaker({
  breakerMs: AUTHORIZE_BREAKER_BASE_MS,
  maxMs: AUTHORIZE_BREAKER_MAX_MS,
  failLimit: 3,
});

const directUnavailableUntil = new Map<string, number>();

/** 登录世代：登出 / 重新登录后 +1，旧 nodeId 冷却不得带到新会话。 */
let authGeneration = 0;

function breakerPeer(nodeId: string): string {
  return `${authGeneration}:${nodeId}`;
}

function directUnavailableBlock(peer: string, now: number): number | null {
  const until = directUnavailableUntil.get(peer);
  if (until === undefined) return null;
  if (until > now) return until;
  directUnavailableUntil.delete(peer);
  return null;
}

export function authorizeBreakerShouldTry(nodeId: string, now?: number): DialBreakerDecision {
  const peer = breakerPeer(nodeId);
  const decision = authorizeBreaker.shouldTry(peer, now);
  const blocked = directUnavailableBlock(peer, now ?? Date.now());
  if (blocked === null) return decision;
  return { ...decision, allow: false, cooling: true, until: blocked };
}

export function noteAuthorizeFailure(
  nodeId: string,
  now?: number,
  kind: AuthorizeFailureKind = 'authorize-unavailable'
) {
  return authorizeBreaker.noteFailure(breakerPeer(nodeId), kind, undefined, now);
}

/** 目标 node 明确说眼下给不出直连：整段冷却，强制探测也不放行。 */
export function noteDirectUnavailable(nodeId: string, now: number = Date.now()): number {
  const until = now + DIRECT_UNAVAILABLE_COOLDOWN_MS;
  directUnavailableUntil.set(breakerPeer(nodeId), until);
  return until;
}

/**
 * 最近一次失败是链路类（`NODE_UNREACHABLE` / `DIRECT_UNAVAILABLE`）：页面恢复、`online`
 * 这类「顺手再试一次」的信号不该绕过冷却——链路没变，结论也不会变。冷却到期后照常放行。
 */
export function authorizeProbeSuppressed(nodeId: string, now: number = Date.now()): boolean {
  const peer = breakerPeer(nodeId);
  if (directUnavailableBlock(peer, now) !== null) return true;
  return authorizeBreaker.snapshot(peer, now).lastFailureKind === 'node-unreachable';
}

export function noteAuthorizeSuccess(nodeId: string): void {
  const peer = breakerPeer(nodeId);
  authorizeBreaker.reset(peer);
  directUnavailableUntil.delete(peer);
}

export function forceAuthorizeProbe(nodeId: string): void {
  authorizeBreaker.forceProbe(breakerPeer(nodeId));
}

/** 登出 / 登录世代变化时清掉全部冷却。 */
export function resetDirectAuthorizeBreakers(): void {
  authGeneration += 1;
  authorizeBreaker.reset();
  directUnavailableUntil.clear();
}

export function resetAuthorizeBreakerForTest(nodeId?: string): void {
  if (nodeId) noteAuthorizeSuccess(nodeId);
  else resetDirectAuthorizeBreakers();
}
