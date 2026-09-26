import { adaptiveDeadlineMs, nestedDialBudgetsMs } from '@vibeterm/shared/net';
import type { PeerLinkProvider } from './mesh-deps';
import { lookupPeerRttMs } from './peer-manager-state';

/** 取链路的墙钟上限（LAN 缺省）；高 RTT 时按 nestedDialBudgetsMs 放大。 */
export const FORWARD_LINK_DEADLINE_MS = 5_000;
let forwardLinkDeadlineOverride = 0;

/** 测试用：缩短取链路的墙钟上限。`ms <= 0` 恢复自适应缺省。 */
export function setForwardLinkDeadlineMs(ms: number): void {
  forwardLinkDeadlineOverride = ms > 0 ? ms : 0;
}

export function deadlineRttMs(
  nodeId: string,
  rttMs?: number | null,
  peers?: PeerLinkProvider
): number {
  if (typeof rttMs === 'number' && Number.isFinite(rttMs)) return rttMs;
  return peers?.rttForNode?.(nodeId) ?? lookupPeerRttMs(nodeId);
}

export function forwardLinkDeadlineFor(
  nodeId: string,
  rttMs?: number | null,
  peers?: PeerLinkProvider
): number {
  if (forwardLinkDeadlineOverride > 0) return forwardLinkDeadlineOverride;
  return nestedDialBudgetsMs(deadlineRttMs(nodeId, rttMs, peers)).forwardMs;
}

/** `max(剩余取链预算, 自适应 forwardMs)`。冷拨号 leftover≈0 仍至少等这一档。 */
export function forwardResponseBudgetMs(
  leftoverMs: number,
  floorMs = FORWARD_LINK_DEADLINE_MS
): number {
  const leftover = Number.isFinite(leftoverMs) ? Math.max(0, leftoverMs) : 0;
  const floor = forwardLinkDeadlineOverride > 0 ? forwardLinkDeadlineOverride : floorMs;
  return Math.max(floor, leftover);
}

export function authorizedHttpDeadlineMs(
  nodeId: string,
  rttMs?: number | null,
  peers?: PeerLinkProvider
): number {
  return adaptiveDeadlineMs({
    rttMs: deadlineRttMs(nodeId, rttMs, peers),
    factor: 8,
    minMs: 10_000,
    maxMs: 30_000,
  });
}
