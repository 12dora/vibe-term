import type { RtcSignalMessage } from '../mesh-deps';
import { decodeCandidateSignal, decodeSdpSignal, isEmptyCandidate } from './ice';
import type { PeerConnectionLike } from './native';
import { type IceCandidateTrace, type RtcLogContext, rtcLog, rtcLogCandidate } from './rtc-log';

export type QueuedRemoteCandidate = { candidate: string; mid: string };

export type SignalingAttemptState = {
  epoch?: number;
  answerApplied: boolean;
  remoteDescriptionApplied: boolean;
  pendingCandidates: QueuedRemoteCandidate[];
  logFields?: RtcLogContext;
  onSuperseded?: () => void;
  onEpoch?: (epoch: number) => void;
  onRemoteDescriptionApplied?: () => void;
};

function logSignal(
  event: string,
  fields: Record<string, unknown>,
  state: SignalingAttemptState
): void {
  rtcLog(event, { ...state.logFields, ...fields });
}

export function createSignalingAttemptState(epoch?: number): SignalingAttemptState {
  return {
    epoch,
    answerApplied: false,
    remoteDescriptionApplied: false,
    pendingCandidates: [],
  };
}

export function createRtcSignalApplier(
  pc: PeerConnectionLike,
  peer: string,
  expect: 'offer' | 'answer',
  state: SignalingAttemptState,
  trace: IceCandidateTrace
): (message: RtcSignalMessage) => void {
  return (message) => {
    if (message.sdp && applyRemoteSdp(pc, peer, expect, state, message.sdp) === 'superseded') {
      return;
    }
    if (message.candidate) applyRemoteCandidate(pc, peer, state, trace, message.candidate);
  };
}

export function applyRemoteSdp(
  pc: PeerConnectionLike,
  peer: string,
  expect: 'offer' | 'answer',
  state: SignalingAttemptState,
  raw: string
): 'applied' | 'dropped' | 'superseded' {
  const decoded = decodeSdpSignal(raw);
  if (!decoded) return 'dropped';
  if (decoded.type !== expect) {
    logSignal(
      'signal dropped',
      {
        peer,
        kind: 'sdp',
        cause: 'unexpected-type',
        expected: expect,
        received: decoded.type,
      },
      state
    );
    return 'dropped';
  }
  const epoch = classifyEpoch(decoded.epoch, state.epoch, false, expect === 'offer');
  if (epoch === 'superseded') {
    logSignal(
      'signal dropped',
      {
        peer,
        kind: 'sdp',
        cause: 'superseded',
        expected_epoch: state.epoch,
        received_epoch: decoded.epoch,
      },
      state
    );
    state.onSuperseded?.();
    return 'superseded';
  }
  if (epoch === 'mismatch') {
    logEpochMismatch(peer, 'sdp', state.epoch, decoded.epoch, state);
    return 'dropped';
  }
  if (expect === 'answer' && state.answerApplied) {
    logSignal('signal dropped', { peer, kind: 'sdp', cause: 'duplicate-answer' }, state);
    return 'dropped';
  }
  if (expect === 'offer' && state.epoch === undefined && decoded.epoch !== undefined) {
    state.epoch = decoded.epoch;
    state.onEpoch?.(decoded.epoch);
  }
  try {
    logSignal('signal recv', { peer, kind: 'sdp', sdp_type: decoded.type }, state);
    pc.setRemoteDescription(decoded.sdp, decoded.type);
    if (expect === 'answer') state.answerApplied = true;
    markRemoteDescriptionApplied(pc, peer, state);
    return 'applied';
  } catch (err) {
    logSignal(
      'signal dropped',
      {
        peer,
        kind: 'sdp',
        cause: err instanceof Error ? err.message : String(err),
        apply: 'setRemoteDescription',
      },
      state
    );
    return 'dropped';
  }
}

export function applyRemoteCandidate(
  pc: PeerConnectionLike,
  peer: string,
  state: SignalingAttemptState,
  trace: IceCandidateTrace,
  raw: string
): void {
  const decoded = decodeCandidateSignal(raw);
  if (!decoded || isEmptyCandidate(decoded.candidate)) return;
  if (classifyEpoch(decoded.epoch, state.epoch, true, false) === 'mismatch') {
    logEpochMismatch(peer, 'candidate', state.epoch, decoded.epoch, state);
    return;
  }
  rtcLogCandidate('recv', peer, decoded.candidate, trace);
  if (!state.remoteDescriptionApplied) {
    state.pendingCandidates.push({ candidate: decoded.candidate, mid: decoded.mid });
    return;
  }
  addRemoteCandidate(pc, peer, decoded.candidate, decoded.mid, state);
}

function markRemoteDescriptionApplied(
  pc: PeerConnectionLike,
  peer: string,
  state: SignalingAttemptState
): void {
  state.remoteDescriptionApplied = true;
  state.onRemoteDescriptionApplied?.();
  const queued = state.pendingCandidates.splice(0);
  for (const item of queued) addRemoteCandidate(pc, peer, item.candidate, item.mid, state);
}

function addRemoteCandidate(
  pc: PeerConnectionLike,
  peer: string,
  candidate: string,
  mid: string,
  state: SignalingAttemptState
): void {
  try {
    pc.addRemoteCandidate(candidate, mid);
  } catch (err) {
    logSignal(
      'signal dropped',
      {
        peer,
        kind: 'candidate',
        cause: err instanceof Error ? err.message : String(err),
      },
      state
    );
  }
}

function classifyEpoch(
  received: number | undefined,
  expected: number | undefined,
  rejectBeforeEpoch: boolean,
  allowSupersede: boolean
): 'ok' | 'mismatch' | 'superseded' {
  if (received === undefined) return 'ok';
  if (expected === undefined) return rejectBeforeEpoch ? 'mismatch' : 'ok';
  if (received === expected) return 'ok';
  if (allowSupersede && received > expected) return 'superseded';
  return 'mismatch';
}

function logEpochMismatch(
  peer: string,
  kind: 'sdp' | 'candidate',
  expected: number | undefined,
  received: number | undefined,
  state: SignalingAttemptState
): void {
  logSignal(
    'signal dropped',
    {
      peer,
      kind,
      cause: 'epoch-mismatch',
      expected_epoch: expected,
      received_epoch: received,
    },
    state
  );
}
