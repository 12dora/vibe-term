import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../lib/args';
import { assertKnownFlags } from '../lib/args';
import { TMEX_SHIM_MARKER } from '../lib/cli-shim';
import { pathExists } from '../lib/fs-utils';
import { runUninstall } from './uninstall';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeInstallTree(): Promise<{
  root: string;
  installDir: string;
  localBinDir: string;
  bunBinDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'tmex-uninst-'));
  tempDirs.push(root);
  const installDir = join(root, 'install');
  const versionDir = join(installDir, 'versions', '1.2.3');
  await mkdir(join(versionDir, 'cli', 'bin'), { recursive: true });
  await mkdir(join(installDir, 'staging'), { recursive: true });
  await mkdir(join(installDir, 'backups'), { recursive: true });
  await mkdir(join(installDir, 'data'), { recursive: true });
  await mkdir(join(installDir, 'logs'), { recursive: true });
  await writeFile(join(versionDir, 'cli', 'bin', 'tmex.js'), '#!/usr/bin/env node\n');
  await symlink(versionDir, join(installDir, 'current'));
  await writeFile(join(installDir, 'run.sh'), '#!/bin/bash\n');
  await writeFile(
    join(installDir, 'install-meta.json'),
    `${JSON.stringify({ serviceName: 'tmex-test', platform: 'darwin', installDir })}\n`
  );
  await writeFile(
    join(installDir, 'app.env'),
    `DATABASE_URL=${join(installDir, 'data', 'tmex.db')}\n`
  );
  await writeFile(join(installDir, 'upgrade-state.json'), '{}\n');
  await writeFile(join(installDir, 'upgrade.log'), 'log\n');
  await writeFile(join(installDir, 'data', 'tmex.db'), 'db');
  await writeFile(join(installDir, 'data', 'tmex.db-wal'), 'wal');
  await writeFile(join(installDir, 'data', 'tmex.db-shm'), 'shm');
  const localBinDir = join(root, 'local-bin');
  const bunBinDir = join(root, 'bun-bin');
  await mkdir(localBinDir, { recursive: true });
  await mkdir(bunBinDir, { recursive: true });
  return { root, installDir, localBinDir, bunBinDir };
}

describe('uninstall flags', () => {
  test('accepts --delay-ms with --yes --purge', () => {
    expect(() =>
      assertKnownFlags(
        parseArgs(['uninstall', '--yes', '--purge', '--delay-ms', '1500', '--install-dir', '/tmp'])
      )
    ).not.toThrow();
  });
});

