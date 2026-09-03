// 草稿延后落盘：editor 每敲一个键都会 set，同步序列化 + localStorage.setItem 在输入关键路径上。
// 这里既测存储适配器本身，也测经 createUIStore 接上去之后的端到端行为（含刷新与离场 flush）。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createMemoryStorage, installWindowStorage } from './test-utils';
import { createUIStore } from './ui';
import { createDeferredPersistStorage } from './ui-persist';

installWindowStorage();

interface FakeTimers {
  timers: { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void };
  /** 触发所有已武装的定时器 */
  run: () => void;
  armed: () => number;
}

function fakeTimers(): FakeTimers {
  let seq = 0;
  const pending = new Map<number, () => void>();
  return {
    timers: {
      set: (fn) => {
        seq += 1;
        pending.set(seq, fn);
        return seq;
      },
      clear: (handle) => {
        pending.delete(handle as number);
      },
    },
    run: () => {
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) fn();
    },
    armed: () => pending.size,
  };
}

/** 统计 setItem 次数的内存存储 */
function countingStorage(): { storage: Storage; writes: () => number } {
  const inner = createMemoryStorage();
  let writes = 0;
  const storage: Storage = {
    get length() {
      return inner.length;
    },
    clear: () => inner.clear(),
    getItem: (key) => inner.getItem(key),
    key: (index) => inner.key(index),
    removeItem: (key) => inner.removeItem(key),
    setItem: (key, value) => {
      writes += 1;
      inner.setItem(key, value);
    },
  };
  return { storage, writes: () => writes };
}

describe('createDeferredPersistStorage', () => {
  test('只改延后字段时攒到定时器到点才写一次', () => {
    const { storage, writes } = countingStorage();
    const clock = fakeTimers();
    const persisted = createDeferredPersistStorage<{ a: number; drafts: Record<string, string> }>({
      deferredKeys: ['drafts'],
      storage,
      timers: clock.timers,
    });

    const drafts: Record<string, string>[] = [];
    for (let i = 1; i <= 8; i += 1) {
      drafts.push({ 'dev:pane': 'x'.repeat(i) });
    }
    for (const draft of drafts) {
      persisted.storage.setItem('k', { state: { a: 1, drafts: draft }, version: 0 });
    }

    // 第一次写永远立即落盘（没有可比的基线），随后 7 次全部被攒起来
    expect(writes()).toBe(1);
    expect(clock.armed()).toBe(1);

    clock.run();
    expect(writes()).toBe(2);
    expect(JSON.parse(storage.getItem('k') ?? '{}').state.drafts['dev:pane']).toBe('xxxxxxxx');
  });

  test('非延后字段变化立即落盘，并把待写的草稿一起带上', () => {
    const { storage, writes } = countingStorage();
    const clock = fakeTimers();
    const persisted = createDeferredPersistStorage<{ a: number; drafts: Record<string, string> }>({
      deferredKeys: ['drafts'],
      storage,
      timers: clock.timers,
    });

    persisted.storage.setItem('k', { state: { a: 1, drafts: {} }, version: 0 });
    persisted.storage.setItem('k', { state: { a: 1, drafts: { d: 'hi' } }, version: 0 });
    expect(writes()).toBe(1);

    persisted.storage.setItem('k', { state: { a: 2, drafts: { d: 'hi' } }, version: 0 });
    expect(writes()).toBe(2);
    expect(clock.armed()).toBe(0);
    const written = JSON.parse(storage.getItem('k') ?? '{}');
    expect(written.state).toEqual({ a: 2, drafts: { d: 'hi' } });
  });

  test('逐字段同引用时完全跳过写入', () => {
    const { storage, writes } = countingStorage();
    const persisted = createDeferredPersistStorage<{ a: number; drafts: Record<string, string> }>({
      deferredKeys: ['drafts'],
      storage,
      timers: fakeTimers().timers,
    });
    const drafts = {};
    persisted.storage.setItem('k', { state: { a: 1, drafts }, version: 0 });
    persisted.storage.setItem('k', { state: { a: 1, drafts }, version: 0 });
    expect(writes()).toBe(1);
  });

  test('flush 立即落盘尚未写出的草稿', () => {
    const { storage, writes } = countingStorage();
    const clock = fakeTimers();
    const persisted = createDeferredPersistStorage<{ a: number; drafts: Record<string, string> }>({
      deferredKeys: ['drafts'],
      storage,
      timers: clock.timers,
    });

    persisted.storage.setItem('k', { state: { a: 1, drafts: {} }, version: 0 });
    persisted.storage.setItem('k', { state: { a: 1, drafts: { d: 'draft' } }, version: 0 });
    expect(writes()).toBe(1);

    persisted.flush();
    expect(writes()).toBe(2);
    expect(JSON.parse(storage.getItem('k') ?? '{}').state.drafts.d).toBe('draft');

    // 无待写时 flush 无副作用；定时器到点也不会再写一次
    persisted.flush();
    clock.run();
    expect(writes()).toBe(2);
  });
});

