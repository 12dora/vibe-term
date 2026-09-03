import { describe, expect, test } from 'bun:test';
import { createBorshTestWs } from '../test-helpers';
import { SessionStateStore } from './session-state';

describe('SessionStateStore notification throttle TTL prune', () => {
  test('drops stale notification entries and keeps fresh ones', () => {
    let now = 1_000_000;
    const store = new SessionStateStore({
      now: () => now,
      throttlePruneIntervalMs: 1_000,
    });
    const ws = createBorshTestWs();
    store.create(ws);

    expect(store.shouldAllowNotification(ws, 'dev', '%1', 'stale', 2)).toBe(true);
    expect(store.shouldAllowNotification(ws, 'dev', '%1', 'fresh', 10)).toBe(true);

    now = 1_001_500;
    expect(store.shouldAllowNotification(ws, 'dev', '%1', 'fresh', 10)).toBe(false);
    const mid = store.get(ws);
    expect(mid?.notificationThrottles.has('dev:%1:stale')).toBe(true);
    expect(mid?.notificationThrottles.has('dev:%1:fresh')).toBe(true);

    now = 1_003_000;
    expect(store.shouldAllowNotification(ws, 'dev', '%1', 'next', 10)).toBe(true);

    const state = store.get(ws);
    expect(state?.notificationThrottles.has('dev:%1:stale')).toBe(false);
    expect(state?.notificationThrottles.has('dev:%1:fresh')).toBe(true);
    expect(state?.notificationThrottles.has('dev:%1:next')).toBe(true);
  });

  test('raising throttle from 10s to 60s still rejects at 31s', () => {
    let now = 1_000_000;
    const store = new SessionStateStore({
      now: () => now,
      throttlePruneIntervalMs: 1_000,
    });
    const ws = createBorshTestWs();
    store.create(ws);

    expect(store.shouldAllowNotification(ws, 'dev', '%1', 'src', 10)).toBe(true);

    now = 1_000_000 + 31_000;
    expect(store.shouldAllowNotification(ws, 'dev', '%1', 'src', 60)).toBe(false);
  });
});
