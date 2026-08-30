import { describe, expect, test } from 'bun:test';
import type { AgentSessionDto, StateSnapshotPayload, TmuxPane, TmuxWindow } from '@tmex/shared';
import { isSessionOnNode } from '@tmex/stores';
import { shallow } from 'zustand/vanilla/shallow';
import { OrphanSessionRow, PaneSessionRow } from './agent-session-row';
import {
  collectKnownPaneIds,
  compareSessions,
  isSessionAttached,
  isSessionPaused,
  orderSessions,
  sessionsForPane,
} from './use-sidebar-agent-sessions';

function session(partial: Partial<AgentSessionDto> & { id: string }): AgentSessionDto {
  return {
    title: partial.id,
    nodeId: null,
    deviceId: null,
    paneId: null,
    providerId: null,
    modelId: 'm',
    systemPrompt: null,
    writeMode: 'confirm',
    useProviderWebSearch: false,
    providerHostedTools: [],
    allowControlChars: false,
    originPaneTitle: null,
    originProcessName: null,
    status: 'idle',
    lastError: null,
    maxStepsPerTurn: 10,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

const NODE_A = 'a'.repeat(32);

function toRecord(list: AgentSessionDto[]): Record<string, AgentSessionDto> {
  return Object.fromEntries(list.map((item) => [item.id, item]));
}

function pane(id: string): TmuxPane {
  return { id, windowId: '@0', index: 0, active: true, width: 80, height: 24 };
}

function snapshot(deviceId: string, paneIds: string[]): StateSnapshotPayload {
  const window: TmuxWindow = {
    id: '@0',
    name: 'w',
    index: 0,
    active: true,
    panes: paneIds.map(pane),
  };
  return { deviceId, session: { id: '$0', name: 's', windows: [window] } };
}

describe('compareSessions', () => {
  test('sorts by updatedAt descending', () => {
    const older = session({ id: 'a', updatedAt: '2026-01-01T00:00:00.000Z' });
    const newer = session({ id: 'b', updatedAt: '2026-01-02T00:00:00.000Z' });
    expect(compareSessions(newer, older)).toBeLessThan(0);
    expect(compareSessions(older, newer)).toBeGreaterThan(0);
  });

  test('is antisymmetric on updatedAt ties (id tie-breaker)', () => {
    const a = session({ id: 'a' });
    const b = session({ id: 'b' });
    expect(compareSessions(a, b)).toBeLessThan(0);
    expect(compareSessions(b, a)).toBeGreaterThan(0);
    expect(compareSessions(a, a)).toBe(0);
  });

  test('produces a stable order regardless of input order', () => {
    const list = [session({ id: 'a' }), session({ id: 'b' }), session({ id: 'c' })];
    const forward = [...list].sort(compareSessions).map((item) => item.id);
    const reversed = [...list]
      .reverse()
      .sort(compareSessions)
      .map((item) => item.id);
    expect(forward).toEqual(['a', 'b', 'c']);
    expect(reversed).toEqual(forward);
  });
});

describe('orderSessions', () => {
  test('follows the store sessionOrder', () => {
    const list = [session({ id: 'a' }), session({ id: 'b' }), session({ id: 'c' })];
    expect(orderSessions(toRecord(list), ['c', 'a', 'b']).map((item) => item.id)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  test('skips ids missing from the session map', () => {
    const list = [session({ id: 'a' })];
    expect(orderSessions(toRecord(list), ['gone', 'a']).map((item) => item.id)).toEqual(['a']);
  });

  test('appends sessions missing from sessionOrder using the comparator', () => {
    const list = [
      session({ id: 'a' }),
      session({ id: 'b', updatedAt: '2026-01-05T00:00:00.000Z' }),
      session({ id: 'c' }),
    ];
    expect(orderSessions(toRecord(list), ['a']).map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });

  test('ignores undefined entries and prototype keys', () => {
    const sessions: Record<string, AgentSessionDto | undefined> = {
      a: session({ id: 'a' }),
      b: undefined,
    };
    expect(orderSessions(sessions, ['a', 'b', 'toString', '__proto__']).map((s) => s.id)).toEqual([
      'a',
    ]);
  });
});

describe('sessionsForPane', () => {
  const order = ['a', 'b', 'c'];

  test('只取本 node 挂在该 pane 上的会话，顺序跟随 sessionOrder', () => {
    const sessions = toRecord([
      session({ id: 'a', deviceId: 'd1', paneId: '%1' }),
      session({ id: 'b', deviceId: 'd1', paneId: '%1' }),
      session({ id: 'c', deviceId: 'd2', paneId: '%1' }),
    ]);
    expect(sessionsForPane(sessions, ['b', 'a'], null, 'd1', '%1').map((s) => s.id)).toEqual([
      'b',
      'a',
    ]);
    expect(sessionsForPane(sessions, order, NODE_A, 'd1', '%1')).toEqual([]);
  });

  test('device/pane 分开比较，拼接歧义不会串台', () => {
    const sessions = toRecord([
      session({ id: 'a', deviceId: 'd', paneId: '1%1' }),
      session({ id: 'b', deviceId: 'd1', paneId: '%1' }),
    ]);
    expect(sessionsForPane(sessions, order, null, 'd1', '%1').map((s) => s.id)).toEqual(['b']);
    expect(sessionsForPane(sessions, order, null, 'd', '1%1').map((s) => s.id)).toEqual(['a']);
  });

  test('未绑定 device/pane 的会话不入列', () => {
    const sessions = toRecord([session({ id: 'a' }), session({ id: 'b', deviceId: 'd1' })]);
    expect(sessionsForPane(sessions, order, null, 'd1', '%1')).toEqual([]);
  });

  // 性能契约：某个会话更新后，未受影响的 pane 必须逐项同引用（useShallow 据此保住数组引用，
  // 该 pane 分支整支不重渲染），受影响 pane 内没变的行也保持同引用（React.memo 据此跳过）。
  test('无关会话更新后，其它 pane 的列表逐项同引用', () => {
    const before = toRecord([
      session({ id: 'a', deviceId: 'd1', paneId: '%1' }),
      session({ id: 'b', deviceId: 'd1', paneId: '%1' }),
      session({ id: 'c', deviceId: 'd2', paneId: '%2' }),
    ]);
    const after = { ...before, a: { ...before.a, title: 'renamed' } };

    const otherBefore = sessionsForPane(before, order, null, 'd2', '%2');
    const otherAfter = sessionsForPane(after, order, null, 'd2', '%2');
    expect(shallow(otherBefore, otherAfter)).toBe(true);

    const paneBefore = sessionsForPane(before, order, null, 'd1', '%1');
    const paneAfter = sessionsForPane(after, order, null, 'd1', '%1');
    expect(shallow(paneBefore, paneAfter)).toBe(false);
    expect(paneAfter[0]).not.toBe(paneBefore[0]);
    expect(paneAfter[1]).toBe(paneBefore[1]);
  });
});

describe('会话行组件', () => {
  test('两种会话行都是 React.memo 组件（props 不变即跳过重渲染）', () => {
    for (const row of [PaneSessionRow, OrphanSessionRow]) {
      expect((row as unknown as { $$typeof: symbol }).$$typeof).toBe(Symbol.for('react.memo'));
    }
  });
});

describe('collectKnownPaneIds', () => {
  test('collects pane ids per device', () => {
    const panes = collectKnownPaneIds({
      d1: snapshot('d1', ['%1', '%2']),
      d2: snapshot('d2', ['%3']),
    });
    expect([...(panes.get('d1') ?? [])]).toEqual(['%1', '%2']);
    expect([...(panes.get('d2') ?? [])]).toEqual(['%3']);
  });

  test('skips devices without a loaded session snapshot', () => {
    const panes = collectKnownPaneIds({
      d1: { deviceId: 'd1', session: null },
      d2: undefined,
    });
    expect(panes.has('d1')).toBe(false);
    expect(panes.has('d2')).toBe(false);
  });
});

describe('isSessionAttached', () => {
  const known = new Set(['d1']);
  const panesByDevice = collectKnownPaneIds({ d1: snapshot('d1', ['%1']) });

  test('attached when the pane still exists', () => {
    const item = session({ id: 'a', deviceId: 'd1', paneId: '%1' });
    expect(isSessionAttached(item, known, panesByDevice, true)).toBe(true);
  });

  test('detached when the device still exists but the pane is gone', () => {
    const item = session({ id: 'a', deviceId: 'd1', paneId: '%9' });
    expect(isSessionAttached(item, known, panesByDevice, true)).toBe(false);
  });

  test('detached when the device is unknown', () => {
    const item = session({ id: 'a', deviceId: 'gone', paneId: '%1' });
    expect(isSessionAttached(item, known, panesByDevice, true)).toBe(false);
  });

  test('detached when the session has no pane binding', () => {
    expect(isSessionAttached(session({ id: 'a' }), known, panesByDevice, true)).toBe(false);
    expect(
      isSessionAttached(session({ id: 'b', deviceId: 'd1' }), known, panesByDevice, true)
    ).toBe(false);
  });

  test('treated as attached while the device snapshot has not loaded yet', () => {
    const item = session({ id: 'a', deviceId: 'd1', paneId: '%1' });
    expect(isSessionAttached(item, known, new Map(), true)).toBe(true);
  });

  test('bound sessions stay attached while the device list is not ready', () => {
    const bound = session({ id: 'a', deviceId: 'gone', paneId: '%9' });
    expect(isSessionAttached(bound, new Set(), new Map(), false)).toBe(true);
    // 未绑定 pane 的会话与设备列表无关，始终算孤立
    expect(isSessionAttached(session({ id: 'b' }), new Set(), new Map(), false)).toBe(false);
  });
});

describe('per-node session filtering', () => {
  const local = session({ id: 'local', deviceId: 'd1', paneId: '%1' });
  const remote = session({ id: 'remote', nodeId: NODE_A, deviceId: 'd1', paneId: '%1' });
  const all = [local, remote];

  test('a node section only lists the sessions bound to it', () => {
    expect(all.filter((item) => isSessionOnNode(item, null))).toEqual([local]);
    expect(all.filter((item) => isSessionOnNode(item, NODE_A))).toEqual([remote]);
  });

  test('grouping by pane stays per node, so identical device:pane keys do not collide', () => {
    const sessions = toRecord(all);
    expect(sessionsForPane(sessions, ['local', 'remote'], null, 'd1', '%1')).toEqual([local]);
    expect(sessionsForPane(sessions, ['local', 'remote'], NODE_A, 'd1', '%1')).toEqual([remote]);
  });
});

describe('isSessionPaused', () => {
  test('paused while the node is offline', () => {
    expect(isSessionPaused(session({ id: 'a' }), true)).toBe(true);
  });

  test('mesh state wins: a node back online reopens a session still holding NODE_OFFLINE', () => {
    expect(isSessionPaused(session({ id: 'a', lastError: 'NODE_OFFLINE' }), false)).toBe(false);
  });

  test('falls back to the session error while the mesh state is unknown', () => {
    expect(isSessionPaused(session({ id: 'a', lastError: 'NODE_OFFLINE' }), undefined)).toBe(true);
    expect(isSessionPaused(session({ id: 'a', lastError: 'boom' }), undefined)).toBe(false);
  });

  test('not paused for an online node with an unrelated error', () => {
    expect(isSessionPaused(session({ id: 'a', lastError: 'boom' }), false)).toBe(false);
  });
});
