import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCurrentVersion, switchCurrent } from './upgrade-switch';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('switchCurrent', () => {
  test('creates current via temp symlink then rename', async () => {
    const installDir = await mkdtemp(join(tmpdir(), 'tmex-switch-'));
    tempDirs.push(installDir);
    await mkdir(join(installDir, 'versions', '1.0.0'), { recursive: true });
    await writeFile(join(installDir, 'versions', '1.0.0', 'marker'), 'one');

    await switchCurrent(installDir, '1.0.0');

    expect(await readlink(join(installDir, 'current'))).toBe(join('versions', '1.0.0'));
    expect(await readCurrentVersion(installDir)).toBe('1.0.0');
  });

  test('atomically replaces current to a new version', async () => {
    const installDir = await mkdtemp(join(tmpdir(), 'tmex-switch-rep-'));
    tempDirs.push(installDir);
    await mkdir(join(installDir, 'versions', '1.0.0'), { recursive: true });
    await mkdir(join(installDir, 'versions', '2.0.0'), { recursive: true });
    await switchCurrent(installDir, '1.0.0');
    await switchCurrent(installDir, '2.0.0');

    expect(await readlink(join(installDir, 'current'))).toBe(join('versions', '2.0.0'));
    expect(await readCurrentVersion(installDir)).toBe('2.0.0');
  });
});
