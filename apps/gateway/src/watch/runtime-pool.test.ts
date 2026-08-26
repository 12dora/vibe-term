import { describe, expect, test } from 'bun:test';
import type { StateSnapshotPayload } from '@tmex/shared';
import { type WatchRuntimeLike, WatchRuntimePool } from './runtime-pool';

function createRuntime(
  options: {
    connect?: () => Promise<void>;
    onSubscribe?: () => void;
  } = {}
): WatchRuntimeLike & { close: () => void } {
  let onClose: (() => void) | undefined;
  return {
    connect: options.connect ?? (async () => {}),
    capturePaneText: async () => '',
    subscribe: (listener) => {
      options.onSubscribe?.();
      onClose = listener.onClose;
      listener.onSnapshot?.({} as StateSnapshotPayload);
      return () => {
        onClose = undefined;
      };
    },
    requestSnapshot: () => {},
    close: () => {
      onClose?.();
    },
  };
}

describe('WatchRuntimePool', () => {
  test('同设备多规则只 acquire 一次，最后一条移除时 release', async () => {
    const acquires: string[] = [];
    const releases: string[] = [];
    const runtime = createRuntime();
    const pool = new WatchRuntimePool({
      acquireRuntime: async (deviceId) => {
        acquires.push(deviceId);
        return runtime;
      },
      releaseRuntime: async (deviceId) => {
        releases.push(deviceId);
      },
    });

    const device = pool.addRule('d1', 'r1');
    pool.addRule('d1', 'r2');
    await pool.ensureRuntime(device);
    expect(acquires).toEqual(['d1']);
    expect(pool.lastSnapshot('d1')).not.toBeNull();

    await pool.removeRule('d1', 'r1');
    expect(releases).toEqual([]);
    expect(pool.get('d1')).toBeDefined();

    await pool.removeRule('d1', 'r2');
    expect(releases).toEqual(['d1']);
    expect(pool.get('d1')).toBeUndefined();
  });

  test('连接期间最后一条规则被移除时 release 且不把 runtime 留给已删除分组', async () => {
    const releases: string[] = [];
    const gate: { finish: (() => void) | null } = { finish: null };
    const runtime = createRuntime({
      connect: () =>
        new Promise<void>((resolve) => {
          gate.finish = resolve;
        }),
    });
    const pool = new WatchRuntimePool({
      acquireRuntime: async () => runtime,
      releaseRuntime: async (deviceId) => {
        releases.push(deviceId);
      },
    });

    const device = pool.addRule('d1', 'r1');
    const ensuring = pool.ensureRuntime(device);
    const removing = pool.removeRule('d1', 'r1');
    while (!gate.finish) {
      await Bun.sleep(0);
    }
    gate.finish();
    await expect(ensuring).rejects.toThrow(/were removed/);
    await removing;
    expect(releases).toEqual(['d1']);
    expect(pool.get('d1')).toBeUndefined();
  });

  test('runtime close 释放连接，下次 ensureRuntime 重新 acquire', async () => {
    const acquires: string[] = [];
    const releases: string[] = [];
    const first = createRuntime();
    const second = createRuntime();
    const pool = new WatchRuntimePool({
      acquireRuntime: async () => {
        acquires.push('d1');
        return acquires.length === 1 ? first : second;
      },
      releaseRuntime: async () => {
        releases.push('d1');
      },
    });

    const device = pool.addRule('d1', 'r1');
    await pool.ensureRuntime(device);
    first.close();
    await Bun.sleep(0);
    expect(releases).toEqual(['d1']);
    expect(device.runtime).toBeNull();

    const again = await pool.ensureRuntime(device);
    expect(again).toBe(second);
    expect(acquires).toHaveLength(2);
  });
});
