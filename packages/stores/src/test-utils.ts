// 测试专用工具：bun test 跑在无 DOM 的 node 环境，而 zustand persist 读 window.localStorage、
// site.ts 读 window.location.origin，各测试文件此前各自复制一份内存 Storage 与全局装配。

const DEFAULT_ORIGIN = 'http://localhost:9663';

export function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length(): number {
      return values.size;
    },
    clear(): void {
      values.clear();
    },
    getItem(key: string): string | null {
      return values.get(key) ?? null;
    },
    key(index: number): string | null {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key: string): void {
      values.delete(key);
    },
    setItem(key: string, value: string): void {
      values.set(key, value);
    },
  };
}

function defineGlobal(key: 'localStorage' | 'window', value: unknown): void {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

function restoreGlobal(key: 'localStorage' | 'window', descriptor?: PropertyDescriptor): void {
  if (descriptor) {
    Object.defineProperty(globalThis, key, descriptor);
  } else {
    Reflect.deleteProperty(globalThis, key);
  }
}

/**
 * 装上内存 localStorage 与最小 window 垫片（已存在则复用，避免与先加载的测试文件抢占同一份存储）。
 * 返回还原函数，供需要隔离全局的用例在 afterEach 中调用。
 */
export function installWindowStorage(): () => void {
  const localStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');

  const storage = (globalThis.localStorage as Storage | undefined) ?? createMemoryStorage();
  const win = (globalThis.window ?? {}) as Window & typeof globalThis;
  (win as unknown as { localStorage: Storage }).localStorage = storage;
  if (!win.location) {
    (win as unknown as { location: { origin: string } }).location = { origin: DEFAULT_ORIGIN };
  }

  defineGlobal('localStorage', storage);
  defineGlobal('window', win);

  return () => {
    restoreGlobal('localStorage', localStorageDescriptor);
    restoreGlobal('window', windowDescriptor);
  };
}
