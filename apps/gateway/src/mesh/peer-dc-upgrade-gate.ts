import { dcFailureCode } from './direct-failure-codes';
import type { DirectFailureCode } from './peer-manager-types';
import type { RtcDialBreaker } from './rtc/rtc-dial-breaker';

/** 重试也打不穿的 DC 失败：扫描再拨只是噪音。 */
const PERMANENT_DC_FAILURE_CODES: ReadonlySet<DirectFailureCode> = new Set([
  'no_srflx',
  'no_candidates',
  'stun_unconfigured',
  'not_direct_capable',
  'rtc_unavailable',
]);

export function isPermanentDcFailureCode(code: DirectFailureCode): boolean {
  return PERMANENT_DC_FAILURE_CODES.has(code);
}

/** 熔断 disabled 或永久失败码：后台升级扫描不再拨 DC，直到 breaker rearm。 */
export function isBackgroundDcUpgradeBlocked(breaker: RtcDialBreaker, nodeId: string): boolean {
  if (breaker.isDisabled(nodeId)) return true;
  const kind = breaker.snapshot(nodeId).lastFailureKind;
  if (!kind) return false;
  return isPermanentDcFailureCode(dcFailureCode(kind));
}
