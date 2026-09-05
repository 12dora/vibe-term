import { wsFailureCode } from './direct-failure-codes';
import type {
  DirectFailureCode,
  DirectFailureDcParams,
  DirectFailureView,
  DirectFailureWsParams,
} from './peer-manager-types';
import type { WsSecureRaceResult } from './peer-ws-race';

export function winningDialInitiator(selfNodeId: string, peerNodeId: string): string {
  return selfNodeId < peerNodeId ? selfNodeId : peerNodeId;
}

export type DirectAttemptRecord = {
  at: number;
  ws: string | null;
  wsCode: DirectFailureCode | null;
  wsParams: DirectFailureWsParams | null;
  dc: string | null;
  dcCode: DirectFailureCode | null;
  dcParams: DirectFailureDcParams | null;
  endpointsTried: string[];
};

export function emptyDirectAttempt(at: number): DirectAttemptRecord {
  return {
    at,
    ws: null,
    wsCode: null,
    wsParams: null,
    dc: null,
    dcCode: null,
    dcParams: null,
    endpointsTried: [],
  };
}

export function noteWsOutcome(
  attempt: DirectAttemptRecord,
  ws: string | null,
  endpointsTried: string[],
  code: DirectFailureCode | null = null,
  params: DirectFailureWsParams | null = null
): void {
  attempt.ws = ws;
  attempt.wsCode = ws == null ? null : code;
  attempt.wsParams = ws == null ? null : params;
  attempt.endpointsTried = endpointsTried;
}

/** 对端一个直连地址都没公布：不记就成了「什么都没试过」的静默洞。 */
export function noteNoEndpoints(attempt: DirectAttemptRecord): void {
  noteWsOutcome(attempt, 'no advertised endpoints', [], 'no_endpoints');
}

export function noteWsBackoff(
  attempt: DirectAttemptRecord,
  endpoints: string[],
  seconds: number
): void {
  const text = `all endpoints backing off (next eligible in ${seconds}s)`;
  noteWsOutcome(attempt, text, endpoints, 'backoff', { seconds });
}

export function noteWsRaceFailure(
  attempt: DirectAttemptRecord,
  raced: WsSecureRaceResult,
  endpoints: string[]
): void {
  if (!raced.lastReason) return;
  const params = raced.lastUrl ? { url: raced.lastUrl } : null;
  noteWsOutcome(attempt, raced.lastReason, endpoints, wsFailureCode(raced.lastKind), params);
}

export function noteDcOutcome(
  attempt: DirectAttemptRecord,
  dc: string | null,
  code: DirectFailureCode | null = null,
  params: DirectFailureDcParams | null = null
): void {
  attempt.dc = dc;
  attempt.dcCode = dc == null ? null : code;
  attempt.dcParams = dc == null ? null : params;
}

export function hasDirectFailure(attempt: DirectAttemptRecord): boolean {
  return attempt.ws != null || attempt.dc != null;
}

export function clearedDirectAttempt(prev: DirectAttemptRecord): DirectAttemptRecord {
  return {
    at: prev.at,
    ws: null,
    wsCode: null,
    wsParams: null,
    dc: null,
    dcCode: null,
    dcParams: null,
    endpointsTried: prev.endpointsTried,
  };
}

export function directFailureView(
  attempt: DirectAttemptRecord | undefined
): DirectFailureView | null {
  if (!attempt || !hasDirectFailure(attempt)) return null;
  return {
    at: attempt.at,
    ws: attempt.ws,
    wsCode: attempt.wsCode,
    wsParams: attempt.wsParams,
    dc: attempt.dc,
    dcCode: attempt.dcCode,
    dcParams: attempt.dcParams,
  };
}
