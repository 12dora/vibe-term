import {
  type KeywordRule,
  classifyByKeywords,
  truncateReason,
} from '../../../../../packages/shared/src/net/classify-by-keywords';
import type { RtcFailureStage } from './rtc-dial-progress';

export type RtcDialFailureOpts = {
  peerInitiated?: boolean;
  stage?: RtcFailureStage;
  remoteSdpApplied?: boolean;
};

const RTC_FAILURE_STAGES: ReadonlySet<RtcFailureStage> = new Set([
  'gathering',
  'no-remote-sdp',
  'checking',
  'dtls',
  'handshake',
]);

const INTENTIONAL_DC_LOSS = new Set([
  'stopped',
  'revoked',
  'idle',
  'replaced',
  'stale',
  'not-trusted',
  'lower-priority',
  'simultaneous-dial',
  'superseded',
  'dc-declined',
  'dc-promote-reject',
  'route-measure-reject',
]);

const RTC_DIAL_FAILURE_RULES: ReadonlyArray<KeywordRule<string>> = [
  [['signal dropped'], 'signal-dropped'],
  [['liveness'], 'liveness-timeout'],
  [['missed-pong', 'missed pong'], 'missed-pong'],
  [['timeout', 'timed out'], 'timeout'],
  [['ice'], 'ice'],
  [['abort'], 'abort'],
  [['fingerprint', 'protocol', 'handshake', 'fragment'], 'protocol'],
  [['channel-error', 'datachannel error'], 'channel-error'],
  [['channel-closed', 'datachannel closed', 'channel closed'], 'channel-closed'],
  [['transport'], 'transport-lost'],
];

function isRtcFailureStage(value: unknown): value is RtcFailureStage {
  return typeof value === 'string' && RTC_FAILURE_STAGES.has(value as RtcFailureStage);
}

export function rtcDialFailureMetaOf(err: unknown): {
  reason: string;
  stage?: RtcFailureStage;
  remoteSdpApplied?: boolean;
} {
  const reason = err instanceof Error ? err.message : String(err);
  if (!err || typeof err !== 'object') return { reason };
  const rec = err as { stage?: unknown; remoteSdpApplied?: unknown };
  return {
    reason,
    stage: isRtcFailureStage(rec.stage) ? rec.stage : undefined,
    remoteSdpApplied: typeof rec.remoteSdpApplied === 'boolean' ? rec.remoteSdpApplied : undefined,
  };
}

/** 应答侧没等到远端 SDP 的 timeout 不算本端故障；SDP 已应用后的 dtls/handshake 超时照常计数。 */
export function isUncountedPeerInitiatedTimeout(
  classified: string,
  opts?: RtcDialFailureOpts
): boolean {
  if (opts?.peerInitiated !== true || classified !== 'timeout') return false;
  if (opts.remoteSdpApplied === true) return false;
  return (
    opts.remoteSdpApplied === false || opts.stage === 'gathering' || opts.stage === 'no-remote-sdp'
  );
}

export function isIntentionalDcLoss(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return INTENTIONAL_DC_LOSS.has(reason);
}

export function classifyRtcDialFailure(reason: string | null | undefined): string {
  if (!reason) return 'unknown';
  const lower = reason.toLowerCase();
  if (lower.includes('unexpected remote') && lower.includes('signaling state')) {
    return 'signaling-state';
  }
  return classifyByKeywords(lower, RTC_DIAL_FAILURE_RULES, (normalized) =>
    normalized === 'closed' ? 'channel-closed' : truncateReason(reason)
  );
}
