import { describe, expect, test } from 'bun:test';
import {
  type RelayTokenGraceRow,
  relayPreviousTokens,
  relayTokenHashAccepted,
  relayTokenHashState,
} from './relay-token-grace';
import { RELAY_PREV_TOKEN_GRACE_MS } from './types';

const row: RelayTokenGraceRow = {
  tokenHash: 'current',
  prevTokenHash: 'legacy',
  prevTokenIssuedAt: 10,
  previousTokens: [
    { hash: 'third', issued_at: 30 },
    { hash: 'second', issued_at: 20 },
    { hash: 'first', issued_at: 10 },
  ],
};

describe('relay previous token ring', () => {
  test('当前令牌及三代宽限令牌分别分类', () => {
    expect(relayTokenHashState(row, 'current', 100)).toBe('current');
    for (const hash of ['first', 'second', 'third']) {
      expect(relayTokenHashAccepted(row, hash, 100)).toBe(true);
      expect(relayTokenHashState(row, hash, 100)).toBe('password_rotated');
    }
    expect(relayTokenHashState(row, 'unknown', 100)).toBe('kicked');
    expect(relayTokenHashAccepted(row, 'legacy', 100)).toBe(false);
  });

  test('每代分别过期，后续换发不延长最早令牌宽限', () => {
    expect(relayTokenHashAccepted(row, 'first', RELAY_PREV_TOKEN_GRACE_MS + 10)).toBe(true);
    expect(relayTokenHashState(row, 'first', RELAY_PREV_TOKEN_GRACE_MS + 11)).toBe('kicked');
    expect(relayTokenHashAccepted(row, 'second', RELAY_PREV_TOKEN_GRACE_MS + 11)).toBe(true);
    expect(relayTokenHashAccepted(row, 'third', RELAY_PREV_TOKEN_GRACE_MS + 21)).toBe(true);
    expect(relayTokenHashAccepted(row, 'second', RELAY_PREV_TOKEN_GRACE_MS + 21)).toBe(false);
  });

  test('旧单槽记录可读，显式空环不会回退复活旧令牌', () => {
    const legacy = { tokenHash: 'current', prevTokenHash: 'legacy', prevTokenIssuedAt: 10 };
    expect(relayPreviousTokens(legacy)).toEqual([{ hash: 'legacy', issued_at: 10 }]);
    expect(relayTokenHashAccepted(legacy, 'legacy', 100)).toBe(true);
    expect(relayTokenHashAccepted({ ...legacy, previousTokens: [] }, 'legacy', 100)).toBe(false);
    expect(relayTokenHashAccepted({ ...legacy, prevTokenIssuedAt: null }, 'legacy', 100)).toBe(
      false
    );
  });
});
