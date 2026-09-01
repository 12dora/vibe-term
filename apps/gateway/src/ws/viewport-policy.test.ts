import { describe, expect, test } from 'bun:test';
import {
  type ViewportClaim,
  type ViewportClaimRecord,
  applyWinnerGeometry,
  collectWindowClaims,
  notifyClaimants,
  parseViewportClaimKey,
  rebindAllViewportClaims,
  reconcileViewportClaims,
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

function sessionClaims(
  id: string,
  entries: Array<[string, ViewportClaim]> = []
): { id: string; viewportClaims: Map<string, ViewportClaim> } {
  return { id, viewportClaims: new Map(entries) };
}

describe('collectWindowClaims', () => {
  test('skips claimants without a claim for the key', () => {
    const key = viewportClaimKey('dev-a', '@1');
    const visible: ViewportClaim = {
      paneId: '%0',
      cols: 80,
      rows: 24,
      visible: true,
      at: 1,
    };
    const records = collectWindowClaims(
      [sessionClaims('a', [[key, visible]]), sessionClaims('b')],
      key
    );
    expect(records).toEqual([{ sessionId: 'a', claim: visible }]);
  });
});

describe('applyWinnerGeometry', () => {
  test('returns null when there is no winner or geometry is unchanged', () => {
    const winner = {
      sessionId: 'a',
      claim: { paneId: '%0', cols: 80, rows: 24, visible: true, at: 1 },
    };
    expect(applyWinnerGeometry(null, { cols: 80, rows: 24 })).toBeNull();
    expect(applyWinnerGeometry(winner, { cols: 80, rows: 24 })).toBeNull();
  });

  test('returns force=false on first apply and force=true when size changes', () => {
    const winner = {
      sessionId: 'a',
      claim: { paneId: '%0', cols: 120, rows: 40, visible: true, at: 1 },
    };
    expect(applyWinnerGeometry(winner, undefined)).toEqual({
      paneId: '%0',
      cols: 120,
      rows: 40,
      force: false,
    });
    expect(applyWinnerGeometry(winner, { cols: 80, rows: 24 })).toEqual({
      paneId: '%0',
      cols: 120,
      rows: 40,
      force: true,
    });
  });
});

describe('reconcileViewportClaims', () => {
  test('re-keys claims whose pane moved to another window and reports the new window', () => {
    const key = viewportClaimKey('dev-a', '@1');
    const claim: ViewportClaim = { paneId: '%0', cols: 80, rows: 24, visible: true, at: 1 };
    const session = sessionClaims('a', [[key, claim]]);

    const moved = reconcileViewportClaims([session], key, '@1', (paneId) =>
      paneId === '%0' ? '@2' : null
    );

    expect(moved).toEqual(['@2']);
    expect(session.viewportClaims.has(key)).toBe(false);
    expect(session.viewportClaims.get(viewportClaimKey('dev-a', '@2'))).toBe(claim);
  });

  test('drops claims whose pane no longer exists', () => {
    const key = viewportClaimKey('dev-a', '@1');
    const session = sessionClaims('a', [
      [key, { paneId: '%0', cols: 80, rows: 24, visible: true, at: 1 }],
    ]);

    expect(reconcileViewportClaims([session], key, '@1', () => null)).toEqual([]);
    expect(session.viewportClaims.size).toBe(0);
  });

  test('keeps claims whose pane still belongs to the window', () => {
    const key = viewportClaimKey('dev-a', '@1');
    const visible: ViewportClaim = { paneId: '%0', cols: 80, rows: 24, visible: true, at: 1 };
    const session = sessionClaims('a', [[key, visible]]);

    expect(reconcileViewportClaims([session], key, '@1', () => '@1')).toEqual([]);
    expect(session.viewportClaims.get(key)).toBe(visible);
  });
});

describe('rebindAllViewportClaims', () => {
  test('re-keys moved panes, drops missing panes, and reports source and destination windows', () => {
    const moved: ViewportClaim = { paneId: '%0', cols: 160, rows: 48, visible: true, at: 1 };
    const gone: ViewportClaim = { paneId: '%9', cols: 80, rows: 24, visible: true, at: 1 };
    const stay: ViewportClaim = { paneId: '%2', cols: 80, rows: 24, visible: true, at: 1 };
    const session = sessionClaims('a', [
      [viewportClaimKey('dev-a', '@1'), moved],
      [viewportClaimKey('dev-a', '@3'), gone],
      [viewportClaimKey('dev-a', '@4'), stay],
      [viewportClaimKey('dev-b', '@1'), gone],
    ]);

    const affected = rebindAllViewportClaims([session], 'dev-a', (paneId) => {
      if (paneId === '%0') return '@2';
      if (paneId === '%2') return '@4';
      return null;
    });

    expect(new Set(affected)).toEqual(new Set(['@1', '@2', '@3']));
    expect(session.viewportClaims.get(viewportClaimKey('dev-a', '@2'))).toBe(moved);
    expect(session.viewportClaims.has(viewportClaimKey('dev-a', '@1'))).toBe(false);
    expect(session.viewportClaims.has(viewportClaimKey('dev-a', '@3'))).toBe(false);
    expect(session.viewportClaims.get(viewportClaimKey('dev-a', '@4'))).toBe(stay);
    expect(session.viewportClaims.get(viewportClaimKey('dev-b', '@1'))).toBe(gone);
  });
});

describe('notifyClaimants', () => {
  test('sends to every claimant on broadcast, otherwise only notifyFirst', () => {
    const key = viewportClaimKey('dev-a', '@1');
    const claim: ViewportClaim = { paneId: '%0', cols: 80, rows: 24, visible: true, at: 1 };
    const first = sessionClaims('a', [[key, claim]]);
    const second = sessionClaims('b', [[key, claim]]);
    const sent: string[] = [];

    notifyClaimants([first, second], key, true, first, (session) => {
      sent.push(session.id);
    });
    expect(sent).toEqual(['a', 'b']);

    sent.length = 0;
    notifyClaimants([first, second], key, false, first, (session) => {
      sent.push(session.id);
    });
    expect(sent).toEqual(['a']);
  });
});
