import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyDirRels, walkLocal } from './transfer-walk';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('walkLocal', () => {
  test('records symlinks as skipped and keeps empty dirs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vibeterm-walk-'));
    dirs.push(root);
    await mkdir(join(root, 'empty'));
    await mkdir(join(root, 'sub'));
    await writeFile(join(root, 'sub', 'a.txt'), 'x');
    await symlink(join(root, 'sub', 'a.txt'), join(root, 'link.txt'));
    const walked = await walkLocal(root);
    expect(walked.skipped.some((row) => row.reason === 'symlink')).toBe(true);
    expect(emptyDirRels(walked.entries)).toContain('empty');
    expect(walked.entries.some((row) => row.rel === 'sub/a.txt' && !row.dir)).toBe(true);
  });
});
