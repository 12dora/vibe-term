import type { UserStore } from '../../auth/user-store';
import type { MeshIdentity } from '../types';
import { PeerHandshakeError } from '../types';
import { fanoutDataChannel } from './channel-fanout';
import { DataChannelLink, type DataChannelLinkOptions } from './data-channel-link';
import { attachHandshakeRecv, handshakeDataChannel } from './dc-handshake';
import { type RtcSignaling, encodeCandidateSignal, encodeSdpSignal, isEmptyCandidate } from './ice';
import type { DtlsFingerprint, IceServerConfig, PeerConnectionLike } from './native';
import {
  type RtcDialProgress,
  createRtcDialProgress,
  isRtcTimeoutFailure,
  isSupersededDcLoss,
  rtcFailureStage,
} from './rtc-dial-progress';
import {
  type IceCandidateTrace,
  type RtcLogContext,
  createIceCandidateTrace,
  rtcLog,
  rtcLogCandidate,
} from './rtc-log';
import {
  PEER_CHANNEL_LABEL,
  attachPcDiagnostics,
  bindChannelDiagnostics,
  createRtcSignalApplier,
  createSignalingAttemptState,
  logCreatedChannel,
  logRtcDialTimeout,
  raceWithAbort,
  remainingDeadlineMs,
  timeoutFailureMessage,
  waitChannelOpen,
  waitDataChannel,
} from './rtc-peer-helpers';
import { isFakeIpv4IceCandidate } from './rtc-signal-apply';

export type BindPeerSignalingHooks = {
  ctx?: RtcLogContext;
  lastOfferEpoch?: number;
  onSuperseded?: (epoch?: number) => void;
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
  const state = createSignalingAttemptState(epoch, hooks?.lastOfferEpoch);
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
    if (isFakeIpv4IceCandidate(candidate)) {
      rtcLog('signal dropped', {
        ...state.logFields,
        peer: to,
        kind: 'candidate',
        cause: 'fake-ip',
      });
      return;
    }
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
    ? Promise.resolve(logCreatedChannel(pc.createDataChannel(PEER_CHANNEL_LABEL), peerNodeId))
    : waitDataChannel(
        pc,
        remainingDeadlineMs(deadline, 'datachannel open timeout'),
        undefined,
        peerNodeId
      );
  const channel = fanoutDataChannel(await channelP, { peer: peerNodeId });
  bindChannelDiagnostics(channel, peerNodeId);
  const queue = attachHandshakeRecv(channel, pc, { peer: peerNodeId });
  try {
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
      queue,
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
  } catch (err) {
    queue.stop();
    throw err;
  }
}

export type PeerConnectAttemptHooks = {
  onLocalDescription: (
    pc: PeerConnectionLike,
    listener: (description: { sdp: string; type: string }) => void
  ) => () => void;
  waitLocalFingerprint: (pc: PeerConnectionLike, timeoutMs: number) => Promise<DtlsFingerprint>;
  rememberOfferEpoch: (epoch?: number) => void;
  noteSummary: (outcome: 'success' | 'failure', durationMs: number) => void;
  untrackAndClose: (pc: PeerConnectionLike) => void;
};

export async function runPeerConnectAttempt(opts: {
  pc: PeerConnectionLike;
  peerNodeId: string;
  signaling: RtcSignaling;
  rtcSession: string;
  peer: string;
  offerer: boolean;
  deadline: number;
  ctx: RtcLogContext;
  ice: IceServerConfig;
  epoch?: number;
  lastOfferEpoch?: number;
  signal?: AbortSignal;
  identity: MeshIdentity;
  userStore: UserStore;
  liveness: Omit<DataChannelLinkOptions, 'reassembler' | 'peer' | 'liveness'> | false;
  dialStartedAt: number;
  hooks: PeerConnectAttemptHooks;
}): Promise<{
  link: DataChannelLink;
  pc: PeerConnectionLike;
  peerNodeId: string;
  role: 'initiator' | 'acceptor';
}> {
  const { pc, peerNodeId, offerer, deadline, ctx, ice, hooks } = opts;
  const trace = createIceCandidateTrace();
  const progress = createRtcDialProgress();
  let unsubDiag = () => {};
  let unsubSignaling = () => {};
  let summaryNoted = false;
  let supersededSync = false;
  let rejectSuperseded: ((err: Error) => void) | null = null;
  const superseded = new Promise<never>((_, reject) => {
    rejectSuperseded = reject;
  });
  try {
    unsubDiag = attachPcDiagnostics(pc, peerNodeId, trace, { ice, progress, ctx });
    unsubSignaling = bindPeerSignaling(
      pc,
      opts.signaling,
      opts.rtcSession,
      opts.peer,
      offerer ? 'answer' : 'offer',
      hooks.onLocalDescription,
      opts.epoch,
      trace,
      {
        ctx,
        lastOfferEpoch: opts.lastOfferEpoch,
        onSuperseded: (nextEpoch) => {
          hooks.rememberOfferEpoch(nextEpoch);
          supersededSync = true;
          unsubSignaling();
          rejectSuperseded?.(new Error('superseded'));
        },
        onEpoch: (next) => {
          ctx.epoch = next;
          hooks.rememberOfferEpoch(next);
        },
        onRemoteDescriptionApplied: () => {
          progress.remoteDescriptionApplied = true;
        },
      }
    );
    if (supersededSync) unsubSignaling();
    const work = runPeerHandshake({
      pc,
      peerNodeId,
      offerer,
      deadline,
      progress,
      identity: opts.identity,
      userStore: opts.userStore,
      liveness: opts.liveness,
      waitLocalFingerprint: hooks.waitLocalFingerprint,
    });
    void work.catch(() => undefined);
    const result = await raceWithAbort(Promise.race([work, superseded]), opts.signal);
    hooks.noteSummary('success', performance.now() - opts.dialStartedAt);
    summaryNoted = true;
    result.link.onClose(() => {
      unsubSignaling();
      unsubDiag();
      hooks.untrackAndClose(pc);
    });
    return result;
  } catch (err) {
    if (!summaryNoted && !isSupersededDcLoss(err)) {
      hooks.noteSummary('failure', performance.now() - opts.dialStartedAt);
    }
    const reason = err instanceof Error ? err.message : String(err);
    if (isRtcTimeoutFailure(reason)) {
      logRtcDialTimeout(peerNodeId, pc, trace, progress, ice, reason);
    }
    unsubSignaling();
    unsubDiag();
    hooks.untrackAndClose(pc);
    if (isRtcTimeoutFailure(reason)) {
      throw withRtcDialFailureMeta(
        new PeerHandshakeError(
          'timeout',
          timeoutFailureMessage(progress, ice, trace.localCounts, reason)
        ),
        progress
      );
    }
    throw withRtcDialFailureMeta(err, progress);
  }
}

export function withRtcDialFailureMeta<T>(err: T, progress: RtcDialProgress): T {
  const meta = {
    stage: rtcFailureStage(progress),
    remoteSdpApplied: progress.remoteDescriptionApplied,
  };
  if (err && typeof err === 'object') return Object.assign(err, meta);
  return Object.assign(new Error(String(err)), meta) as T;
}
