import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathExists } from './fs-utils';
import { pruneVersions, removeLegacyTopLevelDirs, removeTxnDirs } from './upgrade-gc';
import { switchCurrent } from './upgrade-switch';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('pruneVersions', () => {
  test('keeps current and one previous last-known-good', async () => {
    const installDir = await mkdtemp(join(tmpdir(), 'tmex-gc-'));
    tempDirs.push(installDir);
    for (const version of ['1.0.0', '1.1.0', '2.0.0']) {
      await mkdir(join(installDir, 'versions', version), { recursive: true });
      await writeFile(join(installDir, 'versions', version, 'marker'), version);
    }
    await switchCurrent(installDir, '2.0.0');

    await pruneVersions(installDir, { current: '2.0.0', previous: '1.1.0' });

    const left = (await readdir(join(installDir, 'versions'))).sort();
    expect(left).toEqual(['1.1.0', '2.0.0']);
  });

  test('refuses to delete the directory current points at', async () => {
    const installDir = await mkdtemp(join(tmpdir(), 'tmex-gc-protect-'));
    tempDirs.push(installDir);
    await mkdir(join(installDir, 'versions', '1.0.0'), { recursive: true });
    await switchCurrent(installDir, '1.0.0');
    await pruneVersions(installDir, { current: '1.0.0', previous: '1.0.0' });
    expect(await pathExists(join(installDir, 'versions', '1.0.0'))).toBe(true);
  });
});

describe('removeTxnDirs', () => {
  test('deletes staging and backups for the txn', async () => {
    const installDir = await mkdtemp(join(tmpdir(), 'tmex-gc-txn-'));
    tempDirs.push(installDir);
    await mkdir(join(installDir, 'staging', 'txn-1'), { recursive: true });
    await mkdir(join(installDir, 'backups', 'txn-1'), { recursive: true });
    await writeFile(join(installDir, 'staging', 'txn-1', 'x'), 'x');
    await removeTxnDirs(installDir, 'txn-1');
    expect(await pathExists(join(installDir, 'staging', 'txn-1'))).toBe(false);
    expect(await pathExists(join(installDir, 'backups', 'txn-1'))).toBe(false);
  });
});

describe('removeLegacyTopLevelDirs', () => {
  test('removes top-level cli/runtime/resources once current exists', async () => {
    const installDir = await mkdtemp(join(tmpdir(), 'tmex-gc-legacy-'));
    tempDirs.push(installDir);
    await mkdir(join(installDir, 'cli'), { recursive: true });
    await mkdir(join(installDir, 'runtime'), { recursive: true });
    await mkdir(join(installDir, 'resources'), { recursive: true });
    await mkdir(join(installDir, 'versions', '1.0.0', 'cli'), { recursive: true });
    await switchCurrent(installDir, '1.0.0');

    await removeLegacyTopLevelDirs(installDir);

    expect(await pathExists(join(installDir, 'cli'))).toBe(false);
    expect(await pathExists(join(installDir, 'runtime'))).toBe(false);
    expect(await pathExists(join(installDir, 'resources'))).toBe(false);
    expect(await pathExists(join(installDir, 'versions', '1.0.0'))).toBe(true);
  });
});

describe('sweepUpgradeGarbage', () => {
  test('removes orphan staging and tmp leftovers without touching current or data', async () => {
    const installDir = await mkdtemp(join(tmpdir(), 'tmex-gc-sweep-'));
    tempDirs.push(installDir);
    await mkdir(join(installDir, 'versions', '1.0.0'), { recursive: true });
    await mkdir(join(installDir, 'staging', 'orphan'), { recursive: true });
    await mkdir(join(installDir, 'data'), { recursive: true });
    await writeFile(join(installDir, 'staging', 'orphan', 'x'), 'x');
    await writeFile(join(installDir, 'data', 'tmex.db'), 'keep');
    await writeFile(join(installDir, 'upgrade-state.json.1.2.tmp'), 'tmp');
    await writeFile(join(installDir, 'current.99.tmp'), 'tmp');
    await writeFile(join(installDir, 'run.sh.1.tmp'), 'tmp');
    await switchCurrent(installDir, '1.0.0');

    const { sweepUpgradeGarbage } = await import('./upgrade-gc');
    await sweepUpgradeGarbage(installDir);

    expect(await pathExists(join(installDir, 'staging', 'orphan'))).toBe(false);
    expect(await pathExists(join(installDir, 'upgrade-state.json.1.2.tmp'))).toBe(false);
    expect(await pathExists(join(installDir, 'current.99.tmp'))).toBe(false);
    expect(await pathExists(join(installDir, 'run.sh.1.tmp'))).toBe(false);
    expect(await pathExists(join(installDir, 'versions', '1.0.0'))).toBe(true);
    expect(await readFile(join(installDir, 'data', 'tmex.db'), 'utf8')).toBe('keep');
  });
});
