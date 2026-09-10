import type { UserStore } from '../../auth/user-store';
import type { MeshIdentity } from '../types';
import { PeerHandshakeError } from '../types';
import { fanoutDataChannel } from './channel-fanout';
import { DataChannelLink, type DataChannelLinkOptions } from './data-channel-link';
import { handshakeDataChannel } from './dc-handshake';
import { type RtcSignaling, encodeCandidateSignal, encodeSdpSignal, isEmptyCandidate } from './ice';
import type { DtlsFingerprint, PeerConnectionLike } from './native';
import type { RtcDialProgress } from './rtc-dial-progress';
import {
  type IceCandidateTrace,
  type RtcLogContext,
  createIceCandidateTrace,
  rtcLog,
  rtcLogCandidate,
} from './rtc-log';
import {
  bindChannelDiagnostics,
  createRtcSignalApplier,
  createSignalingAttemptState,
  logCreatedChannel,
  remainingDeadlineMs,
  waitChannelOpen,
  waitDataChannel,
} from './rtc-peer-helpers';

export type BindPeerSignalingHooks = {
  ctx?: RtcLogContext;
  onSuperseded?: () => void;
  onEpoch?: (epoch: number) => void;
  onRemoteDescriptionApplied?: () => void;
};

export function bindPeerSignaling(
  pc: PeerConnectionLike,
  signaling: RtcSignaling,
  rtcSession: string,
  to: string,
  expect: 'offer' | 'answer',
  onLocalDescription: (
    pc: PeerConnectionLike,
    listener: (description: { sdp: string; type: string }) => void
  ) => () => void,
  epoch?: number,
  trace?: IceCandidateTrace,
  hooks?: BindPeerSignalingHooks
): () => void {
  const iceTrace = trace ?? createIceCandidateTrace();
  const state = createSignalingAttemptState(epoch);
  state.logFields = { ...hooks?.ctx, peer: to, epoch };
  state.onSuperseded = hooks?.onSuperseded;
  state.onEpoch = (next) => {
    state.logFields = { ...state.logFields, epoch: next };
    hooks?.onEpoch?.(next);
  };
  state.onRemoteDescriptionApplied = hooks?.onRemoteDescriptionApplied;
  const unsubLocalDescription = onLocalDescription(pc, ({ sdp, type }) => {
    rtcLog('signal send', { ...state.logFields, peer: to, kind: 'sdp', sdp_type: type });
    signaling.send({
      rtcSession,
      from: 'node',
      to,
      sdp: encodeSdpSignal({
        type,
        sdp,
        ...(state.epoch !== undefined ? { epoch: state.epoch } : {}),
      }),
    });
  });
  pc.onLocalCandidate((candidate, mid) => {
    if (isEmptyCandidate(candidate)) return;
    rtcLogCandidate('send', to, candidate, iceTrace);
    signaling.send({
      rtcSession,
      from: 'node',
      to,
      candidate: encodeCandidateSignal(candidate, mid, state.epoch),
    });
  });
  const apply = createRtcSignalApplier(pc, to, expect, state, iceTrace);
  try {
    const unsubSignaling = signaling.onMessage(apply);
    return () => {
      unsubSignaling();
      unsubLocalDescription();
    };
  } catch (err) {
    unsubLocalDescription();
    throw err;
  }
}

export async function runPeerHandshake(opts: {
  pc: PeerConnectionLike;
  peerNodeId: string;
  offerer: boolean;
  deadline: number;
  progress: RtcDialProgress;
  identity: MeshIdentity;
  userStore: UserStore;
  liveness: Omit<DataChannelLinkOptions, 'reassembler' | 'peer' | 'liveness'> | false;
  waitLocalFingerprint: (pc: PeerConnectionLike, timeoutMs: number) => Promise<DtlsFingerprint>;
}): Promise<{
  link: DataChannelLink;
  pc: PeerConnectionLike;
  peerNodeId: string;
  role: 'initiator' | 'acceptor';
}> {
  const { pc, peerNodeId, offerer, deadline, progress } = opts;
  const channelP = offerer
    ? Promise.resolve(logCreatedChannel(pc.createDataChannel('peer'), peerNodeId))
    : waitDataChannel(
        pc,
        remainingDeadlineMs(deadline, 'datachannel open timeout'),
        undefined,
        peerNodeId
      );
  const channel = fanoutDataChannel(await channelP, { peer: peerNodeId });
  bindChannelDiagnostics(channel, peerNodeId);
  await waitChannelOpen(channel, remainingDeadlineMs(deadline, 'datachannel open timeout'));
  progress.channelOpen = true;
  const localFp = await opts.waitLocalFingerprint(
    pc,
    remainingDeadlineMs(deadline, 'local DTLS fingerprint unavailable')
  );
  progress.handshakeStarted = true;
  const hs = await handshakeDataChannel({
    channel,
    pc,
    identity: opts.identity,
    userStore: opts.userStore,
    localFingerprint: localFp,
    timeoutMs: remainingDeadlineMs(deadline, 'peer handshake timeout'),
  });
  if (!channel.isOpen()) {
    throw new PeerHandshakeError('protocol', 'datachannel closed during handshake handoff');
  }
  const link = new DataChannelLink(channel, {
    peer: peerNodeId,
    ...(opts.liveness === false ? { liveness: false as const } : opts.liveness),
  });
  if (hs.peerNodeId !== peerNodeId.toLowerCase()) {
    throw new PeerHandshakeError('protocol', 'connected peer node_id mismatch');
  }
  return {
    link,
    pc,
    peerNodeId: hs.peerNodeId,
    role: offerer ? 'initiator' : 'acceptor',
  };
}
