// enrollment 流水线里的小判定：失败时该说哪一句。
//
// 从 `enrollment-engine.ts` 拆出来：那边是状态机与事务，这些是纯函数，混在一起只会让
// 那个文件继续变厚（门禁「只降不升」）。

/** 证书对不上时的提示：过期与验签失败要分开讲，其余情况一律按验签失败处理。 */
export function invalidCertificateKey(reason: string): string {
  return reason === 'expired' ? 'nodes.enrollment.expired' : 'nodes.enrollment.badCertSig';
}

/** 上级没确认那一条：中继 fan-out 没落账（`relayAck === false`）。 */
export function uplinkNotConfirmedKey(): string {
  return 'nodes.enrollment.relayNotConfirmed';
}
