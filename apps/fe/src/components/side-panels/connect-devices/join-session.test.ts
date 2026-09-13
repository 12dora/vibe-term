import { afterEach, describe, expect, test } from 'bun:test';
import type { PendingEnrollment } from '@/node/enrollment';
import { createMemoryStorage, installWindowStorage } from '@vibeterm/stores/test-utils';
import {
  ADMITTED_SESSION_TTL_MS,
  type JoinSession,
  isSessionValid,
  readJoinSession,
} from './join-session';

installWindowStorage();

const store = createMemoryStorage();
Object.defineProperty(globalThis, 'sessionStorage', {
  value: store,
  configurable: true,
  writable: true,
});

const LEGACY_KEY = 'tmex.connectDevices.joinSession';
const CURRENT_KEY = 'vibeterm.connectDevices.joinSession';

const SESSION: JoinSession = {
  id: 'e-1',
  enrollPk: 'pk',
  createdAt: 1_700_000_000_000,
  exp: 1_700_000_600_000,
  uid: 'user-1',
  hubNodeId: 'hub-1',
  admitted: false,
  admittedAt: null,
  nodeId: null,
};

const PENDING: PendingEnrollment = {
  hubEnrollmentId: 'e-1',
  enrollPk: 'pk',
  authorizationBytes: 'a',
  authorizationSig: 's',
  exp: 1_700_000_600_000,
  name: null,
  createdAt: 1_700_000_000_000,
};

const IDENTITY = { ready: true, uid: 'user-1', hubNodeId: 'hub-1', nodeIds: null };
const NOW = 1_700_000_100_000;

afterEach(() => {
  store.clear();
});

describe('readJoinSession', () => {
  test('只有旧键：值搬到新键且旧键删除', () => {
    store.setItem(LEGACY_KEY, JSON.stringify(SESSION));
    expect(readJoinSession()).toEqual(SESSION);
    expect(store.getItem(CURRENT_KEY)).toBe(JSON.stringify(SESSION));
    expect(store.getItem(LEGACY_KEY)).toBeNull();
  });

  test('缺 id / enrollPk 或非对象一律丢掉', () => {
    store.setItem(CURRENT_KEY, JSON.stringify({ id: '', enrollPk: 'pk' }));
    expect(readJoinSession()).toBeNull();
    store.setItem(CURRENT_KEY, 'not-json');
    expect(readJoinSession()).toBeNull();
    store.setItem(CURRENT_KEY, JSON.stringify(null));
    expect(readJoinSession()).toBeNull();
  });
});

describe('isSessionValid', () => {
  function check(
    session: JoinSession,
    over: Partial<Parameters<typeof isSessionValid>[1]> = {}
  ): boolean {
    return isSessionValid(session, {
      identity: IDENTITY,
      pendings: [PENDING],
      admittedByEngine: false,
      now: NOW,
      ...over,
    });
  }

  test('未加入：id + enrollPk + createdAt 三样都要对上权威 pending', () => {
    expect(check(SESSION)).toBe(true);
    expect(check({ ...SESSION, enrollPk: 'other' })).toBe(false);
    expect(check(SESSION, { pendings: [] })).toBe(false);
  });

  test('已加入的标记 24 小时后过期', () => {
    const admitted = { ...SESSION, admitted: true, admittedAt: NOW - 60_000 };
    expect(check(admitted, { pendings: [] })).toBe(true);
    expect(
      check({ ...admitted, admittedAt: NOW - ADMITTED_SESSION_TTL_MS - 1 }, { pendings: [] })
    ).toBe(false);
  });
});
