// 跨重启记号：写入、读一次即清、过期、脏值与无 storage 的退化。

import { describe, expect, test } from 'bun:test';
import {
  type IntentStorage,
  SETUP_INTENT_KEY,
  SETUP_INTENT_TTL_MS,
  clearSetupIntent,
  takeSetupIntent,
  writeSetupIntent,
} from './intent';

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

/** 隐私模式 / 配额满：访问 sessionStorage 直接抛。 */
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

describe('setup intent 记号', () => {
  test('写入后读到，并且读一次就清掉', () => {
    const storage = memoryStorage();
    writeSetupIntent({ path: 'join-hub' }, storage, 1000);
    expect(JSON.parse(storage.map.get(SETUP_INTENT_KEY) as string)).toEqual({
      path: 'join-hub',
      at: 1000,
    });
    expect(takeSetupIntent(storage, 1000)).toEqual({ path: 'join-hub' });
    expect(storage.map.has(SETUP_INTENT_KEY)).toBe(false);
    expect(takeSetupIntent(storage)).toBeNull();
  });

  test('become-hub 同样往返', () => {
    const storage = memoryStorage();
    writeSetupIntent({ path: 'become-hub' }, storage);
    expect(takeSetupIntent(storage)).toEqual({ path: 'become-hub' });
  });

  test('join-relay 往返', () => {
    const storage = memoryStorage();
    writeSetupIntent({ path: 'join-relay' }, storage);
    expect(takeSetupIntent(storage)).toEqual({ path: 'join-relay' });
  });

  test('become-relay 连目标角色一起往返', () => {
    for (const role of ['relay', 'relay,node'] as const) {
      const storage = memoryStorage();
      writeSetupIntent({ path: 'become-relay', role }, storage);
      expect(takeSetupIntent(storage)).toEqual({ path: 'become-relay', role });
    }
  });

  test('老记录没有 role 字段照样能读（向后兼容）', () => {
    const storage = memoryStorage({
      [SETUP_INTENT_KEY]: JSON.stringify({ path: 'become-hub', at: 1000 }),
    });
    expect(takeSetupIntent(storage, 1000)).toEqual({ path: 'become-hub' });
  });

  test('role 是脏值时只丢 role，路径照样生效', () => {
    const storage = memoryStorage({
      [SETUP_INTENT_KEY]: JSON.stringify({ path: 'become-relay', at: 1000, role: 'hub,node' }),
    });
    expect(takeSetupIntent(storage, 1000)).toEqual({ path: 'become-relay' });
  });

  test('保质期内读得到，过期就当没有（照样清掉）', () => {
    const fresh = memoryStorage();
    writeSetupIntent({ path: 'join-hub' }, fresh, 0);
    expect(takeSetupIntent(fresh, SETUP_INTENT_TTL_MS)).toEqual({ path: 'join-hub' });

    const stale = memoryStorage();
    writeSetupIntent({ path: 'join-hub' }, stale, 0);
    expect(takeSetupIntent(stale, SETUP_INTENT_TTL_MS + 1)).toBeNull();
    expect(stale.map.has(SETUP_INTENT_KEY)).toBe(false);
  });

  test('写入时刻在未来（时钟回拨）同样不可信', () => {
    const storage = memoryStorage();
    writeSetupIntent({ path: 'become-hub' }, storage, 10_000);
    expect(takeSetupIntent(storage, 9_000)).toBeNull();
  });

  test('不认识的值当没有，并且照样清掉', () => {
    const storage = memoryStorage({ [SETUP_INTENT_KEY]: 'take-over-the-world' });
    expect(takeSetupIntent(storage)).toBeNull();
    expect(storage.map.has(SETUP_INTENT_KEY)).toBe(false);
  });

  test('老格式的裸字符串与缺字段的记录都当没有', () => {
    expect(takeSetupIntent(memoryStorage({ [SETUP_INTENT_KEY]: 'join-hub' }))).toBeNull();
    expect(
      takeSetupIntent(memoryStorage({ [SETUP_INTENT_KEY]: '{"path":"join-hub"}' }))
    ).toBeNull();
    expect(takeSetupIntent(memoryStorage({ [SETUP_INTENT_KEY]: '{"at":1}' }))).toBeNull();
  });

  test('clearSetupIntent 只清自己的键', () => {
    const storage = memoryStorage({ [SETUP_INTENT_KEY]: 'join-hub', other: 'keep' });
    clearSetupIntent(storage);
    expect(storage.map.has(SETUP_INTENT_KEY)).toBe(false);
    expect(storage.map.get('other')).toBe('keep');
  });

  test('没有 storage 时不抛', () => {
    expect(() => writeSetupIntent({ path: 'join-hub' }, null)).not.toThrow();
    expect(takeSetupIntent(null)).toBeNull();
    expect(() => clearSetupIntent(null)).not.toThrow();
  });

  test('storage 抛异常时不影响调用方', () => {
    expect(() => writeSetupIntent({ path: 'join-hub' }, throwingStorage)).not.toThrow();
    expect(takeSetupIntent(throwingStorage)).toBeNull();
    expect(() => clearSetupIntent(throwingStorage)).not.toThrow();
  });
});
