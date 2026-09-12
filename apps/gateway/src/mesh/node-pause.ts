import { listPausedNodeIds, setNodeLocalPaused } from '../db/node-local-prefs';
import { NodeUnreachableError } from './types';

export type PeerLinkPurpose = 'user' | 'management';

const paused = new Set<string>();
let loaded = false;
let dropLink: ((nodeId: string) => void) | null = null;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    for (const id of listPausedNodeIds()) paused.add(id);
  } catch {
    // 未迁移或测试进程库没有这张表时，只靠内存 Set
  }
}

export function isNodePaused(nodeId: string): boolean {
  ensureLoaded();
  return paused.has(nodeId);
}

export function pausedNodeIds(): ReadonlySet<string> {
  ensureLoaded();
  return paused;
}

export function setNodePaused(nodeId: string, value: boolean): void {
  ensureLoaded();
  if (value) paused.add(nodeId);
  else paused.delete(nodeId);
  try {
    setNodeLocalPaused(nodeId, value);
  } catch {
    // 单测无表时只保留内存
  }
}

export function rejectPausedUserLink(nodeId: string, purpose: PeerLinkPurpose = 'user'): void {
  if (purpose !== 'management' && isNodePaused(nodeId)) {
    throw new NodeUnreachableError(nodeId, 'paused');
  }
}

export function bindPausedPeerDrop(fn: ((nodeId: string) => void) | null): void {
  dropLink = fn;
}

export function dropPausedPeerLink(nodeId: string): void {
  dropLink?.(nodeId);
}

export type PeerDialRetire = {
  dropParked(id: string, reason: string): void;
  dropPeer(id: string, reason: string): void;
  forceCloseRetiring(id: string, reason: string): void;
  deleteCachedPeer(id: string): void;
  deleteUpgradeGate(id: string): void;
  forgetRtcWake(id: string): void;
  cancelDcUpgradeRetry(id: string): void;
  lostDirect: { delete(id: string): boolean };
  lastDirectAttempt: { delete(id: string): boolean };
  upgrading: { delete(id: string): boolean };
  pending: { delete(id: string): boolean };
  liveWaiters: { delete(id: string): boolean };
  failTransportWaiters(id: string): void;
  resetEndpointBackoff(id: string): void;
  advertisedEndpointSet: { delete(id: string): boolean };
  resetDcBreaker(id: string): void;
};

type PeerManagerDialHost = {
  drain: {
    dropParked: PeerDialRetire['dropParked'];
    forceCloseRetiring: PeerDialRetire['forceCloseRetiring'];
  };
  registry: { dropPeer: PeerDialRetire['dropPeer'] };
  state: {
    userStore: { deletePeer(id: string): void };
    lostDirect: PeerDialRetire['lostDirect'];
    lastDirectAttempt: PeerDialRetire['lastDirectAttempt'];
    upgrading: PeerDialRetire['upgrading'];
    pending: PeerDialRetire['pending'];
    liveWaiters: PeerDialRetire['liveWaiters'];
    endpointBackoff: { resetNode(id: string): void };
    advertisedEndpointSet: PeerDialRetire['advertisedEndpointSet'];
  };
  dcUpgrade: { upgradeGate: { delete(id: string): void } };
  rtcWake: { forgetPeer(id: string): void };
  cancelDcUpgradeRetry: PeerDialRetire['cancelDcUpgradeRetry'];
  waiters: { failTransportWaiters: PeerDialRetire['failTransportWaiters'] };
  dcBreaker: { reset: PeerDialRetire['resetDcBreaker'] };
};

export function peerDialRetireOf(manager: object): PeerDialRetire {
  const p = manager as PeerManagerDialHost;
  return {
    dropParked: (id, reason) => p.drain.dropParked(id, reason),
    dropPeer: (id, reason) => p.registry.dropPeer(id, reason),
    forceCloseRetiring: (id, reason) => p.drain.forceCloseRetiring(id, reason),
    deleteCachedPeer: (id) => p.state.userStore.deletePeer(id),
    deleteUpgradeGate: (id) => p.dcUpgrade.upgradeGate.delete(id),
    forgetRtcWake: (id) => p.rtcWake.forgetPeer(id),
    cancelDcUpgradeRetry: (id) => p.cancelDcUpgradeRetry(id),
    lostDirect: p.state.lostDirect,
    lastDirectAttempt: p.state.lastDirectAttempt,
    upgrading: p.state.upgrading,
    pending: p.state.pending,
    liveWaiters: p.state.liveWaiters,
    failTransportWaiters: (id) => p.waiters.failTransportWaiters(id),
    resetEndpointBackoff: (id) => p.state.endpointBackoff.resetNode(id),
    advertisedEndpointSet: p.state.advertisedEndpointSet,
    resetDcBreaker: (id) => p.dcBreaker.reset(id),
  };
}

export function retirePeerDialState(
  r: PeerDialRetire,
  nodeId: string,
  reason: 'paused' | 'revoked'
): void {
  r.dropParked(nodeId, reason);
  // dropPeer 只把 revoked/stopped 当终态；pause 走 revoked 以免 promote/重拨。
  r.dropPeer(nodeId, reason === 'paused' ? 'revoked' : reason);
  r.forceCloseRetiring(nodeId, reason);
  if (reason === 'revoked') r.deleteCachedPeer(nodeId);
  r.deleteUpgradeGate(nodeId);
  r.forgetRtcWake(nodeId);
  r.cancelDcUpgradeRetry(nodeId);
  r.lostDirect.delete(nodeId);
  r.lastDirectAttempt.delete(nodeId);
  r.upgrading.delete(nodeId);
  r.liveWaiters.delete(nodeId);
  r.failTransportWaiters(nodeId);
  r.resetEndpointBackoff(nodeId);
  r.advertisedEndpointSet.delete(nodeId);
  if (reason === 'paused') {
    r.pending.delete(nodeId);
    r.resetDcBreaker(nodeId);
  }
}

export function resetNodePauseForTests(): void {
  paused.clear();
  loaded = true;
}

export function reloadNodePauseFromDbForTests(): void {
  paused.clear();
  loaded = false;
  ensureLoaded();
}
