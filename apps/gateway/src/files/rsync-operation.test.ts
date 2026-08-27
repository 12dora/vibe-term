import { describe, expect, test } from 'bun:test';
import type { Device } from '@tmex/shared';
import { fail, ok, withDeviceRsync } from './rsync-operation';
import { RsyncAuthError, type RsyncDeviceSpec } from './ssh-command';

function localDevice(id = 'rsync-op-local'): Device {
  return {
    id,
    name: 'local',
    type: 'local',
    authMode: 'auto',
    sortOrder: 0,
    createdAt: '',
    updatedAt: '',
  };
}

describe('withDeviceRsync', () => {
  test('queue → spec → op → cleanup order is preserved', async () => {
    const events: string[] = [];
    const result = await withDeviceRsync(
      localDevice(),
      async () => {
        events.push('op');
        return ok(42);
      },
      {
        enqueue: async (_deviceId, job) => {
          events.push('queue');
          return job();
        },
        buildSpec: async () => {
          events.push('spec');
          return {
            targetPrefix: '',
            rsh: undefined,
            env: {},
            cleanup: () => {
              events.push('cleanup');
            },
          };
        },
      }
    );

    expect(result).toEqual({ ok: true, data: 42 });
    expect(events).toEqual(['queue', 'spec', 'op', 'cleanup']);
  });

  test('cleans up the spec when the operation throws', async () => {
    const events: string[] = [];
    await expect(
      withDeviceRsync(
        localDevice(),
        async () => {
          throw new Error('boom');
        },
        {
          enqueue: async (_deviceId, job) => job(),
          buildSpec: async () => ({
            targetPrefix: '',
            rsh: undefined,
            env: {},
            cleanup: () => {
              events.push('cleanup');
            },
          }),
        }
      )
    ).rejects.toThrow('boom');
    expect(events).toEqual(['cleanup']);
  });

  test('maps RsyncAuthError to a fail result without running the op', async () => {
    let ran = false;
    const result = await withDeviceRsync(
      localDevice(),
      async () => {
        ran = true;
        return ok(true);
      },
      {
        enqueue: async (_deviceId, job) => job(),
        buildSpec: async () => {
          throw new RsyncAuthError('auth_unsupported', 'no auth');
        },
      }
    );

    expect(ran).toBe(false);
    expect(result).toEqual({ ok: false, code: 'auth_unsupported', detail: 'no auth' });
  });

  test('reuses the real local spec path and still cleans up', async () => {
    const specRef: { current: RsyncDeviceSpec | null } = { current: null };
    let cleaned = false;
    const result = await withDeviceRsync(localDevice('rsync-op-real'), async (spec) => {
      specRef.current = spec;
      const original = spec.cleanup;
      spec.cleanup = () => {
        cleaned = true;
        original();
      };
      return fail('not_found');
    });
    expect(result).toEqual({ ok: false, code: 'not_found' });
    expect(specRef.current?.targetPrefix).toBe('');
    expect(cleaned).toBe(true);
  });
});
