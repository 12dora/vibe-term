import { describe, expect, test } from 'bun:test';
import type { FolderUploadFile } from './folder-upload';
import {
  type ConflictProbeIo,
  type DirExistence,
  type DirProbe,
  UPLOAD_CONFLICT_PROBE_LIMIT,
  UPLOAD_CONFLICT_STAT_THRESHOLD,
  type UploadConflictPlan,
  conflictDisplayName,
  conflictPromptNames,
  planUploadConflicts,
  probeExistence,
  selectUploadFiles,
} from './upload-conflicts';

function item(relDir: string, name: string): FolderUploadFile {
  return { file: { name, size: 1 } as unknown as File, relDir };
}

const names = (items: readonly FolderUploadFile[]) => items.map(conflictDisplayName);

const shape = (plan: UploadConflictPlan) => ({
  conflicts: names(plan.conflicts),
  clean: names(plan.clean),
  unknown: names(plan.unknown),
});

const complete = (...existing: string[]): DirExistence => ({
  existing: new Set(existing),
  absent: 'all',
});

interface FakeTree {
  io: ConflictProbeIo;
  listed: string[];
  statted: string[];
}

/**
 * `dirs`：相对目录 → 列表结果，没列出的目录一律 missing。
 * `stats`：`相对路径` → true 存在 / false 不存在 / 'error' 查询失败；没列出的算不存在。
 */
function fakeTree(
  dirs: Record<string, DirProbe>,
  stats: Record<string, boolean | 'error'> = {},
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
        const answer = stats[key] ?? false;
        if (answer === 'error') throw new Error('stat failed');
        return answer;
      },
    },
  };
}

const full = (...entries: string[]): DirProbe => ({ names: entries, truncated: false });
const page = (...entries: string[]): DirProbe => ({ names: entries, truncated: true });

async function classify(
  plan: { files: FolderUploadFile[]; dirs: string[] },
  tree: FakeTree
): Promise<ReturnType<typeof shape>> {
  return shape(planUploadConflicts(plan.files, await probeExistence(plan, tree.io)));
}

describe('planUploadConflicts', () => {
  test('conflict / clean / unknown per file own directory', () => {
    const files = [
      item('', 'a.txt'),
      item('', 'b.txt'),
      item('photos', 'a.jpg'),
      item('big', 'seen'),
      item('big', 'checked'),
      item('big', 'unsure'),
      item('unprobed', 'x'),
    ];
    const existence = new Map<string, DirExistence>([
      ['', complete('a.txt', 'photos')],
      ['photos', complete('a.jpg')],
      ['big', { existing: new Set(['seen']), absent: new Set(['checked']) }],
    ]);
    expect(shape(planUploadConflicts(files, existence))).toEqual({
      conflicts: ['a.txt', 'photos/a.jpg', 'big/seen'],
      clean: ['b.txt', 'big/checked'],
      unknown: ['big/unsure', 'unprobed/x'],
    });
  });

  test('a name only collides inside its own directory', () => {
    const existence = new Map([
      ['', complete('a.txt')],
      ['sub', complete()],
    ]);
    expect(shape(planUploadConflicts([item('sub', 'a.txt')], existence))).toEqual({
      conflicts: [],
      clean: ['sub/a.txt'],
      unknown: [],
    });
  });

  test('a directory without facts is never assumed clean', () => {
    const plan = planUploadConflicts([item('', 'a')], new Map());
    expect(shape(plan)).toEqual({ conflicts: [], clean: [], unknown: ['a'] });
  });
});

describe('conflictPromptNames / selectUploadFiles', () => {
  const all = [item('', 'taken'), item('', 'fresh'), item('', 'unsure')];
  const plan: UploadConflictPlan = {
    conflicts: [all[0] as FolderUploadFile],
    clean: [all[1] as FolderUploadFile],
    unknown: [all[2] as FolderUploadFile],
  };

  test('lists conflicts first, then unknown; clean items are never listed', () => {
    const reordered: UploadConflictPlan = {
      conflicts: [item('z', 'c')],
      clean: [item('', 'ok')],
      unknown: [item('a', 'u')],
    };
    expect(conflictPromptNames(reordered)).toEqual(['z/c', 'a/u']);
  });

  test('nothing to ask when everything is clean', () => {
    expect(conflictPromptNames({ conflicts: [], clean: [item('', 'a')], unknown: [] })).toEqual([]);
  });

  test('unknown alone is enough to ask', () => {
    expect(conflictPromptNames({ conflicts: [], clean: [], unknown: [item('', 'u')] })).toEqual([
      'u',
    ]);
  });

  test('skip uploads only clean items — never unknown ones', () => {
    expect(names(selectUploadFiles(all, plan, 'skip') ?? [])).toEqual(['fresh']);
  });

  test('replace uploads everything in the original order', () => {
    expect(names(selectUploadFiles(all, plan, 'replace') ?? [])).toEqual([
      'taken',
      'fresh',
      'unsure',
    ]);
  });

  test('cancel uploads nothing', () => {
    expect(selectUploadFiles(all, plan, 'cancel')).toBeNull();
  });
});

