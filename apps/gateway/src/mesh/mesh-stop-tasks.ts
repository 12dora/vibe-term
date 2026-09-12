import type { MeshHttpRuntime } from './mesh-http';
import type { PeerManager } from './peer-manager';
import { type RelayWiring, relayMultiAttachOf } from './relay-wiring';
import { stopMeshRtcProbes } from './rtc/stun-effective';
import type { UplinkPool } from './uplink-pool';

export function meshStopTasks(input: {
  wiring: RelayWiring;
  hubStop: () => Promise<void>;
  peerManager: PeerManager;
  uplink: UplinkPool;
  http: MeshHttpRuntime;
  stopRtc: () => Promise<void> | void;
  closeBulk: () => Promise<void> | void;
  unbindPortMap: () => void;
}): Array<[string, () => Promise<void> | void]> {
  return [
    ['peer', () => input.peerManager.stop()],
    ['relay-secondaries', () => relayMultiAttachOf(input.wiring)?.stop() ?? Promise.resolve()],
    ['uplink', () => input.uplink.stop()],
    ['hub', () => input.hubStop()],
    ['mesh http', () => input.http.stop()],
    ['rtc', () => input.stopRtc()],
    ['bulk', () => input.closeBulk()],
    ['portmap', () => input.unbindPortMap()],
  ];
}

export function meshStopTasksFor(
  d: {
    relay: RelayWiring;
    hub?: { stop(): Promise<void> } | null;
    rtc: { close(): Promise<void> | void };
    bulk: { close(): Promise<void> | void };
  },
  peerManager: PeerManager,
  uplink: UplinkPool,
  http: MeshHttpRuntime,
  unbindPortMap: () => void
): Array<[string, () => Promise<void> | void]> {
  return meshStopTasks({
    wiring: d.relay,
    hubStop: () => d.hub?.stop() ?? Promise.resolve(),
    peerManager,
    uplink,
    http,
    stopRtc: () => stopMeshRtcProbes(d.rtc.close.bind(d.rtc)),
    closeBulk: () => d.bulk.close(),
    unbindPortMap,
  });
}
