import { constantTimeEqual } from './relay-password';
import { RELAY_PREV_TOKEN_GRACE_MS } from './types';

/**
 * 令牌换发的宽限窗口。
 *
 * 新令牌只能经密钥日志（`set-relays`）分发给成员节点，而成员必须先通过 `relay.auth` 才拉得到日志。
 * 换发那一刻就作废旧令牌 = 成员在拿到新记录之前先被踢下线，从此永远拉不到 → 死锁。
 * 因此非踢出场景的换发保留上一代哈希，宽限期内两代都认；踢出 / 吊销一律清掉，不留后门。
 */
export type RelayTokenGraceRow = {
  tokenHash: string;
  prevTokenHash: string | null;
  prevTokenIssuedAt: number | null;
};

export function relayPrevTokenUsable(row: RelayTokenGraceRow, now: number): boolean {
  if (!row.prevTokenHash || row.prevTokenIssuedAt === null) return false;
  return now - row.prevTokenIssuedAt <= RELAY_PREV_TOKEN_GRACE_MS;
}

/** 常数时间比较当前哈希；不中再比宽限期内的上一代。 */
export function relayTokenHashAccepted(
  row: RelayTokenGraceRow,
  presentedHash: string,
  now: number
): boolean {
  if (constantTimeEqual(presentedHash, row.tokenHash)) return true;
  if (!relayPrevTokenUsable(row, now)) return false;
  return constantTimeEqual(presentedHash, row.prevTokenHash ?? '');
}
