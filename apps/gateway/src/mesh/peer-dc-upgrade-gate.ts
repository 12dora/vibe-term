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

/** 永久失败码抑制后台升级的时长；到期允许一次探测，新的永久失败再武装。 */
export const PERMANENT_FAILURE_HOLD_MS = 60 * 60 * 1000;

type PermanentHold = {
  code: DirectFailureCode;
  failures: number;
  since: number;
  probeReleased: boolean;
};

const holdsByBreaker = new WeakMap<RtcDialBreaker, Map<string, PermanentHold>>();

function holdMap(breaker: RtcDialBreaker): Map<string, PermanentHold> {
  let map = holdsByBreaker.get(breaker);
  if (!map) {
    map = new Map();
    holdsByBreaker.set(breaker, map);
  }
  return map;
}

export function isPermanentDcFailureCode(code: DirectFailureCode): boolean {
  return PERMANENT_DC_FAILURE_CODES.has(code);
}

function syncPermanentHold(
  breaker: RtcDialBreaker,
  nodeId: string,
  now: number
): PermanentHold | null {
  const snap = breaker.snapshot(nodeId, now);
  const kind = snap.lastFailureKind;
  const map = holdMap(breaker);
  if (!kind) {
    map.delete(nodeId);
    return null;
  }
  const code = dcFailureCode(kind);
  if (!isPermanentDcFailureCode(code)) {
    map.delete(nodeId);
    return null;
  }
  const prev = map.get(nodeId);
  if (!prev || prev.code !== code || snap.failures > prev.failures) {
    const next: PermanentHold = { code, failures: snap.failures, since: now, probeReleased: false };
    map.set(nodeId, next);
    return next;
  }
  return prev;
}

/** 熔断 disabled 直到 rearm；永久失败码只抑制 PERMANENT_FAILURE_HOLD_MS，到期放行一次探测。 */
export function isBackgroundDcUpgradeBlocked(
  breaker: RtcDialBreaker,
  nodeId: string,
  now = Date.now()
): boolean {
  if (breaker.isDisabled(nodeId)) return true;
  const hold = syncPermanentHold(breaker, nodeId, now);
  if (!hold) return false;
  if (now - hold.since < PERMANENT_FAILURE_HOLD_MS) return true;
  return hold.probeReleased;
}

/** 真正排队拨号时消耗「到期后的一次探测」；新的永久失败会重新武装。 */
export function noteBackgroundDcUpgradeAttempt(
  breaker: RtcDialBreaker,
  nodeId: string,
  now = Date.now()
): void {
  const hold = syncPermanentHold(breaker, nodeId, now);
  if (!hold) return;
  if (now - hold.since < PERMANENT_FAILURE_HOLD_MS) return;
  hold.probeReleased = true;
}
