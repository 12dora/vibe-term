import type { LinkSession } from '@vibeterm/shared/link';
import { winningDialInitiator } from './peer-direct-attempt';
import { comparePeerTransport } from './peer-manager-state';
import type { LivePeer } from './peer-reconnect-wake';
import type { TrackIntercept } from './route-degrade';
import type { PeerTransportKind } from './types';

export type ExistingLiveDecision =
  | { kind: 'install' }
  | { kind: 'reject'; reason: string }
  | { kind: 'park' }
  | { kind: 'retire' };

export function existingLiveDecision(
  prev: LivePeer | undefined,
  session: LinkSession,
  transport: PeerTransportKind,
  initiatedBy: string,
  selfNodeId: string
): ExistingLiveDecision {
  if (!prev || prev.session === session) return { kind: 'install' };
  const rank = comparePeerTransport(transport, prev.transport);
  if (rank < 0) return { kind: 'reject', reason: 'lower-priority' };
  if (rank === 0) {
    const winner = winningDialInitiator(selfNodeId, prev.peerNodeId);
    if (initiatedBy !== winner && prev.initiatedBy === winner) {
      return { kind: 'reject', reason: 'simultaneous-dial' };
    }
  }
  if (!prev.quiesceCapable) return { kind: 'park' };
  return { kind: 'retire' };
}

export function consumeForcedSession(bypass: WeakSet<LinkSession>, session: LinkSession): boolean {
  if (!bypass.has(session)) return false;
  bypass.delete(session);
  return true;
}

export function applyExistingLive(
  existing: ExistingLiveDecision,
  prev: LivePeer | undefined,
  park: () => void,
  retire: () => void
): { reject: string } | { parked: LinkSession } | { next: true } {
  if (existing.kind === 'reject') return { reject: existing.reason };
  if (existing.kind === 'park' && prev) {
    park();
    return { parked: prev.session };
  }
  if (existing.kind === 'retire' && prev) retire();
  return { next: true };
}

export function earlyTrackResult(
  intercept: TrackIntercept | undefined,
  prev: LivePeer | undefined,
  close: (reason: string) => void
): { result: LinkSession | null } | null {
  if (!intercept || intercept.action === 'continue') return null;
  if (intercept.action === 'reject') close(intercept.reason);
  return { result: prev?.session ?? null };
}

export function bestRetiringPeer(
  rows: Iterable<LivePeer>,
  excluded?: LivePeer | null
): LivePeer | null {
  let best: LivePeer | null = null;
  for (const row of rows) {
    if (row === excluded || row.finishRetired) continue;
    if (!best || comparePeerTransport(row.transport, best.transport) > 0) best = row;
  }
  return best;
}

/** 升为 live 时清 RTT，按「尚未测到」处理，避免沿用 retiring 窗口里的旧样本。 */
export function preparePromotedPeer(best: LivePeer): void {
  best.retiring = false;
  best.retireReason = 'replaced';
  best.retiredAt = 0;
  best.retireTimer?.clear();
  best.retireTimer = null;
  best.gotQuiesceAck = false;
  best.gotPeerQuiesce = false;
  best.rttMs = null;
  best.pingSentAt = null;
  best.rttSpikeIgnored = false;
  best.rttSamples = 0;
  best.rttMinMs = undefined;
  best.lastEmittedRttMs = null;
  best.lastRttEmitAt = 0;
}
