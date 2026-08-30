// 流式 delta flush 不应触发同步的 localStorage 写：persist 的两个偏好字段没变就不落盘。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { noopNotificationSink } from '@tmex/notifications';

import { createAgentStore } from './agent';
import { createAgentDeltaBuffer } from './agent-delta-buffer';
import type { AgentDataSetState } from './agent-state';
import type { RuntimeCore } from './runtime';
import { createMemoryStorage } from './test-utils';

const FLUSHES = 100;

let writes = 0;
let restore: (() => void) | null = null;

function installCountingStorage(): void {
  const memory = createMemoryStorage();
  const counting: Storage = {
    get length() {
      return memory.length;
    },
    clear: () => memory.clear(),
    getItem: (key) => memory.getItem(key),
    key: (index) => memory.key(index),
    removeItem: (key) => memory.removeItem(key),
    setItem: (key, value) => {
      writes += 1;
      memory.setItem(key, value);
    },
  };
  const localStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const win = (globalThis.window ?? {}) as Window & typeof globalThis;
  const previousWindowStorage = win.localStorage;
  (win as unknown as { localStorage: Storage }).localStorage = counting;
  Object.defineProperty(globalThis, 'localStorage', { value: counting, configurable: true });
  Object.defineProperty(globalThis, 'window', { value: win, configurable: true });

  restore = () => {
    (win as unknown as { localStorage: Storage | undefined }).localStorage = previousWindowStorage;
    if (localStorageDescriptor) {
      Object.defineProperty(globalThis, 'localStorage', localStorageDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'localStorage');
    }
    if (windowDescriptor) {
      Object.defineProperty(globalThis, 'window', windowDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  };
}

function fakeCore(): RuntimeCore {
  return {
    client: { send: () => {}, connect: () => {}, onMessage: () => () => {} },
    apiClient: {},
    notifications: noopNotificationSink,
    t: (key: string) => key,
    storagePrefix: 'persist-gate-test-',
  } as unknown as RuntimeCore;
}

beforeEach(() => {
  writes = 0;
  installCountingStorage();
});

afterEach(() => {
  restore?.();
  restore = null;
});

describe('agent persist 写盘门控', () => {
  test('100 次 delta flush 不产生任何 setItem', () => {
    const store = createAgentStore(fakeCore());
    store.setState({ activeSessionIdByNode: { self: 's1' } });
    const baseline = writes;
    expect(baseline).toBeGreaterThan(0);

    const deltas = createAgentDeltaBuffer(store.setState as unknown as AgentDataSetState);
    for (let i = 0; i < FLUSHES; i += 1) {
      deltas.append('s1', 'texts', 'm1', `chunk-${i} `);
      deltas.flush();
    }

    expect(store.getState().inProgress.s1?.texts[0]?.text).toContain(`chunk-${FLUSHES - 1}`);
    expect(writes).toBe(baseline);
  });

  test('持久化字段真的变化时仍会落盘', () => {
    const store = createAgentStore(fakeCore());
    const before = writes;
    store.getState().setDefaultWriteMode('auto');
    expect(writes).toBe(before + 1);

    // 同值再设一次不重复写
    store.getState().setDefaultWriteMode('auto');
    expect(writes).toBe(before + 1);

    expect(localStorage.getItem('persist-gate-test-tmex-agent')).toContain('"auto"');
  });
});
