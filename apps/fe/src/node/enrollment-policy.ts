// enrollment 流水线里的两类小判定：能不能后台自动签，以及失败时该说哪一句。
//
// 从 `enrollment-engine.ts` 拆出来：那边是状态机与事务，这些是纯函数，混在一起只会让
// 那个文件继续变厚（门禁「只降不升」）。

import type { RecordSigner } from '@/auth/key-log-actions';
import { getMeshRelayState, isRelayMode } from './mesh-relay';

/**
 * 证书一到就自动签 `admit-node`——只有根钥签名者可以这么干。
 *
 * passkey 每签一次都要一次认证器仪式，而仪式必须由用户手势触发（Safari 强制要求，
 * Chrome 也会因为缺少 user activation 拒掉）。后台自动发起注定失败，不如留在「待确认」：
 * 用户点按钮时复用窗口里的凭证还在，不必再选一次 passkey。
 */
export function canAutoSignAdmit(signer: RecordSigner | null): boolean {
  return signer?.kind === 'root';
}

/** 证书对不上时的提示：过期与验签失败要分开讲，其余情况一律按验签失败处理。 */
export function invalidCertificateKey(reason: string): string {
  return reason === 'expired' ? 'nodes.enrollment.expired' : 'nodes.enrollment.badCertSig';
}

/** 上级没确认那一条：中继模式下上级不是 Hub，说「Hub 未确认」会把人引到错的机器上。 */
export function uplinkNotConfirmedKey(): string {
  return isRelayMode(getMeshRelayState())
    ? 'nodes.enrollment.relayNotConfirmed'
    : 'nodes.enrollment.hubNotConfirmed';
}
