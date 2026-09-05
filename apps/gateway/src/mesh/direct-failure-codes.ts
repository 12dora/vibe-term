// 直连失败码：把 ws 拨号分类与 DataChannel 的自由文本原因收敛成前端能翻译的稳定码。
// 码是对外契约（`nodes.badge.failure.<code>`），改动必须连带改三语文案。

import type { DirectFailureCode, DirectFailureDcParams } from './peer-manager-types';
import type { WsDialFailureKind } from './peer-ws-race';
import { classifyRtcDialFailure } from './rtc/rtc-dial-breaker';

const WS_FAILURE_CODES: Record<WsDialFailureKind, DirectFailureCode> = {
  timeout: 'timeout',
  'open-timeout': 'timeout',
  refused: 'refused',
  unreachable: 'unreachable',
  reset: 'reset',
  protocol: 'handshake',
  tls: 'tls',
  revoked: 'revoked',
  untrusted: 'untrusted',
  aborted: 'aborted',
  other: 'other',
};

export function wsFailureCode(kind: WsDialFailureKind | null | undefined): DirectFailureCode {
  return kind ? WS_FAILURE_CODES[kind] : 'other';
}

/** `classifyRtcDialFailure` 的分类 → 稳定失败码；不认得的分类落到 `other`。 */
const DC_FAILURE_CODES: Record<string, DirectFailureCode> = {
  'signal-dropped': 'signal_dropped',
  'liveness-timeout': 'liveness_timeout',
  'missed-pong': 'liveness_timeout',
  timeout: 'dc_open_timeout',
  ice: 'ice_failed',
  abort: 'aborted',
  protocol: 'handshake',
  'channel-error': 'dc_closed',
  'channel-closed': 'dc_closed',
  'transport-lost': 'dc_closed',
  'signaling-state': 'signaling_state',
};

/** ICE 一个候选都没收到时的措辞在分类器里会落到 `ice`，这里先单独摘出来。 */
const NO_CANDIDATE_RE = /no (ice )?candidates?|candidates? exhausted/;

export function dcFailureCode(reason: string): DirectFailureCode {
  const lower = reason.toLowerCase();
  if (NO_CANDIDATE_RE.test(lower)) return 'no_candidates';
  return DC_FAILURE_CODES[classifyRtcDialFailure(reason)] ?? 'other';
}

/** DataChannel 未建立的原因：`text` 是原文（旧前端兜底），`code` 供前端翻译。 */
export type DcFailureDetail = {
  text: string;
  code: DirectFailureCode;
  params?: DirectFailureDcParams;
};

/**
 * `coolingUntil` 传了（哪怕是 `null`）就表示这轮压根没拨号——熔断把直连挡下了。
 * 不单独记一行，浮层里 DataChannel 那半边会整个消失，用户只会以为没试过。
 * 有截止时间才是冷却（`breaker_cooling` 需要 `{{until}}`），没有就是无限期暂停（`breaker_paused`）。
 */
export function dcFailureReason(
  _nodeId: string,
  dcError: unknown,
  opts: {
    directCapable: boolean | undefined;
    rtcAvailable: boolean;
    coolingUntil?: number | null;
  }
): DcFailureDetail | null {
  if (opts.directCapable === false) {
    return { text: 'direct_capable=false', code: 'not_direct_capable' };
  }
  if (!opts.rtcAvailable) return { text: 'datachannel unavailable', code: 'rtc_unavailable' };
  if (opts.coolingUntil != null) {
    return {
      text: 'dial breaker cooling',
      code: 'breaker_cooling',
      params: { until: opts.coolingUntil },
    };
  }
  if (opts.coolingUntil !== undefined) {
    return { text: 'dial breaker paused', code: 'breaker_paused' };
  }
  if (dcError == null) return null;
  const text = dcError instanceof Error ? dcError.message : String(dcError);
  return { text, code: dcFailureCode(text) };
}