describe('runUninstall --yes --purge', () => {
  test('sleeps --delay-ms before touching anything', async () => {
    const { installDir } = await makeInstallTree();
    const order: string[] = [];
    await runUninstall(
      parseArgs([
        'uninstall',
        '--yes',
        '--purge',
        '--delay-ms',
        '1500',
        '--install-dir',
        installDir,
      ]),
      {
        sleep: async (ms) => {
          order.push(`sleep:${ms}`);
        },
        uninstallService: async () => {
          order.push('service');
        },
        removeShims: async () => {
          order.push('shims');
        },
        log: () => undefined,
      }
    );
    expect(order[0]).toBe('sleep:1500');
    expect(order).toContain('service');
  });

  test('does not sleep when --delay-ms is omitted', async () => {
    const { installDir } = await makeInstallTree();
    let slept: number | null = null;
    await runUninstall(parseArgs(['uninstall', '--yes', '--purge', '--install-dir', installDir]), {
      sleep: async (ms) => {
        slept = ms;
      },
      uninstallService: async () => undefined,
      removeShims: async () => undefined,
      log: () => undefined,
    });
    expect(slept).toBeNull();
  });

  test('removes service, install tree, env, db trio and leaves outsiders', async () => {
    const { root, installDir } = await makeInstallTree();
    const outsider = join(root, 'keep-me.txt');
    await writeFile(outsider, 'safe');
    const serviceCalls: Array<{ serviceName: string; installDir: string }> = [];
    await runUninstall(parseArgs(['uninstall', '--yes', '--purge', '--install-dir', installDir]), {
      uninstallService: async (opts) => {
        serviceCalls.push(opts);
      },
      removeShims: async () => undefined,
      log: () => undefined,
    });
    expect(serviceCalls).toEqual([{ serviceName: 'tmex-test', installDir }]);
    expect(await pathExists(installDir)).toBe(false);
    expect(await pathExists(outsider)).toBe(true);
    expect(await readFile(outsider, 'utf8')).toBe('safe');
  });

  test('continues when the service manager is already gone', async () => {
    const { installDir } = await makeInstallTree();
    await runUninstall(parseArgs(['uninstall', '--yes', '--purge', '--install-dir', installDir]), {
      uninstallService: async () => {
        throw new Error('launchctl: No such process');
      },
      removeShims: async () => undefined,
      log: () => undefined,
    });
    expect(await pathExists(installDir)).toBe(false);
  });

  test('removes marked shims only', async () => {
    const { installDir, localBinDir, bunBinDir } = await makeInstallTree();
    const marked = join(localBinDir, 'tmex');
    const bunMarked = join(bunBinDir, 'tmex');
    const foreign = join(localBinDir, 'other');
    await writeFile(
      marked,
      `#!/usr/bin/env bash\n${TMEX_SHIM_MARKER}\n# tmex-install-dir: ${installDir}\n`
    );
    await writeFile(
      bunMarked,
      `#!/usr/bin/env bash\n${TMEX_SHIM_MARKER}\n# tmex-install-dir: ${installDir}\n`
    );
    await writeFile(foreign, '#!/bin/sh\necho hi\n');
    await runUninstall(parseArgs(['uninstall', '--yes', '--purge', '--install-dir', installDir]), {
      uninstallService: async () => undefined,
      log: () => undefined,
      shimDirs: { localBinDir, bunBinDir },
    });
    expect(await pathExists(marked)).toBe(false);
    expect(await pathExists(bunMarked)).toBe(false);
    expect(await pathExists(foreign)).toBe(true);
  });

  test('does not remove a marked shim belonging to another install', async () => {
    const { installDir, localBinDir, bunBinDir } = await makeInstallTree();
    const marked = join(localBinDir, 'tmex');
    await writeFile(
      marked,
      `#!/usr/bin/env bash\n${TMEX_SHIM_MARKER}\n# tmex-install-dir: /other/install\n`
    );
    await runUninstall(parseArgs(['uninstall', '--yes', '--purge', '--install-dir', installDir]), {
      uninstallService: async () => undefined,
      log: () => undefined,
      shimDirs: { localBinDir, bunBinDir },
    });
    expect(await pathExists(marked)).toBe(true);
  });

  test('does not follow DATABASE_URL outside installDir', async () => {
    const { root, installDir } = await makeInstallTree();
    const outsideDb = join(root, 'outside.db');
    await writeFile(outsideDb, 'keep');
    await writeFile(join(installDir, 'app.env'), `DATABASE_URL=${outsideDb}\n`);
    await runUninstall(parseArgs(['uninstall', '--yes', '--purge', '--install-dir', installDir]), {
      uninstallService: async () => undefined,
      removeShims: async () => undefined,
      log: () => undefined,
    });
    expect(await pathExists(outsideDb)).toBe(true);
  });

  test('best-effort removes the temp copy of itself', async () => {
    const { installDir } = await makeInstallTree();
    const copyRoot = await mkdtemp(join(tmpdir(), 'tmex-uninstall-'));
    tempDirs.push(copyRoot);
    await mkdir(join(copyRoot, 'bin'), { recursive: true });
    const argv1 = join(copyRoot, 'bin', 'tmex.js');
    await writeFile(argv1, '#!/usr/bin/env node\n');
    await runUninstall(parseArgs(['uninstall', '--yes', '--purge', '--install-dir', installDir]), {
      uninstallService: async () => undefined,
      removeShims: async () => undefined,
      argv1,
      log: () => undefined,
    });
    expect(await pathExists(copyRoot)).toBe(false);
  });

  test('does not delete a CLI tree that is not a temp uninstall copy', async () => {
    const { installDir } = await makeInstallTree();
    const otherCli = await mkdtemp(join(tmpdir(), 'tmex-real-cli-'));
    tempDirs.push(otherCli);
    await mkdir(join(otherCli, 'bin'), { recursive: true });
    const argv1 = join(otherCli, 'bin', 'tmex.js');
    await writeFile(argv1, '#!/usr/bin/env node\n');
    await runUninstall(parseArgs(['uninstall', '--yes', '--purge', '--install-dir', installDir]), {
      uninstallService: async () => undefined,
      removeShims: async () => undefined,
      argv1,
      log: () => undefined,
    });
    expect(await pathExists(otherCli)).toBe(true);
  });

  test('logs each step to stderr', async () => {
    const { installDir } = await makeInstallTree();
    const lines: string[] = [];
    await runUninstall(parseArgs(['uninstall', '--yes', '--purge', '--install-dir', installDir]), {
      uninstallService: async () => undefined,
      removeShims: async () => undefined,
      log: (msg) => lines.push(msg),
    });
    expect(lines.join('\n')).toMatch(/service/);
    expect(lines.join('\n')).toMatch(/files|install/i);
  });
});
