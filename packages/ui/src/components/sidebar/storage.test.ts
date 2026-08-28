import { afterEach, describe, expect, it } from 'bun:test';
import { readSidebarStorage, removeSidebarStorage, writeSidebarStorage } from './storage';

const globals = globalThis as { window?: unknown };
const originalWindow = globals.window;

function installStorage(storage: unknown): void {
  globals.window = { localStorage: storage };
}

function throwingStorage(): Storage {
  const deny = () => {
    throw new DOMException('denied', 'SecurityError');
  };
  return {
    get length(): number {
      return deny();
    },
    clear: deny,
    getItem: deny,
    key: deny,
    removeItem: deny,
    setItem: deny,
  } as unknown as Storage;
}

afterEach(() => {
  globals.window = originalWindow;
});

describe('sidebar storage helpers', () => {
  it('读写正常时透传', () => {
    const values = new Map<string, string>([['a', '1']]);
    installStorage({
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });

    expect(readSidebarStorage('a')).toBe('1');
    writeSidebarStorage('a', '2');
    expect(readSidebarStorage('a')).toBe('2');
    removeSidebarStorage('a');
    expect(readSidebarStorage('a')).toBeNull();
  });

  it('storage 抛 SecurityError 时降级而不抛出', () => {
    installStorage(throwingStorage());

    expect(readSidebarStorage('a')).toBeNull();
    expect(() => writeSidebarStorage('a', '1')).not.toThrow();
    expect(() => removeSidebarStorage('a')).not.toThrow();
  });
});
