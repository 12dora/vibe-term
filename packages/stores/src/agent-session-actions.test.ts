import { describe, expect, test } from 'bun:test';

import type { AgentSessionDto } from '@tmex/shared';
import { sortSessionOrder } from './agent-session-actions';

function makeSession(id: string, updatedAt: string): AgentSessionDto {
  return {
    id,
    title: id,
    deviceId: 'd1',
    paneId: '%1',
    providerId: null,
    modelId: 'model',
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
    updatedAt,
  };
}

function toRecord(sessions: AgentSessionDto[]): Record<string, AgentSessionDto | undefined> {
  const map: Record<string, AgentSessionDto | undefined> = {};
  for (const session of sessions) {
    map[session.id] = session;
  }
  return map;
}

describe('sortSessionOrder', () => {
  test('orders by updatedAt descending', () => {
    const order = sortSessionOrder(
      toRecord([
        makeSession('b', '2026-01-02T00:00:00.000Z'),
        makeSession('a', '2026-01-03T00:00:00.000Z'),
        makeSession('c', '2026-01-01T00:00:00.000Z'),
      ])
    );
    expect(order).toEqual(['a', 'b', 'c']);
  });

  test('breaks ties on equal updatedAt by id, independent of insertion order', () => {
    const same = '2026-01-02T00:00:00.000Z';
    const forward = sortSessionOrder(
      toRecord([makeSession('a', same), makeSession('b', same), makeSession('c', same)])
    );
    const reversed = sortSessionOrder(
      toRecord([makeSession('c', same), makeSession('b', same), makeSession('a', same)])
    );

    expect(forward).toEqual(['a', 'b', 'c']);
    expect(reversed).toEqual(['a', 'b', 'c']);
  });

  test('comparator stays antisymmetric for equal timestamps', () => {
    const same = '2026-01-02T00:00:00.000Z';
    const sessions = Array.from({ length: 12 }, (_, index) =>
      makeSession(`s${String(index).padStart(2, '0')}`, same)
    );

    // 洗牌后多次排序必须收敛到同一序列（旧实现在相等时恒返回 -1，结果随插入顺序漂移）
    const shuffled = [...sessions].reverse();
    expect(sortSessionOrder(toRecord(shuffled))).toEqual(sortSessionOrder(toRecord(sessions)));
    expect(sortSessionOrder(toRecord(sessions))).toEqual(sessions.map((session) => session.id));
  });

  test('skips undefined entries', () => {
    const map = toRecord([makeSession('a', '2026-01-02T00:00:00.000Z')]);
    map.gone = undefined;
    expect(sortSessionOrder(map)).toEqual(['a']);
  });
});
