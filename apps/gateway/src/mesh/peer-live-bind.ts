import type { LinkSession, LinkStream } from '@vibeterm/shared/link';
import { type PeerInboundStreamHost, handlePeerInboundStream } from './peer-live-inbound';
import type { PeerManagerState } from './peer-manager-state';
import { parseEchoedSentAt } from './peer-manager-state';
import { parseOpenPayload } from './peer-protocol';
import type { LivePeer } from './peer-reconnect-wake';
import { claimSession, markSessionDead, readInstallMeta } from './session-binding';
import { classifyOpenPayload } from './stream-targets';
import type { PeerTransportKind } from './types';

export type LiveBindHost = {
  state: PeerManagerState;
  maxConcurrentStreams: number;
  inbound: PeerInboundStreamHost;
  handlePeerCtl: (live: LivePeer, bytes: Uint8Array) => void;
  onStreamOpened: (live: LivePeer, stream: LinkStream) => void;
  onPong: (live: LivePeer, echoedSentAt?: number) => void;
  onClosed: (live: LivePeer, reason: string) => void;
};

export function buildInstalledPeer(input: {
  session: LinkSession;
  peerNodeId: string;
  transport: PeerTransportKind;
  initiatedBy: string;
  gen: number;
  quiesceCapable: boolean;
  remoteAddress: string | null;
  dcAttemptId: string | null;
  rtcEpoch?: number;
  now: number;
  sendKey?: Uint8Array;
  recvKey?: Uint8Array;
  nextDcAttemptId: () => string;
}): LivePeer {
  const meta = readInstallMeta(input.session);
  const epoch = input.rtcEpoch ?? meta.rtcEpoch;
  const attempt = input.dcAttemptId ?? meta.dcAttemptId ?? null;
  return {
    session: input.session,
    peerNodeId: input.peerNodeId,
    transport: input.transport,
    initiatedBy: input.initiatedBy,
    generation: input.gen,
    streams: 0,
    lastStreamAt: input.now,
    idleTimer: null,
    pingTimer: null,
    missedPongs: 0,
    lastInboundFrameAt: input.session.lastFrameAt ?? input.now,
    retiring: false,
    retireReason: 'replaced',
    retiredAt: 0,
    zeroStreamsSince: 0,
    gotQuiesceAck: false,
    gotPeerQuiesce: false,
    retireTimer: null,
    finishRetired: false,
    lastAdvertisedStatusJson: '',
    unsubRtc: null,
    sendKey: input.sendKey,
    recvKey: input.recvKey,
    quiesceCapable: input.quiesceCapable || meta.quiesceCapable === true,
    helloReplied: false,
    probeSent: false,
    remoteAddress: input.remoteAddress ?? meta.remoteAddress ?? null,
    rttMs: null,
    pingSentAt: null,
    rttSpikeIgnored: false,
    lastRttEmitAt: 0,
    lastEmittedRttMs: null,
    linkSinceAt: input.now,
    dcAttemptId: input.transport === 'dc' ? (attempt ?? input.nextDcAttemptId()) : null,
    rttSamples: 0,
    rttMinMs: undefined,
    ...(input.transport === 'dc' && epoch !== undefined ? { rtcEpoch: epoch } : {}),
  };
}

export function attachLiveBinding(host: LiveBindHost, live: LivePeer): void {
  const { session } = live;
  const orig = session.openStream.bind(session);
  session.openStream = async (payload: Uint8Array) => {
    if (live.finishRetired) throw new Error('peer link replaced');
    if (live.streams >= host.maxConcurrentStreams) throw new Error('too-many-streams');
    const stream = await orig(payload);
    host.onStreamOpened(live, stream);
    return stream;
  };
  claimSession(session, {
    role: live.retiring ? 'retiring' : 'live',
    peerId: live.peerNodeId,
    owner: live,
    onStream: (stream) => acceptLiveStream(host, live, stream),
    onCtl: (bytes) => onLiveCtl(host, live, bytes),
  });
  void session.closed.then((info) => {
    host.onClosed(live, info?.reason ?? 'closed');
  });
}

function ownsLive(host: LiveBindHost, live: LivePeer): boolean {
  if (host.state.live.get(live.peerNodeId) === live) return true;
  return live.retiring && host.state.retiring.get(live.peerNodeId)?.has(live) === true;
}

function acceptLiveStream(host: LiveBindHost, live: LivePeer, stream: LinkStream): void {
  if (stream.dead) return;
  if (!ownsLive(host, live)) {
    stream.reset('stale-link');
    markSessionDead(live.session, live.peerNodeId);
    return;
  }
  const kind = classifyOpenPayload(stream.openPayload);
  if (kind === 'unknown' || kind === 'relay') {
    stream.reset('unknown-stream-type');
    return;
  }
  if (live.streams >= host.maxConcurrentStreams) {
    stream.reset('too-many-streams');
    return;
  }
  host.onStreamOpened(live, stream);
  handlePeerInboundStream(host.inbound, live.peerNodeId, stream);
}

function onLiveCtl(host: LiveBindHost, live: LivePeer, bytes: Uint8Array): void {
  if (!ownsLive(host, live)) return;
  if (takePong(host, live, bytes)) return;
  host.handlePeerCtl(live, bytes);
}

function takePong(host: LiveBindHost, live: LivePeer, bytes: Uint8Array): boolean {
  const msg = parseOpenPayload(bytes);
  if (!msg || msg.t !== 'pong') return false;
  host.onPong(live, parseEchoedSentAt(msg.sentAt));
  return true;
}