describe('UI store 草稿持久化', () => {
  let clock: FakeTimers;
  let counting: ReturnType<typeof countingStorage>;
  let prefix: string;
  let seq = 0;

  beforeEach(() => {
    clock = fakeTimers();
    counting = countingStorage();
    seq += 1;
    prefix = `ui-draft-${seq}-`;
  });

  function createStore() {
    return createUIStore(
      { storagePrefix: prefix },
      { persistStorage: { storage: counting.storage, timers: clock.timers } }
    );
  }

  function persistedDrafts(): Record<string, string> {
    const raw = counting.storage.getItem(`${prefix}tmex-ui`);
    if (!raw) return {};
    return (
      (JSON.parse(raw) as { state?: { editorDrafts?: Record<string, string> } }).state
        ?.editorDrafts ?? {}
    );
  }

  test('连着敲 N 个字符在去抖窗口内最多写一次，窗口后正好再写一次', () => {
    const store = createStore();
    // 先落一次基线（首次写总是立即的）
    store.getState().setEditorDraft('dev:%1', 'a');
    const baseline = counting.writes();

    for (const text of ['ab', 'abc', 'abcd', 'abcde', 'abcdef']) {
      store.getState().setEditorDraft('dev:%1', text);
    }
    expect(counting.writes()).toBe(baseline);

    clock.run();
    expect(counting.writes()).toBe(baseline + 1);
    expect(persistedDrafts()['dev:%1']).toBe('abcdef');
  });

  test('草稿在模拟刷新后仍在', () => {
    const store = createStore();
    store.getState().setEditorDraft('dev:%1', 'draft text');
    clock.run();

    expect(createStore().getState().editorDrafts).toEqual({ 'dev:%1': 'draft text' });
    expect(store.getState().editorDrafts).toEqual({ 'dev:%1': 'draft text' });
  });

  test('其它字段照旧同步落盘，且顺带把草稿写出去', () => {
    const store = createStore();
    store.getState().setEditorDraft('dev:%1', 'pending');
    const before = counting.writes();

    store.getState().setSidebarCollapsed(true);
    expect(counting.writes()).toBe(before + 1);

    const raw = JSON.parse(counting.storage.getItem(`${prefix}tmex-ui`) ?? '{}') as {
      state: { sidebarCollapsed: boolean; editorDrafts: Record<string, string> };
    };
    expect(raw.state.sidebarCollapsed).toBe(true);
    expect(raw.state.editorDrafts).toEqual({ 'dev:%1': 'pending' });
  });

  test('发送后清草稿立即落盘（editorHistory 同时变化）', () => {
    const store = createStore();
    store.getState().setEditorDraft('dev:%1', 'ls -al');
    store.getState().addEditorHistory('ls -al');
    store.getState().removeEditorDraft('dev:%1');
    clock.run();

    expect(createStore().getState().editorDrafts).toEqual({});
  });
});

describe('页面离场时 flush 草稿', () => {
  type Listener = () => void;
  const listeners = new Map<string, Listener[]>();
  let restoreDocument: (() => void) | null = null;
  let restoreWindow: (() => void) | null = null;

  beforeEach(() => {
    listeners.clear();
    const win = globalThis.window as unknown as {
      addEventListener?: (type: string, handler: Listener) => void;
    };
    const originalWindowAdd = win.addEventListener;
    win.addEventListener = (type: string, handler: Listener) => {
      const list = listeners.get(type) ?? [];
      list.push(handler);
      listeners.set(type, list);
    };
    restoreWindow = () => {
      win.addEventListener = originalWindowAdd;
    };
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      writable: true,
      value: {
        visibilityState: 'visible',
        addEventListener: (type: string, handler: Listener) => {
          const list = listeners.get(type) ?? [];
          list.push(handler);
          listeners.set(type, list);
        },
      },
    });
    restoreDocument = () => {
      if (descriptor) Object.defineProperty(globalThis, 'document', descriptor);
      else Reflect.deleteProperty(globalThis, 'document');
    };
  });

  afterEach(() => {
    restoreDocument?.();
    restoreDocument = null;
    restoreWindow?.();
    restoreWindow = null;
  });

  function fire(type: string) {
    for (const handler of listeners.get(type) ?? []) handler();
  }

  test('visibilitychange → hidden 会把待写草稿落盘', () => {
    const clock = fakeTimers();
    const counting = countingStorage();
    const prefix = `ui-draft-hidden-${Date.now()}-`;
    const store = createUIStore(
      { storagePrefix: prefix },
      { persistStorage: { storage: counting.storage, timers: clock.timers } }
    );

    store.getState().setEditorDraft('dev:%1', 'first');
    store.getState().setEditorDraft('dev:%1', 'second');

    (globalThis.document as unknown as { visibilityState: string }).visibilityState = 'visible';
    fire('visibilitychange');
    expect(
      JSON.parse(counting.storage.getItem(`${prefix}tmex-ui`) ?? '{}').state.editorDrafts
    ).toEqual({ 'dev:%1': 'first' });

    (globalThis.document as unknown as { visibilityState: string }).visibilityState = 'hidden';
    fire('visibilitychange');
    expect(
      JSON.parse(counting.storage.getItem(`${prefix}tmex-ui`) ?? '{}').state.editorDrafts
    ).toEqual({ 'dev:%1': 'second' });
  });

  test('pagehide 会把待写草稿落盘', () => {
    const clock = fakeTimers();
    const counting = countingStorage();
    const prefix = `ui-draft-pagehide-${Date.now()}-`;
    const store = createUIStore(
      { storagePrefix: prefix },
      { persistStorage: { storage: counting.storage, timers: clock.timers } }
    );

    store.getState().setEditorDraft('dev:%1', 'first');
    store.getState().setEditorDraft('dev:%1', 'unsaved');

    fire('pagehide');
    expect(
      JSON.parse(counting.storage.getItem(`${prefix}tmex-ui`) ?? '{}').state.editorDrafts
    ).toEqual({ 'dev:%1': 'unsaved' });
  });
});
