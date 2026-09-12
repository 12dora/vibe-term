import { describe, expect, test } from 'bun:test';
import {
  FOREGROUND_LIVENESS_DRIFT_MS,
  FOREGROUND_LIVENESS_INTERVAL_MS,
  NETWORK_CHANGE_DEBOUNCE_MS,
  type NetworkWakeClock,
  NetworkWakeListeners,
} from './network-wake';

function stubBrowser(options: { online?: boolean; visibility?: string } = {}): {
  setVisibility: (value: string) => void;
  setOnline: (value: boolean) => void;
  visibilitychange: () => void;
  pageshow: () => void;
  online: () => void;
  offline: () => void;
  connectionChange: () => void;
  restore: () => void;
} {
  const docListeners = new Map<string, Set<() => void>>();
  const winListeners = new Map<string, Set<() => void>>();
  const connListeners = new Map<string, Set<() => void>>();
  const bucket = (store: Map<string, Set<() => void>>, type: string) => {
    const existing = store.get(type);
    if (existing) return existing;
    const created = new Set<() => void>();
    store.set(type, created);
    return created;
  };
  const target = (store: Map<string, Set<() => void>>) => ({
    addEventListener(type: string, handler: () => void) {
      bucket(store, type).add(handler);
    },
    removeEventListener(type: string, handler: () => void) {
      bucket(store, type).delete(handler);
    },
  });
  const doc = {
    visibilityState: options.visibility ?? 'visible',
    ...target(docListeners),
  };
  const win = target(winListeners);
  const conn = target(connListeners);
  const nav = { onLine: options.online ?? true, connection: conn };
  const saved = new Map<string, { had: boolean; value: unknown }>();
  const define = (key: string, value: unknown) => {
    saved.set(key, { had: key in globalThis, value: Reflect.get(globalThis, key) });
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  define('document', doc);
  define('window', win);
  define('navigator', nav);

  const fire = (store: Map<string, Set<() => void>>, type: string) => {
    for (const handler of [...(store.get(type) ?? [])]) handler();
  };

  return {
    setVisibility: (value) => {
      doc.visibilityState = value;
    },
    setOnline: (value) => {
      nav.onLine = value;
    },
    visibilitychange: () => fire(docListeners, 'visibilitychange'),
    pageshow: () => fire(winListeners, 'pageshow'),
    online: () => fire(winListeners, 'online'),
    offline: () => fire(winListeners, 'offline'),
    connectionChange: () => fire(connListeners, 'change'),
    restore: () => {
      for (const [key, entry] of saved) {
        if (entry.had) {
          Object.defineProperty(globalThis, key, {
            value: entry.value,
            configurable: true,
            writable: true,
          });
        } else {
          Reflect.deleteProperty(globalThis, key);
        }
      }
    },
  };
}

function fakeClock(): {
  clock: NetworkWakeClock;
  now: number;
  advance(ms: number): void;
  fire(): void;
  intervalCount(): number;
} {
  let now = 10_000;
  const intervals = new Map<number, () => void>();
  let nextId = 1;
  const state = {
    clock: {
      now: () => now,
      setInterval: (handler: () => void, _ms: number) => {
        const id = nextId;
        nextId += 1;
        intervals.set(id, handler);
        return id;
      },
      clearInterval: (id: unknown) => {
        intervals.delete(id as number);
      },
    },
    get now() {
      return now;
    },
    advance(ms: number) {
      now += ms;
    },
    fire() {
      for (const handler of [...intervals.values()]) handler();
    },
    intervalCount: () => intervals.size,
  };
  return state;
}

describe('NetworkWakeListeners', () => {
  test('没有 document 时不启前台定时器（非浏览器宿主仍是空操作）', () => {
    const clock = fakeClock();
    const wakes: number[] = [];
    const listeners = new NetworkWakeListeners(() => {
      wakes.push(1);
    }, clock.clock);
    listeners.install();
    expect(clock.intervalCount()).toBe(0);
    listeners.dispose();
    expect(wakes).toEqual([]);
  });

  test('pageshow 与回前台立即唤醒，不依赖 navigator.connection', () => {
    const browser = stubBrowser();
    const clock = fakeClock();
    try {
      const wakes: string[] = [];
      const listeners = new NetworkWakeListeners(() => {
        wakes.push('wake');
      }, clock.clock);
      listeners.install();
      browser.pageshow();
      browser.setVisibility('hidden');
      browser.visibilitychange();
      browser.setVisibility('visible');
      browser.visibilitychange();
      expect(wakes.length).toBeGreaterThanOrEqual(2);
      listeners.dispose();
    } finally {
      browser.restore();
    }
  });

  test('connection.change 仍去抖', async () => {
    const browser = stubBrowser();
    try {
      const wakes: number[] = [];
      const listeners = new NetworkWakeListeners(() => {
        wakes.push(Date.now());
      });
      listeners.install();
      browser.connectionChange();
      browser.connectionChange();
      expect(wakes).toHaveLength(0);
      await new Promise((resolve) => setTimeout(resolve, NETWORK_CHANGE_DEBOUNCE_MS + 20));
      expect(wakes).toHaveLength(1);
      listeners.dispose();
    } finally {
      browser.restore();
    }
  });

  test('健康的前台节拍不额外唤醒，走常规 PONG', () => {
    const browser = stubBrowser();
    const clock = fakeClock();
    try {
      const wakes: number[] = [];
      const listeners = new NetworkWakeListeners(() => {
        wakes.push(clock.now);
      }, clock.clock);
      listeners.install();
      expect(clock.intervalCount()).toBe(1);
      clock.advance(FOREGROUND_LIVENESS_INTERVAL_MS);
      clock.fire();
      expect(wakes).toEqual([]);
      expect(listeners.suspect).toBe(false);
      listeners.dispose();
    } finally {
      browser.restore();
    }
  });

  test('事件循环被冻过（切网）后进入怀疑态，按 2–3 s 再探直到恢复', () => {
    const browser = stubBrowser();
    const clock = fakeClock();
    try {
      const wakes: number[] = [];
      const listeners = new NetworkWakeListeners(() => {
        wakes.push(clock.now);
      }, clock.clock);
      listeners.install();
      clock.advance(FOREGROUND_LIVENESS_INTERVAL_MS + FOREGROUND_LIVENESS_DRIFT_MS);
      clock.fire();
      expect(listeners.suspect).toBe(true);
      expect(wakes).toHaveLength(1);

      clock.advance(FOREGROUND_LIVENESS_INTERVAL_MS);
      clock.fire();
      expect(listeners.suspect).toBe(false);
      expect(wakes).toHaveLength(2);
      listeners.dispose();
    } finally {
      browser.restore();
    }
  });

  test('offline 标成怀疑态；恢复后一次探测即停', () => {
    const browser = stubBrowser();
    const clock = fakeClock();
    try {
      const wakes: number[] = [];
      const listeners = new NetworkWakeListeners(() => {
        wakes.push(clock.now);
      }, clock.clock);
      listeners.install();
      browser.setOnline(false);
      browser.offline();
      expect(listeners.suspect).toBe(true);
      expect(wakes).toHaveLength(1);

      clock.advance(FOREGROUND_LIVENESS_INTERVAL_MS);
      clock.fire();
      expect(wakes).toHaveLength(2);
      expect(listeners.suspect).toBe(true);

      browser.setOnline(true);
      clock.advance(FOREGROUND_LIVENESS_INTERVAL_MS);
      clock.fire();
      expect(wakes).toHaveLength(3);
      expect(listeners.suspect).toBe(false);
      listeners.dispose();
    } finally {
      browser.restore();
    }
  });

  test('转入后台停掉前台节拍，回前台再武装', () => {
    const browser = stubBrowser();
    const clock = fakeClock();
    try {
      const listeners = new NetworkWakeListeners(() => {}, clock.clock);
      listeners.install();
      expect(clock.intervalCount()).toBe(1);
      browser.setVisibility('hidden');
      browser.visibilitychange();
      expect(clock.intervalCount()).toBe(0);
      browser.setVisibility('visible');
      browser.visibilitychange();
      expect(clock.intervalCount()).toBe(1);
      listeners.dispose();
    } finally {
      browser.restore();
    }
  });
});
