import { afterEach, describe, expect, test } from 'bun:test';
import type { Device } from '@vibeterm/shared';
import { type DeviceSource, resolveExecDevice } from './device-resolve';
import {
  closeExecSessionsForToken,
  closeExecSessionsForUser,
  generateSessionId,
  liveSessionCount,
  resetExecRegistryForTests,
} from './registry';
import { LOCAL_DEVICE, makeEnv, openSession } from './test-harness';

afterEach(() => resetExecRegistryForTests());

describe('registry', () => {
  test('closes sessions per token and per user', async () => {
    const env = makeEnv();
    const a = await openSession(env, {}, { uid: 'u1', tokenId: 't1' });
    const b = await openSession(env, {}, { uid: 'u1', tokenId: 't2' });
    const c = await openSession(env, {}, { uid: 'u2', tokenId: null });
    closeExecSessionsForToken('t1');
    expect(a.proc.killCount).toBe(1);
    expect(a.client.transport.closed?.code).toBe(4401);
    expect(b.proc.killCount).toBe(0);
    expect(liveSessionCount()).toBe(2);
    closeExecSessionsForUser('u1');
    expect(b.proc.killCount).toBe(1);
    expect(c.proc.killCount).toBe(0);
    expect(liveSessionCount()).toBe(1);
    resetExecRegistryForTests();
    expect(c.proc.killCount).toBe(1);
    expect(liveSessionCount()).toBe(0);
  });

  test('session ids are 32 lowercase hex and unique', () => {
    const ids = new Set(Array.from({ length: 50 }, generateSessionId));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('resolveExecDevice', () => {
  const device = (id: string, name: string, type: 'local' | 'ssh'): Device => ({
    ...LOCAL_DEVICE,
    id,
    name,
    type,
  });
  const all = [
    device('d1', 'Build Box', 'ssh'),
    device('d2', 'Laptop', 'local'),
    device('d3', 'laptop', 'local'),
  ];
  const source: DeviceSource = {
    getById: (id) => all.find((d) => d.id === id) ?? null,
    getAll: () => all,
  };

  test('id wins, then exact name, then case-insensitive name', () => {
    expect(resolveExecDevice('d1', source)?.id).toBe('d1');
    expect(resolveExecDevice('laptop', source)?.id).toBe('d3');
    expect(resolveExecDevice('LAPTOP', source)?.id).toBe('d2');
    expect(resolveExecDevice('build box', source)?.id).toBe('d1');
    expect(resolveExecDevice('nope', source)).toBeNull();
  });

  test('omitted reference picks the first local device', () => {
    expect(resolveExecDevice(undefined, source)?.id).toBe('d2');
    expect(
      resolveExecDevice(undefined, { getById: () => null, getAll: () => [all[0] as Device] })
    ).toBeNull();
  });
});
