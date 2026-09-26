import { describe, expect, test } from 'bun:test';
import { ApiError } from '@vibeterm/api-client';
import {
  classifyLoginHistoryError,
  isTooOldForLoginRecords,
  planLoginHistoryNodes,
} from './login-history-nodes';

const ENTRY = 'a'.repeat(32);
const B = 'b'.repeat(32);
const C = 'c'.repeat(32);
const D = 'd'.repeat(32);
const E = 'e'.repeat(32);
const F = 'f'.repeat(32);

function node(id: string, name: string, extra: Record<string, unknown> = {}) {
  return { id, name, online: true, loggedIn: true, version: '2.10.0', ...extra };
}

describe('planLoginHistoryNodes', () => {
  test('entry first as self, others split by skip reason', () => {
    const plan = planLoginHistoryNodes(
      [
        node(B, 'beta'),
        node(ENTRY, 'home', { version: '2.9.0' }),
        node(C, 'gamma', { online: false }),
        node(D, 'delta', { version: '2.9.0' }),
        node(E, 'eps', { loggedIn: false }),
        node(F, 'phi', { paused: true }),
      ],
      ENTRY,
      '本机',
      '2.10.0'
    );
    expect(plan.targets.map((item) => [item.id, item.isSelf])).toEqual([
      ['self', true],
      [B, false],
    ]);
    expect(plan.targets[0].meshId).toBe(ENTRY);
    expect(Object.fromEntries(plan.skipped.map((item) => [item.node.name, item.reason]))).toEqual({
      gamma: 'offline',
      delta: 'tooOld',
      eps: 'loginRequired',
      phi: 'paused',
    });
  });

  test('unknown version is attempted, not skipped', () => {
    const plan = planLoginHistoryNodes(
      [node(B, 'beta', { version: null })],
      ENTRY,
      '本机',
      '2.10.0'
    );
    expect(plan.targets.map((item) => item.id)).toEqual([B]);
  });

  test('no mesh list → self only', () => {
    const plan = planLoginHistoryNodes([], null, '本机', '2.10.0');
    expect(plan).toEqual({
      targets: [{ id: 'self', meshId: 'self', name: '本机', isSelf: true }],
      skipped: [],
    });
  });
});

describe('isTooOldForLoginRecords', () => {
  test('compares semver', () => {
    expect(isTooOldForLoginRecords('2.9.9', '2.10.0')).toBe(true);
    expect(isTooOldForLoginRecords('2.10.0', '2.10.0')).toBe(false);
    expect(isTooOldForLoginRecords(null, '2.10.0')).toBe(false);
  });
});

describe('classifyLoginHistoryError', () => {
  test('maps forwarder envelopes and old nodes', () => {
    expect(classifyLoginHistoryError(new ApiError(503, 'x', { code: 'NODE_UNREACHABLE' }))).toBe(
      'offline'
    );
    expect(classifyLoginHistoryError(new ApiError(401, 'x', { code: 'NODE_LOGIN_REQUIRED' }))).toBe(
      'loginRequired'
    );
    expect(classifyLoginHistoryError(new ApiError(404, 'route_not_found'))).toBe('tooOld');
    expect(classifyLoginHistoryError(new ApiError(500, 'boom'))).toBe('failed');
    expect(classifyLoginHistoryError(new Error('network'))).toBe('failed');
  });
});
