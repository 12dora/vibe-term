// 「重启后提示接入本机中继」记号：写入、读一次即清、过期、脏值与无 storage 的退化。

import { describe, expect, test } from 'bun:test';
import type { IntentStorage } from '../membership/intent';
import {
  SELF_RELAY_FOLLOW_UP_KEY,
  SELF_RELAY_FOLLOW_UP_PATH,
  SELF_RELAY_FOLLOW_UP_TTL_MS,
  takeSelfRelayFollowUp,
  writeSelfRelayFollowUp,
} from './self-relay-followup';

function memoryStorage(initial: Record<string, string> = {}): IntentStorage & {
  map: Map<string, string>;
} {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

const throwingStorage: IntentStorage = {
  getItem: () => {
    throw new Error('denied');
  },
  setItem: () => {
    throw new Error('denied');
  },
  removeItem: () => {
    throw new Error('denied');
  },
};

describe('self relay follow-up 记号', () => {
  test('写入后读到，并且读一次就清掉', () => {
    const storage = memoryStorage();
    writeSelfRelayFollowUp(storage, 1000);
    expect(JSON.parse(storage.map.get(SELF_RELAY_FOLLOW_UP_KEY) as string)).toEqual({
      path: SELF_RELAY_FOLLOW_UP_PATH,
      at: 1000,
    });
    expect(takeSelfRelayFollowUp(storage, 1000)).toBe(true);
    expect(storage.map.has(SELF_RELAY_FOLLOW_UP_KEY)).toBe(false);
    expect(takeSelfRelayFollowUp(storage, 1000)).toBe(false);
  });

  test('保质期内有效，过期当没有', () => {
    const fresh = memoryStorage();
    writeSelfRelayFollowUp(fresh, 0);
    expect(takeSelfRelayFollowUp(fresh, SELF_RELAY_FOLLOW_UP_TTL_MS)).toBe(true);

    const stale = memoryStorage();
    writeSelfRelayFollowUp(stale, 0);
    expect(takeSelfRelayFollowUp(stale, SELF_RELAY_FOLLOW_UP_TTL_MS + 1)).toBe(false);
  });

  test('时钟回拨同样不可信', () => {
    const storage = memoryStorage();
    writeSelfRelayFollowUp(storage, 10_000);
    expect(takeSelfRelayFollowUp(storage, 9_000)).toBe(false);
  });

  test('脏值当没有', () => {
    expect(takeSelfRelayFollowUp(memoryStorage({ [SELF_RELAY_FOLLOW_UP_KEY]: 'yes' }))).toBe(false);
    expect(takeSelfRelayFollowUp(memoryStorage({ [SELF_RELAY_FOLLOW_UP_KEY]: '{}' }))).toBe(false);
    // 别人往同一个键里写了别的路径：不是我们的记号。
    expect(
      takeSelfRelayFollowUp(
        memoryStorage({ [SELF_RELAY_FOLLOW_UP_KEY]: '{"path":"become-hub","at":1}' }),
        1
      )
    ).toBe(false);
  });

  test('没有 storage / storage 抛异常都不影响调用方', () => {
    expect(() => writeSelfRelayFollowUp(null)).not.toThrow();
    expect(takeSelfRelayFollowUp(null)).toBe(false);
    expect(() => writeSelfRelayFollowUp(throwingStorage)).not.toThrow();
    expect(takeSelfRelayFollowUp(throwingStorage)).toBe(false);
  });
});
