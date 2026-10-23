import type { LinkSession } from '@vibeterm/shared/link';
import type { LivePeer } from './peer-reconnect-wake';

/**
 * 优化换链（reroll rehome、relay→dc 测量升格）的退役：
 * 有不可迁移 HTTP 体时走 replaced 排空，否则立刻 retired。两端共用，禁止分叉条件。
 */
export function retireOptimisationSwitch(
  live: LivePeer,
  finishRetire: (live: LivePeer, reason: string) => void
): boolean {
  if ((live.nonMigratable ?? 0) > 0) {
    live.pendingOptimisationRetire = true;
    return false;
  }
  live.pendingOptimisationRetire = false;
  finishRetire(live, 'retired');
  return true;
}

/** hold 升格后：仅 degraded 且换了 session 才走优化退役。 */
export function maybeRetireOptimisation(
  kind: string,
  prev: LivePeer | undefined,
  kept: LinkSession | null | undefined,
  finishRetire: (live: LivePeer, reason: string) => void
): void {
  if (kind !== 'degraded' || !prev || prev.session === kept) return;
  retireOptimisationSwitch(prev, finishRetire);
}

/** 不可迁移计数归零后立刻把剩下的可迁移流搬到更快链路上。 */
export function flushOptimisationRetire(
  live: LivePeer,
  finishRetire: (live: LivePeer, reason: string) => void
): void {
  if (!live.pendingOptimisationRetire) return;
  if ((live.nonMigratable ?? 0) > 0) return;
  live.pendingOptimisationRetire = false;
  if (!live.retiring || live.finishRetired || live.streams === 0) return;
  finishRetire(live, 'retired');
}
