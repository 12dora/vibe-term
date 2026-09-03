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
  test('smallest visible cols wins', () => {
    const winner = resolveWinner([
      claim('small', { cols: 80, rows: 24 }),
      claim('large', { cols: 160, rows: 48 }),
      claim('mid', { cols: 120, rows: 30 }),
    ]);
    expect(winner?.sessionId).toBe('small');
    expect(winner?.claim.cols).toBe(80);
    expect(winner?.claim.rows).toBe(24);
  });

  test('160x48 vs 80x24 picks 80x24', () => {
    const winner = resolveWinner([
      claim('desktop', { cols: 160, rows: 48 }),
      claim('phone', { cols: 80, rows: 24 }),
    ]);
    expect(winner?.sessionId).toBe('phone');
    expect(winner?.claim.cols).toBe(80);
    expect(winner?.claim.rows).toBe(24);
  });

  test('min cols wins even when that claim has a larger area', () => {
    const listed = resolveWinner([
      claim('wide', { cols: 100, rows: 30 }),
      claim('phone', { cols: 42, rows: 60 }),
    ]);
    expect(listed?.sessionId).toBe('phone');
    expect(listed?.claim.cols).toBe(42);
    expect(listed?.claim.rows).toBe(60);

    // 42×80 面积大于 100×30，min-area 会选 wide；min-cols 仍选 phone
    const taller = resolveWinner([
      claim('wide', { cols: 100, rows: 30 }),
      claim('phone', { cols: 42, rows: 80 }),
    ]);
    expect(taller?.sessionId).toBe('phone');
    expect(taller?.claim.cols).toBe(42);
    expect(taller?.claim.rows).toBe(80);
  });

  test('hidden claims are excluded', () => {
    const winner = resolveWinner([
      claim('tiny', { cols: 20, rows: 10, visible: false }),
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

  test('equal cols prefers smaller rows, then lowest session id', () => {
    expect(
      resolveWinner([claim('b', { cols: 80, rows: 50 }), claim('a', { cols: 80, rows: 40 })])
        ?.sessionId
    ).toBe('a');

    expect(
      resolveWinner([
        claim('sess-b', { cols: 80, rows: 24 }),
        claim('sess-a', { cols: 80, rows: 24 }),
      ])?.sessionId
    ).toBe('sess-a');
  });

  test('when the smallest hides, the next-smallest visible wins', () => {
    const remaining = [
      claim('desktop', { cols: 160, rows: 48 }),
      claim('phone', { cols: 80, rows: 24, visible: false }),
      claim('tablet', { cols: 100, rows: 30 }),
    ];
    expect(resolveWinner(remaining)?.sessionId).toBe('tablet');
    expect(resolveWinner(remaining)?.claim.cols).toBe(100);
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
  test('returns null when there is no winner or last-applied geometry is unchanged', () => {
    const winner = {
      sessionId: 'a',
      claim: { paneId: '%0', cols: 80, rows: 24, visible: true, at: 1 },
    };
    expect(applyWinnerGeometry(null, { cols: 80, rows: 24 })).toBeNull();
    expect(applyWinnerGeometry(winner, { cols: 80, rows: 24 })).toBeNull();
    expect(applyWinnerGeometry(winner, { cols: 80, rows: 24 }, { cols: 80, rows: 24 })).toBeNull();
  });

  test('applies when this window has never been resized, but skips when the snapshot already matches', () => {
    const winner = {
      sessionId: 'a',
      claim: { paneId: '%0', cols: 80, rows: 24, visible: true, at: 1 },
    };
    expect(applyWinnerGeometry(winner, undefined)).toEqual({
      paneId: '%0',
      cols: 80,
      rows: 24,
      force: true,
    });
    expect(applyWinnerGeometry(winner, undefined, { cols: 80, rows: 24 })).toBeNull();
  });

  test('forces a resize when last-applied matches but live tmux geometry has drifted', () => {
    const winner = {
      sessionId: 'a',
      claim: { paneId: '%0', cols: 80, rows: 24, visible: true, at: 1 },
    };
    expect(applyWinnerGeometry(winner, { cols: 80, rows: 24 }, { cols: 60, rows: 18 })).toEqual({
      paneId: '%0',
      cols: 80,
      rows: 24,
      force: true,
    });
  });

  test('forces a resize when the claimed size changes', () => {
    const winner = {
      sessionId: 'a',
      claim: { paneId: '%0', cols: 120, rows: 40, visible: true, at: 1 },
    };
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
    const first = sessionClaims('a', [[key, { ...claim }]]);
    const second = sessionClaims('b', [[key, { ...claim }]]);
    const sent: string[] = [];

    const policyFor = (session: { id: string }) => ({
      owner: session.id === 'a',
      cols: 80,
      rows: 24,
    });
    notifyClaimants([first, second], key, true, first, policyFor, (session) => {
      sent.push(session.id);
    });
    expect(sent).toEqual(['a', 'b']);

    sent.length = 0;
    notifyClaimants([first, second], key, false, first, policyFor, (session) => {
      sent.push(session.id);
    });
    expect(sent).toEqual(['a']);
  });

  test('resends whenever the policy differs from what the session last received', () => {
    const key = viewportClaimKey('dev-a', '@1');
    const claim: ViewportClaim = { paneId: '%0', cols: 80, rows: 24, visible: true, at: 1 };
    const follower = sessionClaims('b', [[key, claim]]);
    const sent: string[] = [];
    const send = (session: { id: string }) => {
      sent.push(session.id);
    };

    // 从未发过：即使不广播、也不是 notifyFirst，也要补发一次
    notifyClaimants(
      [follower],
      key,
      false,
      undefined,
      () => ({ owner: false, cols: 160, rows: 48 }),
      send
    );
    expect(sent).toEqual(['b']);

    // 内容没变：不重复发
    sent.length = 0;
    notifyClaimants(
      [follower],
      key,
      false,
      undefined,
      () => ({ owner: false, cols: 160, rows: 48 }),
      send
    );
    expect(sent).toEqual([]);

    // owner 变了：重发
    notifyClaimants(
      [follower],
      key,
      false,
      undefined,
      () => ({ owner: true, cols: 160, rows: 48 }),
      send
    );
    expect(sent).toEqual(['b']);

    // 同窗换 pane（声明换了 paneId 但沿用 sentPolicy）：重发
    sent.length = 0;
    follower.viewportClaims.set(key, { ...claim, paneId: '%1', sentPolicy: claim.sentPolicy });
    notifyClaimants(
      [follower],
      key,
      false,
      undefined,
      () => ({ owner: true, cols: 160, rows: 48 }),
      send
    );
    expect(sent).toEqual(['b']);
  });
});
