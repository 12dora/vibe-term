// 「作废旧令牌」前的离线成员防护（E2 审计 F12）。
//
// 改接入密码选「作废旧令牌」、以及单独踢某个租户，都会把该租户全部历史令牌一并清空——
// **没有 30 天宽限**。此刻离线的成员回来时手里那把令牌已经作废，中继连认证都不给过，
// 也就永远追不上后面那条新的 `set-relays`。它们只剩一条出路：在还能连上中继的机器上
// 重新输入接入密码，再用账号密码重新加入中继。
//
// 服务端在这种情形下先回 409 `relay_members_offline` 并带上人数；界面把后果与恢复链
// 摆出来，用户确认之后才带 `force: true` 重发。

import { RelayApiError } from '@vibeterm/api-client/relay/admin-api';
import type { RelayRunOutcome } from './use-relay-action';

/** 429 之外唯一需要二次确认的写入拒绝。 */
export const RELAY_MEMBERS_OFFLINE = 'relay_members_offline';

export interface RelayMembersOffline {
  /** 当前在线的已准入成员数。 */
  online: number;
  /** 已准入成员总数（pending / 已吊销不计）。 */
  admitted: number;
}

/** 是这条 409 就返回人数，其余错误返回 `null`。 */
export function relayMembersOffline(error: unknown): RelayMembersOffline | null {
  if (!(error instanceof RelayApiError) || error.code !== RELAY_MEMBERS_OFFLINE) return null;
  const { online, admitted } = error.details ?? {};
  if (typeof online !== 'number' || typeof admitted !== 'number') return null;
  return { online, admitted };
}

/** 一次「可以 force 重来」的写入的结论。 */
export type RelayGuardedOutcome =
  | { kind: 'done' }
  /** 被离线成员防护拦下：摆二次确认框，认下后果再带 `force` 重发。 */
  | { kind: 'guard'; offline: RelayMembersOffline }
  | { kind: 'failed'; error: unknown };

/** 把写操作结论分成三档；`run()` 的 state 会晚一帧，判定只认这里传进来的原始异常。 */
export function classifyGuardedWrite(outcome: RelayRunOutcome): RelayGuardedOutcome {
  if (outcome.ok) return { kind: 'done' };
  const offline = relayMembersOffline(outcome.error);
  return offline ? { kind: 'guard', offline } : { kind: 'failed', error: outcome.error };
}
