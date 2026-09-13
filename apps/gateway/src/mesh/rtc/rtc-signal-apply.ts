import { isFakeIpv4 } from '../address-class';
import type { RtcSignalMessage } from '../mesh-deps';
import { decodeCandidateSignal, decodeSdpSignal, isEmptyCandidate } from './ice';
import type { PeerConnectionLike } from './native';
import { type IceCandidateTrace, type RtcLogContext, rtcLog, rtcLogCandidate } from './rtc-log';

export type QueuedRemoteCandidate = { candidate: string; mid: string; epoch?: number };

/** offer 落地前每个 attempt 最多排队的远端候选数：正常拨号十几条，超出即对端在灌。 */
export const RTC_PENDING_CANDIDATE_MAX = 64;

export type SignalingAttemptState = {
  epoch?: number;
  lastOfferEpoch?: number;
  answerApplied: boolean;
  remoteDescriptionApplied: boolean;
  pendingCandidates: QueuedRemoteCandidate[];
  pendingDropped: number;
  logFields?: RtcLogContext;
  onSuperseded?: (epoch?: number) => void;
  onEpoch?: (epoch: number) => void;
  onRemoteDescriptionApplied?: () => void;
  /** 已建成的 live PC：更高 epoch 的 offer 忽略，不 superseded、不退订残留 ICE。 */
  ignoreNewerOffers?: boolean;
};

function logSignal(
  event: string,
  fields: Record<string, unknown>,
  state: SignalingAttemptState
): void {
  rtcLog(event, { ...state.logFields, ...fields });
}

export function createSignalingAttemptState(
  epoch?: number,
  lastOfferEpoch?: number
): SignalingAttemptState {
  return {
    epoch,
    lastOfferEpoch: lastOfferEpoch ?? epoch,
    answerApplied: false,
    remoteDescriptionApplied: false,
    pendingCandidates: [],
    pendingDropped: 0,
  };
}

function rememberOfferEpoch(state: SignalingAttemptState, epoch: number | undefined): void {
  if (epoch === undefined) return;
  if (state.lastOfferEpoch !== undefined && epoch <= state.lastOfferEpoch) return;
  state.lastOfferEpoch = epoch;
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
  const epoch = classifyEpoch(
    decoded.epoch,
    state.epoch,
    false,
    expect === 'offer',
    state.lastOfferEpoch
  );
  if (epoch === 'superseded') {
    if (state.ignoreNewerOffers) {
      logSignal(
        'signal dropped',
        {
          peer,
          kind: 'sdp',
          cause: 'established',
          expected_epoch: state.epoch,
          received_epoch: decoded.epoch,
        },
        state
      );
      return 'dropped';
    }
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
    rememberOfferEpoch(state, decoded.epoch);
    state.onSuperseded?.(decoded.epoch);
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
  if (expect === 'offer' && decoded.epoch !== undefined) {
    rememberOfferEpoch(state, decoded.epoch);
    if (state.epoch === undefined) {
      state.epoch = decoded.epoch;
      state.onEpoch?.(decoded.epoch);
    }
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

/** ICE 候选里的 connection-address；198.18/15 fake-IP 在收发两侧都丢掉。 */
export function iceCandidateConnectionAddress(candidate: string): string | null {
  const trimmed = candidate.trim().replace(/^a=/i, '');
  const parts = trimmed.split(/\s+/);
  if (parts[0]?.toLowerCase().startsWith('candidate:') && parts[4]) return parts[4];
  return candidate.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/)?.[0] ?? null;
}

export function isFakeIpv4IceCandidate(candidate: string): boolean {
  const addr = iceCandidateConnectionAddress(candidate);
  return addr != null && isFakeIpv4(addr);
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
  if (isFakeIpv4IceCandidate(decoded.candidate)) {
    logSignal('signal dropped', { peer, kind: 'candidate', cause: 'fake-ip' }, state);
    return;
  }
  // offer 未到之前应答侧还不知道 epoch：先入队，等 offer 定下 epoch 再筛，别当成陈旧信令丢掉。
  const beforeOffer = state.epoch === undefined && !state.remoteDescriptionApplied;
  if (
    classifyEpoch(decoded.epoch, state.epoch, !beforeOffer, false, state.lastOfferEpoch) ===
    'mismatch'
  ) {
    logEpochMismatch(peer, 'candidate', state.epoch, decoded.epoch, state);
    return;
  }
  if (!state.remoteDescriptionApplied) {
    const queued = queuePendingCandidate(peer, state, {
      candidate: decoded.candidate,
      mid: decoded.mid,
      ...(decoded.epoch === undefined ? {} : { epoch: decoded.epoch }),
    });
    if (queued) rtcLogCandidate('recv', peer, decoded.candidate, trace);
    return;
  }
  rtcLogCandidate('recv', peer, decoded.candidate, trace);
  addRemoteCandidate(pc, peer, decoded.candidate, decoded.mid, state);
}

/** 排队上限 + 去重：对端可以在 offer 到达前灌任意多条候选，不能让 attempt 无界增长。 */
function queuePendingCandidate(
  peer: string,
  state: SignalingAttemptState,
  item: QueuedRemoteCandidate
): boolean {
  const duplicate = state.pendingCandidates.some(
    (row) => row.candidate === item.candidate && row.mid === item.mid && row.epoch === item.epoch
  );
  const full = state.pendingCandidates.length >= RTC_PENDING_CANDIDATE_MAX;
  if (!duplicate && !full) {
    state.pendingCandidates.push(item);
    return true;
  }
  state.pendingDropped += 1;
  if (state.pendingDropped === 1 || state.pendingDropped % RTC_PENDING_CANDIDATE_MAX === 0) {
    logSignal(
      'signal dropped',
      {
        peer,
        kind: 'candidate',
        cause: duplicate ? 'duplicate' : 'pending-overflow',
        dropped: state.pendingDropped,
      },
      state
    );
  }
  return false;
}

function markRemoteDescriptionApplied(
  pc: PeerConnectionLike,
  peer: string,
  state: SignalingAttemptState
): void {
  state.remoteDescriptionApplied = true;
  state.onRemoteDescriptionApplied?.();
  const queued = state.pendingCandidates.splice(0);
  for (const item of queued) {
    if (item.epoch !== undefined && state.epoch !== undefined && item.epoch !== state.epoch) {
      logEpochMismatch(peer, 'candidate', state.epoch, item.epoch, state);
      continue;
    }
    addRemoteCandidate(pc, peer, item.candidate, item.mid, state);
  }
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
  allowSupersede: boolean,
  lastOfferEpoch?: number
): 'ok' | 'mismatch' | 'superseded' {
  if (received === undefined) return 'ok';
  if (lastOfferEpoch !== undefined && received < lastOfferEpoch) return 'mismatch';
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
