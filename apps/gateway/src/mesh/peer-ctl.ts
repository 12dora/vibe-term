import type { RtcSignalMessage } from './mesh-deps';
import type { PeerManagerState } from './peer-manager-state';
import { RTC_PEER_INBOX_MAX_MESSAGES } from './peer-manager-state';
import { sendPeerCtlQuiet } from './peer-path-view';
import { parseOpenPayload } from './peer-protocol';
import type { LivePeer } from './peer-reconnect-wake';
import {
  type PeerUpgradeOpts,
  deliverRtcSignal,
  peerInitiatedRtcAttemptInput,
  shouldDropUnboundRtcSignal,
  shouldStartRtcAttempt,
} from './peer-rtc-wake';
import { isRtcWakeSdp } from './rtc/ice';
import { rtcLog } from './rtc/rtc-log';

export type PeerCtlHost = {
  identity: { nodeId: string };
  state: PeerManagerState;
  statusSync: {
    applyPeerStatus: (live: LivePeer, msg: Record<string, unknown>) => Promise<void>;
    serveKeyLog: (live: LivePeer, msg: Record<string, unknown>) => Promise<void>;
    applyKeyLogRes: (msg: Record<string, unknown>) => Promise<void>;
  };
  registry: { onPeerPong: (live: LivePeer) => void };
  drain: { handleLinkCtl: (live: LivePeer, t: string, msg: Record<string, unknown>) => void };
  dialer: {
    hasDcInflight: (nodeId: string) => boolean;
    dcCapable: (nodeId: string) => boolean;
  };
  reroll: { interceptRtc: (fromNodeId: string, msg: RtcSignalMessage) => boolean };
  dcUpgrade: { dcBreaker: { shouldAcceptAnswer: (nodeId: string) => boolean } };
  rtcListeners: Map<string, Set<(msg: RtcSignalMessage) => void>>;
  onBrowserSignal: ((msg: RtcSignalMessage, fromNodeId?: string) => void) | null;
  isTrusted: (nodeId: string) => boolean;
  maybeUpgrade: (nodeId: string, opts: PeerUpgradeOpts) => void;
  handleIncomingRtcWake: (fromNodeId: string, msg: RtcSignalMessage) => void;
};

function runCtlAsync(kind: string, peer: string, work: () => Promise<void>): void {
  void work().catch((err) => {
    rtcLog('ctl failed', {
      peer,
      kind,
      reason: err instanceof Error ? err.message : String(err),
    });
  });
}

function rtcSignalFromCtl(msg: Record<string, unknown>): RtcSignalMessage {
  return {
    rtcSession: typeof msg.rtcSession === 'string' ? msg.rtcSession : '',
    from: msg.from === 'browser' ? 'browser' : 'node',
    to: typeof msg.to === 'string' ? msg.to : '',
    sdp: typeof msg.sdp === 'string' ? msg.sdp : null,
    candidate: typeof msg.candidate === 'string' ? msg.candidate : null,
  };
}

function dispatchSyncPeerCtl(
  host: PeerCtlHost,
  live: LivePeer,
  t: string,
  msg: Record<string, unknown>
): void {
  if (t === 'ping') sendPeerCtlQuiet(live, { t: 'pong' });
  else if (t === 'pong') host.registry.onPeerPong(live);
  else if (t.startsWith('link.')) host.drain.handleLinkCtl(live, t, msg);
  else if (t === 'rtc.signal') {
    const signal = rtcSignalFromCtl(msg);
    if (signal.from === 'browser') host.onBrowserSignal?.(signal, live.peerNodeId);
    else receiveRtcSignal(host, live.peerNodeId, signal);
  }
}

export function handlePeerCtl(host: PeerCtlHost, live: LivePeer, bytes: Uint8Array): void {
  const msg = parseOpenPayload(bytes);
  if (!msg || typeof msg.t !== 'string') return;
  const t = msg.t;
  const asyncCtl = {
    'node.status': () => host.statusSync.applyPeerStatus(live, msg),
    'key.log.req': () => host.statusSync.serveKeyLog(live, msg),
    'key.log.res': () => host.statusSync.applyKeyLogRes(msg),
  } as const;
  const work = asyncCtl[t as keyof typeof asyncCtl];
  if (work) runCtlAsync(t, live.peerNodeId, work);
  else dispatchSyncPeerCtl(host, live, t, msg);
}

function pushRtcInbox(host: PeerCtlHost, fromNodeId: string, msg: RtcSignalMessage): boolean {
  const inbox = host.state.rtcInbox.get(fromNodeId) ?? [];
  if (inbox.length >= RTC_PEER_INBOX_MAX_MESSAGES) return false;
  inbox.push({ message: msg, receivedAt: host.state.scheduler.now() });
  host.state.rtcInbox.set(fromNodeId, inbox);
  return true;
}

function bufferOrStartRtcAttempt(
  host: PeerCtlHost,
  fromNodeId: string,
  msg: RtcSignalMessage
): void {
  const pending = host.state.pending.has(fromNodeId);
  const upgrading = host.state.upgrading.has(fromNodeId);
  const inflight = host.dialer.hasDcInflight(fromNodeId);
  if (
    shouldDropUnboundRtcSignal({
      selfNodeId: host.identity.nodeId,
      fromNodeId,
      message: msg,
      attemptExists: pending || upgrading || inflight || host.state.rtcInbox.has(fromNodeId),
    })
  )
    return;
  if (!pushRtcInbox(host, fromNodeId, msg)) return;
  const attempt = peerInitiatedRtcAttemptInput({
    dcCapable:
      host.dialer.dcCapable(fromNodeId) && host.dcUpgrade.dcBreaker.shouldAcceptAnswer(fromNodeId),
    dcInflight: inflight,
    upgrading,
    live: host.state.live.get(fromNodeId),
  });
  if (shouldStartRtcAttempt(attempt)) {
    host.maybeUpgrade(fromNodeId, { cooldown: false, userPath: true, peerInitiated: true });
  }
}

export function receiveRtcSignal(
  host: PeerCtlHost,
  fromNodeId: string,
  msg: RtcSignalMessage
): void {
  if (msg.from === 'browser') {
    host.onBrowserSignal?.(msg, fromNodeId);
    return;
  }
  if (!host.isTrusted(fromNodeId)) return;
  if (isRtcWakeSdp(msg.sdp)) {
    host.handleIncomingRtcWake(fromNodeId, msg);
    return;
  }
  if (host.reroll.interceptRtc(fromNodeId, msg)) return;
  const delivered = deliverRtcSignal(host.rtcListeners.get(fromNodeId), msg);
  if (delivered) return;
  bufferOrStartRtcAttempt(host, fromNodeId, msg);
}
