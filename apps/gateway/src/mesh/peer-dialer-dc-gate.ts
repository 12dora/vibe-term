import type { LinkSession } from '@vibeterm/shared/link';
import { dcFailureReason as describeDcFailure } from './direct-failure-codes';
import { type DirectAttemptRecord, hasDirectFailure, noteDcOutcome } from './peer-direct-attempt';
import type { PeerManagerState } from './peer-manager-state';
import type { RtcPeerManager } from './rtc';
import { type RtcDialBreakerDecision, classifyRtcDialFailure } from './rtc/rtc-dial-breaker';
import { rtcLog } from './rtc/rtc-log';

export async function ensureRtcReady(rtc: RtcPeerManager): Promise<void> {
  if ((await rtc.ready?.()) === false) throw new Error('node-datachannel is not available');
}

export type DcDialGate = {
  allow: boolean;
  coolingUntil?: number | null;
};

/** 对端发起的拨号（应答 offer / 被 wake 叫醒）在冷却中仍放行；自发拨号维持熔断。 */
export function gateDcDial(input: {
  peer: string;
  capable: boolean;
  aboveDc: boolean;
  peerInitiated: boolean;
  decision: RtcDialBreakerDecision;
}): DcDialGate {
  if (!input.aboveDc || !input.capable) return { allow: false };
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
