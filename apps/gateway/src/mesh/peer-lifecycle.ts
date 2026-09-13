import { bindPausedPeerDrop } from './node-pause';
import type { PeerManagerState } from './peer-manager-state';
import type { PeerServer } from './peer-server';

export type PeerLifecycleHost = {
  state: PeerManagerState;
  server: PeerServer | null;
  dialer: { syncLocalFingerprint: () => void };
  dcUpgrade: {
    startScan: (cb: () => void) => void;
    clearScan: () => void;
    dispose: () => void;
  };
  statusSync: { dispose: () => void };
  drain: {
    dropParked: (nodeId: string, reason: string) => void;
    forceCloseRetiring: (nodeId: string, reason: string) => void;
  };
  registry: { dropPeer: (nodeId: string, reason: string) => void };
  rtcWake: { dispose: () => void };
  routes: { dispose: () => void };
  rtcListeners: Map<string, Set<unknown>>;
  refreshAdvertisedStatus: () => void;
  notifyPeerEndpointsChanged: (nodeId?: string) => void;
};

export async function startPeerManager(host: PeerLifecycleHost): Promise<void> {
  await host.server?.start();
  host.dialer.syncLocalFingerprint();
  host.dcUpgrade.startScan(() => {
    host.dialer.syncLocalFingerprint();
    host.state.endpointBackoff.prune();
    host.refreshAdvertisedStatus();
    host.notifyPeerEndpointsChanged();
  });
}

function dropAllPeers(host: PeerLifecycleHost): void {
  for (const nodeId of [...host.state.parked.keys()]) {
    host.drain.dropParked(nodeId, 'stopped');
  }
  for (const peer of [...host.state.live.values()]) {
    host.registry.dropPeer(peer.peerNodeId, 'stopped');
  }
  for (const nodeId of [...host.state.retiring.keys()]) {
    host.drain.forceCloseRetiring(nodeId, 'stopped');
  }
}

function resolveTransportWaiters(host: PeerLifecycleHost): void {
  for (const [nodeId, waiters] of host.state.transportWaiters) {
    for (const waiter of waiters) waiter.resolve(false);
    host.state.transportWaiters.delete(nodeId);
  }
}

export async function stopPeerManager(host: PeerLifecycleHost): Promise<void> {
  bindPausedPeerDrop(null);
  if (host.state.stopped) return;
  host.state.stopped = true;
  host.state.generation += 1;
  host.state.stopAbort.abort();
  host.dcUpgrade.clearScan();
  host.statusSync.dispose();
  host.server?.stop();
  dropAllPeers(host);
  host.rtcListeners.clear();
  host.state.rtcInbox.clear();
  resolveTransportWaiters(host);
  host.state.liveWaiters.clear();
  host.state.upgrading.clear();
  host.rtcWake.dispose();
  host.state.lostDirect.clear();
  host.state.peerReconnectWake.reset();
  host.dcUpgrade.dispose();
  host.routes.dispose();
}
