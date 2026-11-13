import { describe, expect, test } from 'bun:test';
import {
  type RelayTokenGraceRow,
  relayCurrentTokenPredatesRevoke,
  relayPreviousTokens,
  relayTokenHashAccepted,
  relayTokenHashState,
  relayTokensAfterReissue,
  relayTokensAfterRevoke,
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

describe('relay tokens after a revoke', () => {
  test('吊销后历史令牌对凭令牌的 HTTP 立刻失效，只剩 uplink 宽限', () => {
    const revoked: RelayTokenGraceRow = {
      ...row,
      previousTokens: relayTokensAfterRevoke(row, 200),
    };
    for (const hash of ['third', 'second']) {
      expect(relayTokenHashAccepted(revoked, hash, 300)).toBe(false);
      expect(relayTokenHashAccepted(revoked, hash, 300, 'uplink')).toBe(true);
    }
    expect(relayTokenHashState(revoked, 'current', 300)).toBe('current');
    expect(relayCurrentTokenPredatesRevoke(revoked)).toBe(true);
    expect(relayCurrentTokenPredatesRevoke(row)).toBe(false);
  });

  test('吊销之前签发的当前令牌在换发后不再有 HTTP 宽限', () => {
    const revoked: RelayTokenGraceRow = {
      ...row,
      previousTokens: relayTokensAfterRevoke(row, 200),
    };
    const reissued: RelayTokenGraceRow = {
      tokenHash: 'fresh',
      prevTokenHash: 'current',
      prevTokenIssuedAt: 400,
      previousTokens: relayTokensAfterReissue(revoked, 400),
    };
    expect(relayTokenHashAccepted(reissued, 'current', 500)).toBe(false);
    expect(relayTokenHashAccepted(reissued, 'current', 500, 'uplink')).toBe(true);
    expect(relayCurrentTokenPredatesRevoke(reissued)).toBe(false);
    const again: RelayTokenGraceRow = {
      tokenHash: 'newer',
      prevTokenHash: 'fresh',
      prevTokenIssuedAt: 600,
      previousTokens: relayTokensAfterReissue(reissued, 600),
    };
    expect(relayTokenHashAccepted(again, 'fresh', 700)).toBe(true);
  });

  test('没有吊销时换发照旧给上一代完整宽限', () => {
    const reissued: RelayTokenGraceRow = {
      tokenHash: 'fresh',
      prevTokenHash: 'current',
      prevTokenIssuedAt: 400,
      previousTokens: relayTokensAfterReissue(row, 400),
    };
    expect(relayTokenHashAccepted(reissued, 'current', 500)).toBe(true);
  });
});