describe('probeExistence', () => {
  test('flat upload lists the destination once', async () => {
    const tree = fakeTree({ '': full('a.txt', 'z') });
    const plan = { files: [item('', 'a.txt'), item('', 'b.txt')], dirs: [] };
    expect(await classify(plan, tree)).toEqual({
      conflicts: ['a.txt'],
      clean: ['b.txt'],
      unknown: [],
    });
    expect(tree.listed).toEqual(['']);
    expect(tree.statted).toEqual([]);
  });

  test('merging into an existing folder probes that folder', async () => {
    const tree = fakeTree({ '': full('photos'), photos: full('a.jpg') });
    const plan = { files: [item('photos', 'a.jpg'), item('photos', 'b.jpg')], dirs: ['photos'] };
    expect(await classify(plan, tree)).toEqual({
      conflicts: ['photos/a.jpg'],
      clean: ['photos/b.jpg'],
      unknown: [],
    });
    expect(tree.listed).toEqual(['', 'photos']);
  });

  test('a brand-new folder tree is proven clean with one request', async () => {
    const tree = fakeTree({ '': full('other') });
    const plan = {
      files: [item('top/a', 'x'), item('top/b', 'y'), item('top/b/c', 'z')],
      dirs: ['top', 'top/a', 'top/b', 'top/b/c'],
    };
    expect(await classify(plan, tree)).toEqual({
      conflicts: [],
      clean: ['top/a/x', 'top/b/y', 'top/b/c/z'],
      unknown: [],
    });
    expect(tree.listed).toEqual(['']);
  });

  test('a directory proven not to exist makes its files and sub-directories clean', async () => {
    // 目标目录是截断的列表，证明不了 a 不存在 → 去列 a，得到 missing
    const tree = fakeTree({ '': page() });
    const plan = { files: [item('a', 'x'), item('a/b', 'y')], dirs: ['a', 'a/b'] };
    expect(await classify(plan, tree)).toEqual({
      conflicts: [],
      clean: ['a/x', 'a/b/y'],
      unknown: [],
    });
    expect(tree.listed).toEqual(['', 'a']);
  });

  test('a failed destination listing makes everything unknown without further probes', async () => {
    const tree = fakeTree({ '': 'unknown', a: full('x') });
    const plan = { files: [item('', 'top'), item('a', 'x'), item('a/b', 'y')], dirs: ['a', 'a/b'] };
    expect(await classify(plan, tree)).toEqual({
      conflicts: [],
      clean: [],
      unknown: ['top', 'a/x', 'a/b/y'],
    });
    expect(tree.listed).toEqual(['']);
  });

  test('a failed sub-directory listing taints only its own subtree', async () => {
    const tree = fakeTree({ '': full('a', 'ok'), a: 'unknown', ok: full('y') });
    const plan = {
      files: [item('', 'new'), item('a', 'x'), item('a/b', 'deep'), item('ok', 'y')],
      dirs: ['a', 'a/b', 'ok'],
    };
    expect(await classify(plan, tree)).toEqual({
      conflicts: ['ok/y'],
      clean: ['new'],
      unknown: ['a/x', 'a/b/deep'],
    });
    expect(tree.listed.sort()).toEqual(['', 'a', 'ok']);
  });

  test('a rejected listing counts as a failure, not as "no conflicts"', async () => {
    const io: ConflictProbeIo = {
      list: () => Promise.reject(new Error('offline')),
      exists: () => Promise.reject(new Error('offline')),
    };
    const files = [item('', 'a')];
    const existence = await probeExistence({ files, dirs: [] }, io);
    expect(shape(planUploadConflicts(files, existence)).unknown).toEqual(['a']);
  });

  test('truncated listing: a few missing names are confirmed one by one', async () => {
    const tree = fakeTree({ '': page('seen') }, { hidden: true, broken: 'error' });
    const files = [item('', 'seen'), item('', 'hidden'), item('', 'fresh'), item('', 'broken')];
    expect(await classify({ files, dirs: [] }, tree)).toEqual({
      conflicts: ['seen', 'hidden'],
      clean: ['fresh'],
      unknown: ['broken'],
    });
    expect(tree.statted.sort()).toEqual(['broken', 'fresh', 'hidden']);
  });

  test('truncated listing with many missing names: no stats, all unknown', async () => {
    const tree = fakeTree({ '': page('seen') });
    const files = [item('', 'seen')];
    for (let i = 0; i <= UPLOAD_CONFLICT_STAT_THRESHOLD; i += 1) files.push(item('', `f${i}`));
    const result = await classify({ files, dirs: [] }, tree);
    expect(tree.statted).toEqual([]);
    expect(result.conflicts).toEqual(['seen']);
    expect(result.clean).toEqual([]);
    expect(result.unknown).toHaveLength(UPLOAD_CONFLICT_STAT_THRESHOLD + 1);
  });

  test('exactly the threshold is still confirmed', async () => {
    const tree = fakeTree({ '': page() });
    const files = Array.from({ length: UPLOAD_CONFLICT_STAT_THRESHOLD }, (_, i) =>
      item('', `f${i}`)
    );
    const result = await classify({ files, dirs: [] }, tree);
    expect(tree.statted).toHaveLength(UPLOAD_CONFLICT_STAT_THRESHOLD);
    expect(result.clean).toHaveLength(UPLOAD_CONFLICT_STAT_THRESHOLD);
  });

  test('200 files into a truncated listing never yield a clean guess', async () => {
    const stats: Record<string, boolean> = {};
    const files: FolderUploadFile[] = [];
    for (let i = 0; i < 200; i += 1) {
      stats[`f${i}`] = true;
      files.push(item('', `f${i}`));
    }
    const tree = fakeTree({ '': page() }, stats);
    const plan = planUploadConflicts(files, await probeExistence({ files, dirs: [] }, tree.io));
    expect(plan.clean).toEqual([]);
    expect(plan.unknown).toHaveLength(200);
    expect(selectUploadFiles(files, plan, 'skip')).toEqual([]);
  });

  test('a truncated parent listing cannot prove a child is missing', async () => {
    const tree = fakeTree({ '': page(), photos: full('a.jpg') });
    const plan = { files: [item('photos', 'a.jpg')], dirs: ['photos'] };
    expect((await classify(plan, tree)).conflicts).toEqual(['photos/a.jpg']);
    expect(tree.listed).toEqual(['', 'photos']);
  });

  test('budget exhausted on listings: unprobed directories are unknown, not clean', async () => {
    const dirs: Record<string, DirProbe> = { '': page() };
    const files: FolderUploadFile[] = [];
    for (let i = 0; i < 10; i += 1) {
      dirs[`d${i}`] = full('x');
      files.push(item(`d${i}`, 'x'), item(`d${i}`, 'new'));
    }
    const tree = fakeTree(dirs, {}, 4);
    const plan = planUploadConflicts(
      files,
      await probeExistence({ files, dirs: Object.keys(dirs) }, tree.io)
    );
    // 目标目录自身占一次，剩 3 个子目录查得到
    expect(tree.listed).toHaveLength(4);
    expect(plan.conflicts).toHaveLength(3);
    expect(plan.clean).toHaveLength(3);
    expect(plan.unknown).toHaveLength(14);
    const skipped = names(selectUploadFiles(files, plan, 'skip') ?? []);
    expect(skipped).toHaveLength(3);
    expect(skipped.every((name) => name.endsWith('/new'))).toBe(true);
  });

  test('budget too small to confirm a truncated directory: leave it all unknown', async () => {
    const tree = fakeTree({ '': page() }, {}, 3);
    const files = [item('', 'a'), item('', 'b'), item('', 'c')];
    const result = await classify({ files, dirs: [] }, tree);
    // 列目录用掉 1 次，剩 2 次不够确认 3 个名字
    expect(tree.statted).toEqual([]);
    expect(result.unknown).toEqual(['a', 'b', 'c']);
  });

  test('defaults', () => {
    expect(UPLOAD_CONFLICT_PROBE_LIMIT).toBe(200);
    expect(UPLOAD_CONFLICT_STAT_THRESHOLD).toBe(20);
  });
});
