import type { LinkSession } from '@vibeterm/shared/link';
import { dcFailureReason as describeDcFailure } from './direct-failure-codes';
import { dcDialAborted, settleAbandonedDcDial } from './peer-dial-race';
import { type DirectAttemptRecord, hasDirectFailure, noteDcOutcome } from './peer-direct-attempt';
import type { PeerManagerState } from './peer-manager-state';
import type { RtcPeerManager } from './rtc';
import {
  type DcOfferBlockReason,
  type RtcDialBreaker,
  type RtcDialBreakerDecision,
  classifyRtcDialFailure,
  inboundOfferBlockReason,
  isIntentionalDcLoss,
  rtcDialFailureMetaOf,
} from './rtc/rtc-dial-breaker';
import { rtcLog } from './rtc/rtc-log';
import {
  dcDeclineNoticeOf,
  declineBackoffUntil,
  encodeDcOfferDecline,
} from './rtc/rtc-offer-decline';

export async function ensureRtcReady(rtc: RtcPeerManager): Promise<void> {
  if ((await rtc.ready?.()) === false) throw new Error('node-datachannel is not available');
}

export type DcDialGate = {
  allow: boolean;
  coolingUntil?: number | null;
  decline?: DcOfferBlockReason;
};

export type InboundOfferPlan =
  | { action: 'accept' }
  | { action: 'decline'; reason: DcOfferBlockReason; sdp: string };

/** disabled / 冷却到顶：回 decline，调用方不建 answerer PC。其余低档冷却仍可应答。 */
export function planInboundOffer(decision: RtcDialBreakerDecision): InboundOfferPlan {
  const reason = inboundOfferBlockReason(decision);
  if (!reason) return { action: 'accept' };
  return {
    action: 'decline',
    reason,
    sdp: encodeDcOfferDecline(reason, { until: decision.until }),
  };
}

/** 对端发起的拨号在低档冷却中仍放行；disabled 或冷却到顶则拒绝，不建 PC。 */
export function gateDcDial(input: {
  peer: string;
  capable: boolean;
  aboveDc: boolean;
  peerInitiated: boolean;
  decision: RtcDialBreakerDecision;
}): DcDialGate {
  if (!input.aboveDc || !input.capable) return { allow: false };
  const declined = declinePeerOffer(input);
  if (declined) return declined;
  if (input.decision.allow) return { allow: true };
  if (input.peerInitiated) {
    rtcLog('answer while cooling', { peer: input.peer, level: input.decision.level });
    return { allow: true };
  }
  rtcLog('dial failed', {
    peer: input.peer,
    cause: 'breaker_cooling',
    until: input.decision.until,
  });
  return { allow: false, coolingUntil: input.decision.until };
}

function declinePeerOffer(input: {
  peer: string;
  peerInitiated: boolean;
  decision: RtcDialBreakerDecision;
}): DcDialGate | null {
  if (!input.peerInitiated) return null;
  if (input.decision.acceptInbound) return { allow: true };
  const reason = inboundOfferBlockReason(input.decision);
  if (!reason) return null;
  rtcLog('answer declined', {
    peer: input.peer,
    level: input.decision.level,
    disabled: input.decision.disabled,
    cause: reason,
  });
  return { allow: false, decline: reason, coolingUntil: input.decision.until };
}

export function finishDirectAttemptRecord(
  state: PeerManagerState,
  nodeId: string,
  attempt: DirectAttemptRecord,
  session: LinkSession | null,
  dcError: unknown,
  dcCoolingUntil: number | null | undefined,
  rtcAvailable: boolean
): void {
  const live = state.live.get(nodeId);
  if (session && live && live.transport !== 'relay') return;
  if (attempt.dc == null) {
    const failure = describeDcFailure(nodeId, dcError, {
      coolingUntil: dcCoolingUntil,
      directCapable: state.userStore.getPeer(nodeId)?.directCapable,
      rtcAvailable,
    });
    noteDcOutcome(attempt, failure?.text ?? null, failure?.code ?? null, failure?.params ?? null);
  }
  if (hasDirectFailure(attempt)) {
    state.lastDirectAttempt.set(nodeId, { ...attempt, at: state.scheduler.now() });
  }
}

export function classifyDialFailureKind(reason: string): string {
  return classifyRtcDialFailure(reason);
}

export function noteDialDcFailure(input: {
  stopped: boolean;
  nodeId: string;
  err: unknown;
  connectP: Promise<{ pc: { close(): void } }> | null;
  attemptId: string;
  peerInitiated: boolean;
  dcBreaker: Pick<RtcDialBreaker, 'noteFailure'> & {
    noteRemoteRefusal?: (peer: string, until: number | null) => void;
  };
}): string {
  const reason = input.err instanceof Error ? input.err.message : String(input.err);
  const note = (failure: unknown) => {
    if (!input.stopped) applyRemoteDecline(input, failure);
    const meta = rtcDialFailureMetaOf(failure);
    if (input.stopped || isIntentionalDcLoss(meta.reason)) return;
    input.dcBreaker.noteFailure(
      input.nodeId,
      classifyRtcDialFailure(meta.reason),
      input.attemptId,
      undefined,
      {
        peerInitiated: input.peerInitiated,
        stage: meta.stage,
        remoteSdpApplied: meta.remoteSdpApplied,
      }
    );
  };
  if (dcDialAborted(input.err)) {
    void settleAbandonedDcDial(input.connectP, (failure) => note(failure));
  } else {
    note(input.err);
  }
  return reason;
}

function applyRemoteDecline(
  input: {
    nodeId: string;
    dcBreaker: { noteRemoteRefusal?: (peer: string, until: number | null) => void };
  },
  failure: unknown
): void {
  const detail = dcDeclineNoticeOf(failure);
  if (!detail || !input.dcBreaker.noteRemoteRefusal) return;
  input.dcBreaker.noteRemoteRefusal(input.nodeId, declineBackoffUntil(detail, Date.now()));
}
