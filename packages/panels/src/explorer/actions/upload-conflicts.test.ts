import { describe, expect, test } from 'bun:test';
import type { FolderUploadFile } from './folder-upload';
import {
  type ConflictProbeIo,
  type DirProbe,
  UPLOAD_CONFLICT_PROBE_LIMIT,
  conflictDisplayName,
  planUploadConflicts,
  probeExistingNames,
} from './upload-conflicts';

function item(relDir: string, name: string): FolderUploadFile {
  return { file: { name, size: 1 } as unknown as File, relDir };
}

const names = (items: readonly FolderUploadFile[]) => items.map(conflictDisplayName);

interface FakeTree {
  io: ConflictProbeIo;
  listed: string[];
  statted: string[];
}

/** `dirs`：相对目录 → 列表结果；没列出的目录一律 missing */
function fakeTree(
  dirs: Record<string, DirProbe>,
  existing: readonly string[] = [],
  limit?: number
): FakeTree {
  const listed: string[] = [];
  const statted: string[] = [];
  return {
    listed,
    statted,
    io: {
      limit,
      list: async (relDir) => {
        listed.push(relDir);
        return dirs[relDir] ?? 'missing';
      },
      exists: async (relDir, name) => {
        const key = relDir ? `${relDir}/${name}` : name;
        statted.push(key);
        return existing.includes(key);
      },
    },
  };
}

const full = (...entries: string[]): DirProbe => ({ names: entries, truncated: false });

describe('planUploadConflicts', () => {
  test('splits by the existing names of each file own directory', () => {
    const files = [
      item('', 'a.txt'),
      item('', 'b.txt'),
      item('photos', 'a.jpg'),
      item('docs', 'a'),
    ];
    const existing = new Map([
      ['', new Set(['a.txt', 'photos'])],
      ['photos', new Set(['a.jpg'])],
    ]);
    const plan = planUploadConflicts(files, existing);
    expect(names(plan.conflicts)).toEqual(['a.txt', 'photos/a.jpg']);
    expect(names(plan.clean)).toEqual(['b.txt', 'docs/a']);
  });

  test('a name only collides inside its own directory', () => {
    const plan = planUploadConflicts([item('sub', 'a.txt')], new Map([['', new Set(['a.txt'])]]));
    expect(plan.conflicts).toEqual([]);
    expect(names(plan.clean)).toEqual(['sub/a.txt']);
  });

  test('no known listing means no known conflict', () => {
    const plan = planUploadConflicts([item('', 'a')], new Map());
    expect(plan.conflicts).toEqual([]);
    expect(plan.clean).toHaveLength(1);
  });
});

