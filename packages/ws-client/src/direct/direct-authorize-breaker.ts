import { DialBreaker, type DialBreakerDecision } from '@vibeterm/shared/net';

/** `/api/rtc/authorize` 5xx：30 s 起跳，封顶 5 min。跨控制器实例共享，避免切路由重开。 */
export const AUTHORIZE_BREAKER_BASE_MS = 30_000;
export const AUTHORIZE_BREAKER_MAX_MS = 5 * 60 * 1000;
/** 目标 node 答 `DIRECT_UNAVAILABLE`（给不出直连）：这段时间内只有用户显式重试才再问它。 */
export const DIRECT_UNAVAILABLE_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * `node-unreachable`：转发器打不通目标（mesh 链路），与这条 WS 是谁无关；
 * `direct-busy`：目标 node 这次没给出直连（`DIRECT_BUSY`），过会儿再试；
 * `authorize-unavailable`：其余 5xx。
 */
export type AuthorizeFailureKind = 'node-unreachable' | 'direct-busy' | 'authorize-unavailable';

const authorizeBreaker = new DialBreaker({
  breakerMs: AUTHORIZE_BREAKER_BASE_MS,
  maxMs: AUTHORIZE_BREAKER_MAX_MS,
  failLimit: 3,
});

const directUnavailableUntil = new Map<string, number>();
/** `DIRECT_BUSY` 的 `retryAfterMs`：最短间隔，强制探测也不越过。 */
const retryAfterUntil = new Map<string, number>();

/** 登录世代：登出 / 重新登录后 +1，旧 nodeId 冷却不得带到新会话。 */
let authGeneration = 0;

function breakerPeer(nodeId: string): string {
  return `${authGeneration}:${nodeId}`;
}

function activeUntil(map: Map<string, number>, peer: string, now: number): number | null {
  const until = map.get(peer);
  if (until === undefined) return null;
  if (until > now) return until;
  map.delete(peer);
  return null;
}

export function authorizeBreakerShouldTry(
  nodeId: string,
  now: number = Date.now()
): DialBreakerDecision {
  const peer = breakerPeer(nodeId);
  const decision = authorizeBreaker.shouldTry(peer, now);
  const blocked = Math.max(
    activeUntil(directUnavailableUntil, peer, now) ?? 0,
    activeUntil(retryAfterUntil, peer, now) ?? 0
  );
  if (!blocked) return decision;
  return {
    ...decision,
    allow: false,
    cooling: true,
    until: Math.max(blocked, decision.until ?? 0),
  };
}

export function noteAuthorizeFailure(
  nodeId: string,
  now?: number,
  kind: AuthorizeFailureKind = 'authorize-unavailable'
) {
  return authorizeBreaker.noteFailure(breakerPeer(nodeId), kind, undefined, now);
}

/** 目标 node 明确说给不出直连：整段停放，自动的强制探测不放行，只有 `clearDirectUnavailable` 能解。 */
export function noteDirectUnavailable(nodeId: string, now: number = Date.now()): number {
  const until = now + DIRECT_UNAVAILABLE_COOLDOWN_MS;
  directUnavailableUntil.set(breakerPeer(nodeId), until);
  return until;
}

/** 用户显式重试：撤掉 `DIRECT_UNAVAILABLE` 停放（熔断计数不动）。 */
export function clearDirectUnavailable(nodeId: string): void {
  directUnavailableUntil.delete(breakerPeer(nodeId));
}

/**
 * 目标 node 这次没给出直连：按普通失败计入熔断，另把 `retryAfterMs` 记成最短间隔
 * （封顶到熔断上限，防止一个离谱的值把直连按死）。返回最短间隔的到期时刻。
 */
export function noteDirectBusy(
  nodeId: string,
  now: number = Date.now(),
  retryAfterMs: number | null = null
): number | null {
  const peer = breakerPeer(nodeId);
  authorizeBreaker.noteFailure(peer, 'direct-busy', undefined, now);
  if (!retryAfterMs) return null;
  const until = now + Math.min(retryAfterMs, AUTHORIZE_BREAKER_MAX_MS);
  retryAfterUntil.set(peer, Math.max(until, retryAfterUntil.get(peer) ?? 0));
  return until;
}

/**
 * 最近一次失败是链路类（`NODE_UNREACHABLE` / `DIRECT_UNAVAILABLE`）：页面恢复、`online`
 * 这类「顺手再试一次」的信号不该绕过冷却——链路没变，结论也不会变。冷却到期后照常放行。
 */
export function authorizeProbeSuppressed(nodeId: string, now: number = Date.now()): boolean {
  const peer = breakerPeer(nodeId);
  if (activeUntil(directUnavailableUntil, peer, now) !== null) return true;
  return authorizeBreaker.snapshot(peer, now).lastFailureKind === 'node-unreachable';
}

export function noteAuthorizeSuccess(nodeId: string): void {
  const peer = breakerPeer(nodeId);
  authorizeBreaker.reset(peer);
  directUnavailableUntil.delete(peer);
  retryAfterUntil.delete(peer);
}

export function forceAuthorizeProbe(nodeId: string): void {
  authorizeBreaker.forceProbe(breakerPeer(nodeId));
}

/** 一次 authorize attempt 真正开始：消耗掉强制探测，冷却中只放行这一次。 */
export function beginAuthorizeAttempt(nodeId: string): void {
  authorizeBreaker.beginAttempt(breakerPeer(nodeId), '');
}

/** 登出 / 登录世代变化时清掉全部冷却。 */
export function resetDirectAuthorizeBreakers(): void {
  authGeneration += 1;
  authorizeBreaker.reset();
  directUnavailableUntil.clear();
  retryAfterUntil.clear();
}

export function resetAuthorizeBreakerForTest(nodeId?: string): void {
  if (nodeId) noteAuthorizeSuccess(nodeId);
  else resetDirectAuthorizeBreakers();
}
