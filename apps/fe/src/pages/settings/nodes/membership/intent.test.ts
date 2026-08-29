// 跨重启记号：写入、读一次即清、脏值与无 storage 的退化。

import { describe, expect, test } from 'bun:test';
import {
  type IntentStorage,
  SETUP_INTENT_KEY,
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
    writeSetupIntent('join-hub', storage);
    expect(storage.map.get(SETUP_INTENT_KEY)).toBe('join-hub');
    expect(takeSetupIntent(storage)).toBe('join-hub');
    expect(storage.map.has(SETUP_INTENT_KEY)).toBe(false);
    expect(takeSetupIntent(storage)).toBeNull();
  });

  test('become-hub 同样往返', () => {
    const storage = memoryStorage();
    writeSetupIntent('become-hub', storage);
    expect(takeSetupIntent(storage)).toBe('become-hub');
  });

  test('不认识的值当没有，并且照样清掉', () => {
    const storage = memoryStorage({ [SETUP_INTENT_KEY]: 'take-over-the-world' });
    expect(takeSetupIntent(storage)).toBeNull();
    expect(storage.map.has(SETUP_INTENT_KEY)).toBe(false);
  });

  test('clearSetupIntent 只清自己的键', () => {
    const storage = memoryStorage({ [SETUP_INTENT_KEY]: 'join-hub', other: 'keep' });
    clearSetupIntent(storage);
    expect(storage.map.has(SETUP_INTENT_KEY)).toBe(false);
    expect(storage.map.get('other')).toBe('keep');
  });

  test('没有 storage 时不抛', () => {
    expect(() => writeSetupIntent('join-hub', null)).not.toThrow();
    expect(takeSetupIntent(null)).toBeNull();
    expect(() => clearSetupIntent(null)).not.toThrow();
  });

  test('storage 抛异常时不影响调用方', () => {
    expect(() => writeSetupIntent('join-hub', throwingStorage)).not.toThrow();
    expect(takeSetupIntent(throwingStorage)).toBeNull();
    expect(() => clearSetupIntent(throwingStorage)).not.toThrow();
  });
});
