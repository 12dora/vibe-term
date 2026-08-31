import { afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { Device } from '@tmex/shared';
import { getSqliteClient } from './client';
import { createDevice } from './devices';
import {
  type FileRootRecord,
  createFileRoot,
  deleteFileRoot,
  getFileRoots,
  reorderFileRoots,
} from './file-roots';
import { runMigrations } from './migrate';

beforeAll(() => {
  runMigrations();
});

const createdRootIds: string[] = [];

afterEach(() => {
  for (const id of createdRootIds) deleteFileRoot(id);
  createdRootIds.length = 0;
});

function makeDevice(id: string): Device {
  const now = new Date().toISOString();
  return {
    id,
    name: id,
    type: 'local',
    session: 'tmex',
    authMode: 'auto',
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function seedRoots(deviceId: string, paths: string[]): FileRootRecord[] {
  createDevice(makeDevice(deviceId));
  const rows = paths.map((path) => createFileRoot({ deviceId, path }));
  createdRootIds.push(...rows.map((row) => row.id));
  return rows;
}

function relativeOrder(ids: readonly string[]): string[] {
  const wanted = new Set(ids);
  return getFileRoots()
    .filter((row) => wanted.has(row.id))
    .map((row) => row.id);
}

describe('reorderFileRoots', () => {
  test('全量重排：按给定顺序写成 0..n-1', () => {
    const roots = seedRoots('g1-fr-full', ['/g1/full/a', '/g1/full/b', '/g1/full/c']);
    const ids = roots.map((row) => row.id);
    expect(relativeOrder(ids)).toEqual(ids);

    expect(reorderFileRoots([ids[2]!, ids[0]!, ids[1]!])).toBe(true);

    const next = getFileRoots().filter((row) => ids.includes(row.id));
    expect(next.map((row) => row.id)).toEqual([ids[2], ids[0], ids[1]]);
    expect(next.map((row) => row.sortOrder)).toEqual([0, 1, 2]);
  });

  test('部分列表：列出的根拿到 0..n-1，未列出的保持相对顺序跟在后面', () => {
    const roots = seedRoots('g1-fr-partial', [
      '/g1/partial/a',
      '/g1/partial/b',
      '/g1/partial/c',
      '/g1/partial/d',
    ]);
    const [a, b, c, d] = roots.map((row) => row.id);

    expect(reorderFileRoots([c!, a!])).toBe(true);

    const mine = getFileRoots().filter((row) => [a, b, c, d].includes(row.id));
    expect(mine.map((row) => row.id)).toEqual([c, a, b, d]);
    expect(mine[0]?.sortOrder).toBe(0);
    expect(mine[1]?.sortOrder).toBe(1);
    expect(mine[1]!.sortOrder).toBeLessThan(mine[2]!.sortOrder);
    expect(mine[2]!.sortOrder).toBeLessThan(mine[3]!.sortOrder);
  });

  test('未知 id 被忽略，不 404，匹配项仍按给定顺序排到前面', () => {
    const roots = seedRoots('g1-fr-unknown', ['/g1/unknown/a', '/g1/unknown/b', '/g1/unknown/c']);
    const [a, b, c] = roots.map((row) => row.id);

    expect(reorderFileRoots(['ghost-root', c!, 'also-ghost', a!])).toBe(true);
    expect(relativeOrder([a!, b!, c!])).toEqual([c, a, b]);
    expect(getFileRoots().find((row) => row.id === c!)?.sortOrder).toBe(0);
    expect(getFileRoots().find((row) => row.id === a!)?.sortOrder).toBe(1);
  });

  test('没有任何 id 命中时不改写，返回 false', () => {
    const roots = seedRoots('g1-fr-nomatch', ['/g1/nomatch/a', '/g1/nomatch/b']);
    const before = roots.map((row) => ({ id: row.id, sortOrder: row.sortOrder }));

    expect(reorderFileRoots(['ghost-a', 'ghost-b'])).toBe(false);
    expect(reorderFileRoots([])).toBe(false);

    const after = getFileRoots()
      .filter((row) => before.some((item) => item.id === row.id))
      .map((row) => ({ id: row.id, sortOrder: row.sortOrder }));
    expect(after).toEqual(before);
  });

  test('在一个事务内改写 sortOrder', () => {
    const roots = seedRoots('g1-fr-tx', ['/g1/tx/a', '/g1/tx/b', '/g1/tx/c']);
    const ids = roots.map((row) => row.id);
    const spy = spyOn(getSqliteClient(), 'transaction');
    try {
      expect(reorderFileRoots([ids[1]!, ids[0]!, ids[2]!])).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(relativeOrder(ids)).toEqual([ids[1], ids[0], ids[2]]);
    } finally {
      spy.mockRestore();
    }
  });
});
