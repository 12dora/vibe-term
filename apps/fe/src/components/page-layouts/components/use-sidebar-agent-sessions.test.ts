import { describe, expect, test } from 'bun:test';
import type { AgentSessionDto, StateSnapshotPayload, TmuxPane, TmuxWindow } from '@tmex/shared';
import {
  collectKnownPaneIds,
  compareSessions,
  groupSessionsByPane,
  isSessionAttached,
  orderSessions,
  paneKey,
} from './use-sidebar-agent-sessions';

function session(partial: Partial<AgentSessionDto> & { id: string }): AgentSessionDto {
  return {
    title: partial.id,
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

describe('groupSessionsByPane', () => {
  test('groups by device+pane preserving input order', () => {
    const first = session({ id: 'a', deviceId: 'd1', paneId: '%1' });
    const second = session({ id: 'b', deviceId: 'd1', paneId: '%1' });
    const other = session({ id: 'c', deviceId: 'd2', paneId: '%1' });
    const grouped = groupSessionsByPane([first, second, other]);
    expect(grouped.get(paneKey('d1', '%1'))?.map((item) => item.id)).toEqual(['a', 'b']);
    expect(grouped.get(paneKey('d2', '%1'))?.map((item) => item.id)).toEqual(['c']);
  });

  test('does not collide when ids concatenate ambiguously', () => {
    const left = session({ id: 'a', deviceId: 'd', paneId: '1%1' });
    const right = session({ id: 'b', deviceId: 'd1', paneId: '%1' });
    const grouped = groupSessionsByPane([left, right]);
    expect(grouped.size).toBe(2);
  });

  test('drops sessions without device or pane', () => {
    const grouped = groupSessionsByPane([
      session({ id: 'a' }),
      session({ id: 'b', deviceId: 'd1' }),
      session({ id: 'c', paneId: '%1' }),
    ]);
    expect(grouped.size).toBe(0);
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
