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
