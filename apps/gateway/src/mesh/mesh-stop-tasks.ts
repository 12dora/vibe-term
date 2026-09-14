import type { MeshHttpRuntime } from './mesh-http';
import type { PeerManager } from './peer-manager';
import { type RelayWiring, relayMultiAttachOf } from './relay-wiring';
import { stopMeshRtcProbes } from './rtc/stun-effective';
import { stopUplinkPathSampling } from './uplink-path-sampler';
import type { UplinkPool } from './uplink-pool';

export function meshStopTasks(input: {
  wiring: RelayWiring;
  peerManager: PeerManager;
  uplink: UplinkPool;
  http: MeshHttpRuntime;
  stopRtc: () => Promise<void> | void;
  closeBulk: () => Promise<void> | void;
  unbindPortMap: () => void;
}): Array<[string, () => Promise<void> | void]> {
  return [
    ['peer', () => input.peerManager.stop()],
    ['path-sample', () => stopUplinkPathSampling()],
    ['relay-secondaries', () => relayMultiAttachOf(input.wiring)?.stop() ?? Promise.resolve()],
    ['uplink', () => input.uplink.stop()],
    ['mesh http', () => input.http.stop()],
    ['rtc', () => input.stopRtc()],
    ['bulk', () => input.closeBulk()],
    ['portmap', () => input.unbindPortMap()],
  ];
}

export function meshStopTasksFor(
  d: {
    relay: RelayWiring;
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
    peerManager,
    uplink,
    http,
    stopRtc: () => stopMeshRtcProbes(d.rtc.close.bind(d.rtc)),
    closeBulk: () => d.bulk.close(),
    unbindPortMap,
  });
}
