import { constantTimeEqual } from './relay-password';
import { RELAY_PREV_TOKEN_GRACE_MS } from './types';

export const RELAY_PREV_TOKEN_LIMIT = 3;

/**
 * `node_only`：该令牌签发于一次吊销之前。它只在 uplink 认证里继续有效——uplink 还要求
 * 已准入且未吊销的节点签名，被吊销的节点因此用不了；凭令牌直接访问的 HTTP 接口一律拒绝。
 * 与当前令牌哈希相同的 `node_only` 项是「当前令牌签发于吊销之前」的标记，下次换发时据此不给全权宽限。
 */
export type RelayPreviousToken = { hash: string; issued_at: number; node_only?: true };

/** `uplink`：调用方另有节点签名与准入复查；`http`：只凭令牌。 */
export type RelayTokenScope = 'uplink' | 'http';

export type RelayTokenGraceRow = {
  tokenHash: string;
  prevTokenHash: string | null;
  prevTokenIssuedAt: number | null;
  previousTokens?: RelayPreviousToken[];
};

export function relayPreviousTokens(row: RelayTokenGraceRow): RelayPreviousToken[] {
  if (row.previousTokens !== undefined) return row.previousTokens.slice(0, RELAY_PREV_TOKEN_LIMIT);
  return row.prevTokenHash && row.prevTokenIssuedAt !== null
    ? [{ hash: row.prevTokenHash, issued_at: row.prevTokenIssuedAt }]
    : [];
}

export function relayCurrentTokenPredatesRevoke(row: RelayTokenGraceRow): boolean {
  return relayPreviousTokens(row).some(
    (entry) => entry.node_only === true && entry.hash === row.tokenHash
  );
}

/** 吊销落库：现有全部令牌（含当前）降为 `node_only`，第一项是当前令牌的标记。 */
export function relayTokensAfterRevoke(row: RelayTokenGraceRow, now: number): RelayPreviousToken[] {
  const previous = relayPreviousTokens(row).filter((entry) => entry.hash !== row.tokenHash);
  return [
    { hash: row.tokenHash, issued_at: now, node_only: true as const },
    ...previous.map((entry) => ({ ...entry, node_only: true as const })),
  ].slice(0, RELAY_PREV_TOKEN_LIMIT);
}

/** 换发时把当前令牌推入历史环；签发于吊销之前的当前令牌只保留 uplink 宽限。 */
export function relayTokensAfterReissue(
  row: RelayTokenGraceRow,
  now: number
): RelayPreviousToken[] {
  const nodeOnly = relayCurrentTokenPredatesRevoke(row);
  return [
    { hash: row.tokenHash, issued_at: now, ...(nodeOnly ? { node_only: true as const } : {}) },
    ...relayPreviousTokens(row).filter((entry) => entry.hash !== row.tokenHash),
  ].slice(0, RELAY_PREV_TOKEN_LIMIT);
}

export function relayPrevTokenUsable(
  row: RelayTokenGraceRow,
  now: number,
  presentedHash?: string,
  scope: RelayTokenScope = 'http'
): boolean {
  return relayPreviousTokens(row).some(
    (entry) =>
      entry.hash !== row.tokenHash &&
      now - entry.issued_at <= RELAY_PREV_TOKEN_GRACE_MS &&
      (scope === 'uplink' || entry.node_only !== true) &&
      (presentedHash === undefined || constantTimeEqual(presentedHash, entry.hash))
  );
}

export function relayTokenHashState(
  row: RelayTokenGraceRow,
  presentedHash: string,
  now: number,
  scope: RelayTokenScope = 'http'
): 'current' | 'password_rotated' | 'kicked' {
  if (constantTimeEqual(presentedHash, row.tokenHash)) return 'current';
  return relayPrevTokenUsable(row, now, presentedHash, scope) ? 'password_rotated' : 'kicked';
}

export function relayTokenHashAccepted(
  row: RelayTokenGraceRow,
  presentedHash: string,
  now: number,
  scope: RelayTokenScope = 'http'
): boolean {
  return relayTokenHashState(row, presentedHash, now, scope) !== 'kicked';
}
