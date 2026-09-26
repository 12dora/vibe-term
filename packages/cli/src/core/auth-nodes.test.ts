import { describe, expect, test } from 'bun:test';
import type { MeshNode } from '@vibeterm/api-client/auth/types';
import { SELF_NODE_ID } from '@vibeterm/api-client/node-url';
import { MIN_LOGIN_RECORDS_VERSION } from '@vibeterm/shared';
import { authFanoutExit, planAuthTargets, versionTooOld } from './auth-nodes';

function node(partial: Partial<MeshNode> & { id: string; name: string }): MeshNode {
  return {
    publicKey: 'pk',
    online: true,
    reach: 'lan',
    version: '2.10.0',
    direct_capable: true,
    loggedIn: true,
    ...partial,
  };
}

describe('versionTooOld', () => {
  test('only versions below 2.10.0 are too old', () => {
    expect(versionTooOld('2.9.9', MIN_LOGIN_RECORDS_VERSION)).toBe(true);
    expect(versionTooOld('2.10.0', MIN_LOGIN_RECORDS_VERSION)).toBe(false);
    expect(versionTooOld('2.11.0', MIN_LOGIN_RECORDS_VERSION)).toBe(false);
    expect(versionTooOld(null, MIN_LOGIN_RECORDS_VERSION)).toBe(false);
    expect(versionTooOld('2.10.0_dev', MIN_LOGIN_RECORDS_VERSION)).toBe(false);
  });
});

describe('planAuthTargets', () => {
  const entry = 'a'.repeat(32);

  test('an empty roster is just the entry', () => {
    expect(
      planAuthTargets({ roster: [], entryId: null, explicit: null, minVersion: '2.10.0' }).targets
    ).toEqual([{ nodeId: SELF_NODE_ID, name: 'self' }]);
  });

  test('skips offline and too-old peers and routes the entry as self', () => {
    const plan = planAuthTargets({
      roster: [
        node({ id: entry, name: 'office' }),
        node({ id: 'b'.repeat(32), name: 'jp' }),
        node({ id: 'c'.repeat(32), name: 'legacy', version: '2.9.0' }),
        node({ id: 'd'.repeat(32), name: 'down', online: false }),
      ],
      entryId: entry,
      explicit: null,
      minVersion: '2.10.0',
    });
    expect(plan.targets.map((row) => row.name)).toEqual(['office', 'jp']);
    expect(plan.targets[0]?.nodeId).toBe(SELF_NODE_ID);
    expect(plan.skipped.map((row) => row.reason)).toEqual(['too-old', 'offline']);
  });

  test('an explicit offline node is a skip, not a call', () => {
    const plan = planAuthTargets({
      roster: [],
      entryId: entry,
      explicit: {
        nodeId: 'd'.repeat(32),
        name: 'down',
        row: node({ id: 'd'.repeat(32), name: 'down', online: false }),
      },
      minVersion: '2.10.0',
    });
    expect(plan.targets).toEqual([]);
    expect(plan.skipped[0]?.reason).toBe('offline');
  });
});

describe('authFanoutExit', () => {
  test('follows login: fan-out skips are 0, a named outage is 5, auth is 3', () => {
    expect(authFanoutExit({ explicit: false, skipped: [], failures: [], successes: 1 })).toBe(0);
    expect(
      authFanoutExit({
        explicit: false,
        skipped: [{ nodeId: 'n', name: 'a', reason: 'offline', detail: 'offline' }],
        failures: [],
        successes: 0,
      })
    ).toBe(0);
    expect(
      authFanoutExit({
        explicit: true,
        skipped: [{ nodeId: 'n', name: 'a', reason: 'unreachable', detail: 'unreachable' }],
        failures: [],
        successes: 0,
      })
    ).toBe(5);
    expect(
      authFanoutExit({
        explicit: true,
        skipped: [{ nodeId: 'n', name: 'a', reason: 'too-old', detail: 'old' }],
        failures: [],
        successes: 0,
      })
    ).toBe(1);
    expect(
      authFanoutExit({
        explicit: false,
        skipped: [],
        failures: [{ nodeId: 'n', name: 'a', kind: 'auth', message: 'login' }],
        successes: 1,
      })
    ).toBe(3);
  });
});
