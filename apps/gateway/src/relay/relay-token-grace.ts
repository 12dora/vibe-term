import { constantTimeEqual } from './relay-password';
import { RELAY_PREV_TOKEN_GRACE_MS } from './types';

export const RELAY_PREV_TOKEN_LIMIT = 3;

export type RelayPreviousToken = { hash: string; issued_at: number };

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

export function relayPrevTokenUsable(
  row: RelayTokenGraceRow,
  now: number,
  presentedHash?: string
): boolean {
  return relayPreviousTokens(row).some(
    (entry) =>
      now - entry.issued_at <= RELAY_PREV_TOKEN_GRACE_MS &&
      (presentedHash === undefined || constantTimeEqual(presentedHash, entry.hash))
  );
}

export function relayTokenHashState(
  row: RelayTokenGraceRow,
  presentedHash: string,
  now: number
): 'current' | 'password_rotated' | 'kicked' {
  if (constantTimeEqual(presentedHash, row.tokenHash)) return 'current';
  return relayPrevTokenUsable(row, now, presentedHash) ? 'password_rotated' : 'kicked';
}

export function relayTokenHashAccepted(
  row: RelayTokenGraceRow,
  presentedHash: string,
  now: number
): boolean {
  return relayTokenHashState(row, presentedHash, now) !== 'kicked';
}
