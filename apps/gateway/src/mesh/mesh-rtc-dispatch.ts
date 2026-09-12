import type { RtcSignalMessage } from './mesh-deps';
import { type RelayWiring, relayMultiAttachOf } from './relay-wiring';
import type { UplinkCtlMessage, UplinkRtcSignal } from './uplink-protocol';

export function dispatchUplinkRtcSignal(
  d: {
    peerHolder: {
      manager?: { receiveRtcSignal(peer: string, signal: RtcSignalMessage): void } | null;
    };
    innerSignalsHolder: { router?: { deliverLocal(signal: RtcSignalMessage): void } | null };
    startBrowserAcceptHolder: { fn: (rtcSession: string) => void };
    signalListeners: Set<(signal: RtcSignalMessage) => void>;
  },
  identityNodeId: string,
  msg: UplinkRtcSignal,
  peerFromDcSession: (selfNodeId: string, rtcSession: string) => string | null
): void {
  const signal: RtcSignalMessage = {
    rtcSession: msg.rtcSession,
    from: msg.from,
    to: msg.to,
    sdp: msg.sdp,
    candidate: msg.candidate,
  };
  const dcPeer = peerFromDcSession(identityNodeId, msg.rtcSession);
  if (dcPeer) d.peerHolder.manager?.receiveRtcSignal(dcPeer, signal);
  if (signal.from === 'browser') {
    d.innerSignalsHolder.router?.deliverLocal(signal);
    d.startBrowserAcceptHolder.fn(signal.rtcSession);
  }
  for (const cb of d.signalListeners) {
    try {
      cb(signal);
    } catch {}
  }
}

export function sendRtcOverUplink(
  wiring: RelayWiring,
  uplink: { sendCtl(msg: UplinkCtlMessage): void },
  peerId: string,
  ctl: UplinkCtlMessage
): void {
  const attach = relayMultiAttachOf(wiring);
  if (
    attach?.sendRtc(
      peerId,
      () => uplink.sendCtl(ctl),
      (client) => client.sendCtl(ctl)
    )
  ) {
    return;
  }
  uplink.sendCtl(ctl);
}
