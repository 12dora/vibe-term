import type { LinkSession } from '@vibeterm/shared/link';
import { type PeerLinkPurpose, rejectPausedUserLink } from './node-pause';
import type { PeerManagerState } from './peer-manager-state';
import type { RouteDegradeCoordinator } from './route-degrade';
import { NodeUnreachableError } from './types';

export type PeerGetLinkHost = {
  state: PeerManagerState;
  routes: RouteDegradeCoordinator;
  maybeUpgrade: (nodeId: string, opts: { cooldown: boolean; userPath?: boolean }) => void;
  requireTrusted: (nodeId: string) => void;
  dialForeground: (nodeId: string) => Promise<LinkSession>;
  awaitEstablishedOrDial: (nodeId: string, inflight: Promise<LinkSession>) => Promise<LinkSession>;
};

export async function getPeerLink(
  host: PeerGetLinkHost,
  nodeId: string,
  opts?: { purpose?: PeerLinkPurpose }
): Promise<LinkSession> {
  rejectPausedUserLink(nodeId, opts?.purpose ?? 'user');
  if (host.state.stopped) throw new NodeUnreachableError(nodeId, 'peer manager stopped');
  host.requireTrusted(nodeId);
  const existing = host.state.live.get(nodeId);
  if (existing) {
    const switched = await host.routes.ensureLiveForMode(existing);
    if (switched) return switched;
    host.maybeUpgrade(nodeId, { cooldown: true, userPath: true });
    return existing.session;
  }
  const inflight = host.state.pending.get(nodeId);
  if (inflight) return host.awaitEstablishedOrDial(nodeId, inflight);
  const attempt = host.dialForeground(nodeId);
  host.state.pending.set(nodeId, attempt);
  void attempt
    .catch(() => undefined)
    .finally(() => {
      if (host.state.pending.get(nodeId) === attempt) host.state.pending.delete(nodeId);
    });
  try {
    const session = await host.awaitEstablishedOrDial(nodeId, attempt);
    if (host.state.live.has(nodeId) && host.state.pending.get(nodeId) === attempt) {
      host.state.pending.delete(nodeId);
    }
    return session;
  } catch (err) {
    const live = host.state.live.get(nodeId);
    if (live) return live.session;
    if (err instanceof NodeUnreachableError) throw err;
    throw new NodeUnreachableError(nodeId, err instanceof Error ? err.message : 'unreachable');
  }
}
