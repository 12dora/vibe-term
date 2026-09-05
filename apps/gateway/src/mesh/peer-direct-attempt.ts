import { wsFailureCode } from './direct-failure-codes';
import type { PeerEndpointBackoff } from './peer-endpoint-backoff';
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

export const RECENT_DC_FAILURE_MS = 10 * 60 * 1000;

/** 熔断器已记失败、或近 10 分钟有 DC 失败记录：前台竞速不再给 DC 独占的短预算。 */
export function dcRecentlyFailed(
  attempt: DirectAttemptRecord | undefined,
  now: number,
  breakerFailures: number
): boolean {
  if (breakerFailures > 0) return true;
  if (!attempt || attempt.dc == null) return false;
  return now - attempt.at < RECENT_DC_FAILURE_MS;
}

/** 可拨的地址；全在退避里就把「还要等多久」记进这次尝试，浮层才有话可说。 */
export function eligiblePeerEndpoints(
  backoff: PeerEndpointBackoff,
  nodeId: string,
  endpoints: string[],
  attempt: DirectAttemptRecord,
  now: number,
  bypassBackoff: boolean | undefined
): string[] {
  if (bypassBackoff) return endpoints;
  const eligible = endpoints.filter((url) => backoff.eligible(nodeId, url, now));
  if (eligible.length > 0) return eligible;
  const waitMs = backoff.minWaitMs(nodeId, endpoints, now);
  noteWsBackoff(attempt, endpoints, Math.max(0, Math.ceil(waitMs / 1000)));
  return [];
}
