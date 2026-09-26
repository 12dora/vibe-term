// 「要不要对 node X 试直连」的唯一熔断：按 `登录世代:nodeId` 模块级共享，控制器实例被回收
// （路由离开超过宽限期）后再建也沿用同一份账。
//
// 失败按种类记账，每次 attempt 至多记一次（以 rtcSession 去重）：
//   * 拨号类（timeout / ice / channel / carrier / protocol / fingerprint / lookup …）与
//     authorize 的 5xx、`NODE_UNREACHABLE`：计次，连续 3 次进冷却，30 s 起逐档翻倍到 30 min；
//   * `direct-busy`（目标这次没给出）：计次，另把 `retryAfterMs` 记成最短间隔；
//   * `direct-unavailable`（目标给不出直连）：不计次，整段停放 10 min。
// 最短间隔与停放是**硬门**：强制探测（用户显式重试）越不过最短间隔，停放只有
// `clearDirectUnavailable` 能解。authorize 成功清掉两道硬门；计次只在通道保持 active
// ≥ 60 s 后清零。

import {
  DIAL_BREAKER_BASE_MS,
  DIAL_BREAKER_FAILS,
  DIAL_BREAKER_HEALTHY_MS,
  DIAL_BREAKER_MAX_MS,
  DialBreaker,
  type DialBreakerSnapshot,
} from '@vibeterm/shared/net';

export const DIRECT_BREAKER_BASE_MS = DIAL_BREAKER_BASE_MS;
export const DIRECT_BREAKER_MAX_MS = DIAL_BREAKER_MAX_MS;
export const DIRECT_BREAKER_FAILS = DIAL_BREAKER_FAILS;
export const DIRECT_BREAKER_HEALTHY_MS = DIAL_BREAKER_HEALTHY_MS;
/** 目标 node 答 `DIRECT_UNAVAILABLE`：这段时间内只有用户显式重试才再问它。 */
export const DIRECT_UNAVAILABLE_COOLDOWN_MS = 10 * 60 * 1000;

export const DIRECT_UNAVAILABLE_KIND = 'direct-unavailable';
export const DIRECT_BUSY_KIND = 'direct-busy';
export const NODE_UNREACHABLE_KIND = 'node-unreachable';
export const AUTHORIZE_UNAVAILABLE_KIND = 'authorize-unavailable';

export interface DirectBreakerGate {
  allow: boolean;
  /** 不放行时最早可以再试的时刻。 */
  until: number | null;
  /** 挡住它的是硬门（最短间隔 / 停放），强制探测也越不过。 */
  hard: boolean;
}

const breaker = new DialBreaker({
  breakerMs: DIRECT_BREAKER_BASE_MS,
  maxMs: DIRECT_BREAKER_MAX_MS,
  failLimit: DIRECT_BREAKER_FAILS,
  healthyMs: DIRECT_BREAKER_HEALTHY_MS,
});

const parkedUntil = new Map<string, number>();
const retryAfterUntil = new Map<string, number>();

/** 登录世代：登出 / 重新登录后 +1，旧 nodeId 冷却不得带到新会话。 */
let authGeneration = 0;

function peerOf(nodeId: string): string {
  return `${authGeneration}:${nodeId}`;
}

function activeUntil(map: Map<string, number>, peer: string, now: number): number | null {
  const until = map.get(peer);
  if (until === undefined) return null;
  if (until > now) return until;
  map.delete(peer);
  return null;
}

export function directBreakerGate(nodeId: string, now: number): DirectBreakerGate {
  const peer = peerOf(nodeId);
  const hardUntil = Math.max(
    activeUntil(parkedUntil, peer, now) ?? 0,
    activeUntil(retryAfterUntil, peer, now) ?? 0
  );
  const decision = breaker.shouldTry(peer, now);
  if (hardUntil > 0) {
    return { allow: false, until: Math.max(hardUntil, decision.until ?? 0), hard: true };
  }
  return { allow: decision.allow, until: decision.allow ? null : decision.until, hard: false };
}

/** 记一次失败。`attemptId` 相同的第二次调用不再计次。 */
export function noteDirectFailure(
  nodeId: string,
  kind: string,
  attemptId: string | undefined,
  now: number,
  retryAfterMs: number | null = null
): void {
  const peer = peerOf(nodeId);
  if (kind === DIRECT_UNAVAILABLE_KIND) {
    const until = now + DIRECT_UNAVAILABLE_COOLDOWN_MS;
    parkedUntil.set(peer, Math.max(until, parkedUntil.get(peer) ?? 0));
    return;
  }
  breaker.noteFailure(peer, kind, attemptId, now);
  if (kind !== DIRECT_BUSY_KIND || !retryAfterMs) return;
  const until = now + Math.min(retryAfterMs, DIRECT_BREAKER_MAX_MS);
  retryAfterUntil.set(peer, Math.max(until, retryAfterUntil.get(peer) ?? 0));
}

/** authorize 拿到了授权：目标此刻给得出直连，两道硬门作废。 */
export function noteDirectAuthorized(nodeId: string): void {
  const peer = peerOf(nodeId);
  parkedUntil.delete(peer);
  retryAfterUntil.delete(peer);
}

export function noteDirectEstablished(nodeId: string, attemptId: string, now: number): void {
  breaker.noteChannelEstablished(peerOf(nodeId), attemptId, now);
}

/** 通道保持 active 满 60 s：计次与冷却档位清零。 */
export function noteDirectHealthy(nodeId: string, now: number): boolean {
  return breaker.noteHealthy(peerOf(nodeId), now);
}

/** 用户显式重试：冷却中放行恰好一次（硬门不放行）。 */
export function forceDirectProbe(nodeId: string): void {
  breaker.forceProbe(peerOf(nodeId));
}

/** attempt 真正开始：消耗掉强制探测。 */
export function beginDirectAttempt(nodeId: string, attemptId: string): void {
  breaker.beginAttempt(peerOf(nodeId), attemptId);
}

/** 用户显式重试：撤掉 `DIRECT_UNAVAILABLE` 停放（计次不动）。 */
export function clearDirectUnavailable(nodeId: string): void {
  parkedUntil.delete(peerOf(nodeId));
}

export function directBreakerSnapshot(nodeId: string, now: number): DialBreakerSnapshot {
  const peer = peerOf(nodeId);
  const snapshot = breaker.snapshot(peer, now);
  const parked = activeUntil(parkedUntil, peer, now);
  const floor = activeUntil(retryAfterUntil, peer, now);
  const hardUntil = Math.max(parked ?? 0, floor ?? 0);
  if (!hardUntil) return snapshot;
  return {
    ...snapshot,
    cooling: true,
    until: Math.max(hardUntil, snapshot.until ?? 0),
    lastFailureKind: parked ? DIRECT_UNAVAILABLE_KIND : snapshot.lastFailureKind,
  };
}

/** 只清一台 node 的账（该 node 重新登录成功）。 */
export function resetDirectBreakerFor(nodeId: string): void {
  const peer = peerOf(nodeId);
  breaker.reset(peer);
  parkedUntil.delete(peer);
  retryAfterUntil.delete(peer);
}

/** 登出 / 登录世代变化：全部作废。 */
export function resetDirectBreakers(): void {
  authGeneration += 1;
  breaker.reset();
  parkedUntil.clear();
  retryAfterUntil.clear();
}