describe('probeExistingNames', () => {
  test('flat upload lists the destination once', async () => {
    const tree = fakeTree({ '': full('a.txt', 'z') });
    const existing = await probeExistingNames(
      { files: [item('', 'a.txt'), item('', 'b.txt')], dirs: [] },
      tree.io
    );
    expect(tree.listed).toEqual(['']);
    expect(existing.get('')?.has('a.txt')).toBe(true);
    expect(existing.get('')?.has('b.txt')).toBe(false);
  });

  test('merging into an existing folder probes that folder', async () => {
    const tree = fakeTree({ '': full('photos'), photos: full('a.jpg') });
    const plan = { files: [item('photos', 'a.jpg'), item('photos', 'b.jpg')], dirs: ['photos'] };
    const existing = await probeExistingNames(plan, tree.io);
    expect(tree.listed).toEqual(['', 'photos']);
    expect(names(planUploadConflicts(plan.files, existing).conflicts)).toEqual(['photos/a.jpg']);
  });

  test('a brand-new folder tree costs one request for the destination', async () => {
    const tree = fakeTree({ '': full('other') });
    const plan = {
      files: [item('top/a', 'x'), item('top/b', 'y'), item('top/b/c', 'z')],
      dirs: ['top', 'top/a', 'top/b', 'top/b/c'],
    };
    const existing = await probeExistingNames(plan, tree.io);
    expect(tree.listed).toEqual(['']);
    expect(planUploadConflicts(plan.files, existing).conflicts).toEqual([]);
  });

  test('a folder absent from its parent listing is never requested', async () => {
    const tree = fakeTree({ '': full('other') });
    const plan = {
      files: [item('', 'top'), item('new', 'a'), item('new/deep', 'b')],
      dirs: ['new', 'new/deep'],
    };
    const existing = await probeExistingNames(plan, tree.io);
    expect(tree.listed).toEqual(['']);
    expect(existing.get('new')?.size).toBe(0);
    expect(existing.get('new/deep')?.size).toBe(0);
  });

  test('a missing directory has no conflicts and prunes its subtree', async () => {
    // 目标目录的列表没查到（unknown）→ 只能逐个目录去问
    const tree = fakeTree({ '': 'unknown' });
    const plan = { files: [item('a', 'x'), item('a/b', 'y')], dirs: ['a', 'a/b'] };
    const existing = await probeExistingNames(plan, tree.io);
    expect(tree.listed).toEqual(['', 'a']);
    expect(existing.get('a')?.size).toBe(0);
    expect(existing.get('a/b')?.size).toBe(0);
  });

  test('an unknown listing does not prune children', async () => {
    const tree = fakeTree({ '': full('a'), a: 'unknown', 'a/b': full('y') });
    const plan = { files: [item('a', 'x'), item('a/b', 'y')], dirs: ['a', 'a/b'] };
    const existing = await probeExistingNames(plan, tree.io);
    expect(tree.listed).toEqual(['', 'a', 'a/b']);
    expect(existing.get('a')?.size).toBe(0);
    expect(existing.get('a/b')?.has('y')).toBe(true);
  });

  test('a rejected listing is treated as unknown', async () => {
    const io: ConflictProbeIo = {
      list: () => Promise.reject(new Error('offline')),
      exists: () => Promise.reject(new Error('offline')),
    };
    const existing = await probeExistingNames({ files: [item('', 'a')], dirs: [] }, io);
    expect(existing.get('')?.size).toBe(0);
  });

  test('truncated listing: names not in it are confirmed one by one', async () => {
    const tree = fakeTree({ '': { names: ['seen'], truncated: true } }, ['hidden']);
    const files = [item('', 'seen'), item('', 'hidden'), item('', 'fresh')];
    const existing = await probeExistingNames({ files, dirs: [] }, tree.io);
    expect(tree.statted.sort()).toEqual(['fresh', 'hidden']);
    expect(names(planUploadConflicts(files, existing).conflicts)).toEqual(['seen', 'hidden']);
  });

  test('a truncated parent listing cannot prove a child is missing', async () => {
    const tree = fakeTree({ '': { names: [], truncated: true }, photos: full('a.jpg') });
    const plan = { files: [item('photos', 'a.jpg')], dirs: ['photos'] };
    const existing = await probeExistingNames(plan, tree.io);
    expect(tree.listed).toEqual(['', 'photos']);
    expect(existing.get('photos')?.has('a.jpg')).toBe(true);
  });

  test('stops probing at the cap; unprobed directories report no conflicts', async () => {
    const dirs: Record<string, DirProbe> = { '': 'unknown' };
    const files: FolderUploadFile[] = [];
    for (let i = 0; i < 10; i += 1) {
      dirs[`d${i}`] = full('x');
      files.push(item(`d${i}`, 'x'));
    }
    const tree = fakeTree(dirs, [], 4);
    const existing = await probeExistingNames({ files, dirs: Object.keys(dirs) }, tree.io);
    // 目标目录自身占一次
    expect(tree.listed).toHaveLength(4);
    expect(planUploadConflicts(files, existing).conflicts).toHaveLength(3);
    expect(existing.size).toBe(10);
  });

  test('default cap', () => {
    expect(UPLOAD_CONFLICT_PROBE_LIMIT).toBe(200);
  });
});
