import { describe, expect, test } from 'bun:test';
import {
  type ViewportClaim,
  type ViewportClaimRecord,
  parseViewportClaimKey,
  resolveWinner,
  takeViewportClaimKeys,
  viewportClaimKey,
} from './viewport-policy';

function claim(
  sessionId: string,
  partial: Partial<ViewportClaim> & Pick<ViewportClaim, 'cols' | 'rows'>
): ViewportClaimRecord {
  return {
    sessionId,
    claim: {
      paneId: partial.paneId ?? '%0',
      cols: partial.cols,
      rows: partial.rows,
      visible: partial.visible ?? true,
      at: partial.at ?? 1,
    },
  };
}

describe('viewportClaimKey', () => {
  test('round-trips deviceId/windowId', () => {
    const key = viewportClaimKey('dev-a', '@1');
    expect(key).toBe('dev-a/@1');
    expect(parseViewportClaimKey(key)).toEqual({ deviceId: 'dev-a', windowId: '@1' });
  });
});

describe('resolveWinner', () => {
  test('largest visible area wins', () => {
    const winner = resolveWinner([
      claim('small', { cols: 80, rows: 24 }),
      claim('large', { cols: 160, rows: 48 }),
      claim('mid', { cols: 120, rows: 30 }),
    ]);
    expect(winner?.sessionId).toBe('large');
    expect(winner?.claim.cols).toBe(160);
    expect(winner?.claim.rows).toBe(48);
  });

  test('hidden claims are excluded', () => {
    const winner = resolveWinner([
      claim('large', { cols: 200, rows: 50, visible: false }),
      claim('small', { cols: 80, rows: 24 }),
    ]);
    expect(winner?.sessionId).toBe('small');
  });

  test('no visible claims yields null', () => {
    expect(
      resolveWinner([
        claim('a', { cols: 80, rows: 24, visible: false }),
        claim('b', { cols: 160, rows: 48, visible: false }),
      ])
    ).toBeNull();
    expect(resolveWinner([])).toBeNull();
  });

  test('equal area prefers greater cols, then rows, then lowest session id', () => {
    expect(
      resolveWinner([claim('b', { cols: 100, rows: 40 }), claim('a', { cols: 80, rows: 50 })])
        ?.sessionId
    ).toBe('b');

    expect(
      resolveWinner([claim('b', { cols: 80, rows: 50 }), claim('a', { cols: 80, rows: 40 })])
        ?.sessionId
    ).toBe('b');

    expect(
      resolveWinner([
        claim('sess-b', { cols: 80, rows: 24 }),
        claim('sess-a', { cols: 80, rows: 24 }),
      ])?.sessionId
    ).toBe('sess-a');
  });

  test('removing a claim is just resolving the remainder', () => {
    const remaining = [
      claim('small', { cols: 80, rows: 24 }),
      claim('hidden', { cols: 200, rows: 60, visible: false }),
    ];
    expect(resolveWinner(remaining)?.sessionId).toBe('small');
  });
});

describe('takeViewportClaimKeys', () => {
  test('deletes matching keys and returns affected windows', () => {
    const claims = new Map<string, ViewportClaim>([
      [viewportClaimKey('dev-a', '@1'), { paneId: '%0', cols: 80, rows: 24, visible: true, at: 1 }],
      [viewportClaimKey('dev-a', '@2'), { paneId: '%1', cols: 80, rows: 24, visible: true, at: 1 }],
      [viewportClaimKey('dev-b', '@1'), { paneId: '%2', cols: 80, rows: 24, visible: true, at: 1 }],
    ]);

    const affected = takeViewportClaimKeys(claims, 'dev-a');
    expect(affected).toEqual([
      { key: 'dev-a/@1', deviceId: 'dev-a', windowId: '@1' },
      { key: 'dev-a/@2', deviceId: 'dev-a', windowId: '@2' },
    ]);
    expect([...claims.keys()]).toEqual(['dev-b/@1']);
  });

  test('without deviceId drops every claim', () => {
    const claims = new Map<string, ViewportClaim>([
      [viewportClaimKey('dev-a', '@1'), { paneId: '%0', cols: 8, rows: 8, visible: true, at: 1 }],
    ]);
    expect(takeViewportClaimKeys(claims)).toHaveLength(1);
    expect(claims.size).toBe(0);
  });
});
