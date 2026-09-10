// chunk 刷新逃生通道：握手 → 刷新，且每会话至多一次；握手失败也必须照常刷新。

import { describe, expect, test } from 'bun:test';
import { type ChunkReloadDeps, reloadForNewChunks } from './sw-reload';

function harness(overrides: Partial<ChunkReloadDeps> = {}) {
  const state = { activated: 0, reloads: 0, guard: null as string | null, order: [] as string[] };
  const deps: ChunkReloadDeps = {
    activate: async () => {
      state.activated += 1;
      state.order.push('activate');
    },
    reload: () => {
      state.reloads += 1;
      state.order.push('reload');
    },
    readGuard: () => state.guard,
    writeGuard: () => {
      state.guard = '1';
    },
    ...overrides,
  };
  return { deps, state };
}

describe('reloadForNewChunks', () => {
  test('先握手让 waiting 接管，再刷新', async () => {
    const h = harness();
    expect(await reloadForNewChunks(h.deps)).toBe(true);
    expect(h.state.order).toEqual(['activate', 'reload']);
    expect(h.state.guard).toBe('1');
  });

  test('本会话至多刷新一次（新版本也 404 时不许无限刷新）', async () => {
    const h = harness();
    expect(await reloadForNewChunks(h.deps)).toBe(true);
    expect(await reloadForNewChunks(h.deps)).toBe(false);
    expect(h.state.reloads).toBe(1);
    expect(h.state.activated).toBe(1);
  });

  test('握手抛错也照常刷新', async () => {
    const h = harness({ activate: () => Promise.reject(new Error('nope')) });
    expect(await reloadForNewChunks(h.deps)).toBe(true);
    expect(h.state.reloads).toBe(1);
  });
});
