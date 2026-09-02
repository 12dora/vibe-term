import type { HubRuntime } from '../hub';
import type { UplinkPool } from './uplink-pool';

export function bindHubUplinkHooks(hub: HubRuntime | null, uplink: UplinkPool): void {
  if (!hub) return;
  hub.bindWriterBridge({
    appendAndAck: async (record) => {
      const attached = uplink.attachedHub();
      if (uplink.state !== 'online' || attached?.mode !== 'active') return null;
      try {
        return await uplink.appendAndAck(record);
      } catch {
        return null;
      }
    },
    requestCatchUp: () => {
      try {
        uplink.liveClient()?.requestCatchUpNow();
      } catch {
        /* offline */
      }
    },
    sendCtl: (msg) => {
      try {
        uplink.sendCtl(msg);
      } catch {
        /* offline */
      }
    },
    openStream: async (payload) => {
      const link = uplink.liveClient()?.link;
      if (!link || uplink.state !== 'online') throw new Error('uplink-offline');
      return link.openStream(payload);
    },
    isLive: () => uplink.state === 'online' && uplink.attachedHub()?.mode === 'active',
  });
  hub.peerPoller.setDiscoveryHooks({
    attachedHubId: () => uplink.attachedHub()?.hubNodeId ?? undefined,
    attachedEpoch: () => uplink.attachedHub()?.writerEpoch ?? 0,
    onWriterLearned: () => uplink.requestProbeNow(),
  });
  const refreshPeerCadence = () => {
    try {
      hub.peerPoller.refreshCadence();
    } catch {
      /* poller stopped */
    }
  };
  uplink.onAttached(() => {
    refreshPeerCadence();
  });
  uplink.onDetached(() => {
    refreshPeerCadence();
  });
  uplink.onStateChange((state) => {
    if (state === 'online') hub.onWriterUplinkOnline();
    else hub.onWriterUplinkOffline();
    refreshPeerCadence();
  });
}

export function kickHubPeerDiscovery(hub: HubRuntime | null, uplink: UplinkPool): void {
  hub?.peerPoller.scheduleImmediatePoll();
  uplink.requestProbeNow();
}
