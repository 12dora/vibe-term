import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setLang, t } from '../i18n';
import {
  TMEX_SHIM_MARKER,
  deployCliPackage,
  installTmexShim,
  isDirOnPath,
  removeTmexShims,
} from './cli-shim';
import { createInstallLayout } from './install-layout';
import type { PackageLayout } from './install-layout';

const tempDirs: string[] = [];

afterEach(async () => {
  setLang('en');
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makePackageRoot(): Promise<PackageLayout> {
  const packageRoot = await mkdtemp(join(tmpdir(), 'tmex-pkg-'));
  tempDirs.push(packageRoot);
  await mkdir(join(packageRoot, 'bin'), { recursive: true });
  await mkdir(join(packageRoot, 'dist'), { recursive: true });
  await writeFile(
    join(packageRoot, 'package.json'),
    `${JSON.stringify({ name: 'tmex-cli', version: '1.1.0', bin: { tmex: './bin/tmex.js' } }, null, 2)}\n`
  );
  await writeFile(
    join(packageRoot, 'bin', 'tmex.js'),
    "#!/usr/bin/env node\nimport { main } from '../dist/cli-node.js';\n"
  );
  await writeFile(join(packageRoot, 'dist', 'cli-node.js'), 'export async function main() {}\n');
  return {
    packageRoot,
    cliDistPath: join(packageRoot, 'dist', 'cli-node.js'),
    runtimeDirPath: join(packageRoot, 'dist', 'runtime'),
    resourceFePath: join(packageRoot, 'resources', 'fe-dist'),
    resourceDrizzlePath: join(packageRoot, 'resources', 'gateway-drizzle'),
  };
}

describe('isDirOnPath', () => {
  test('matches an exact PATH entry after resolve', () => {
    expect(isDirOnPath('/tmp/local-bin', '/usr/bin:/tmp/local-bin:/bin')).toBe(true);
    expect(isDirOnPath('/tmp/local-bin', '/usr/bin:/bin')).toBe(false);
    expect(isDirOnPath('/tmp/local-bin', '')).toBe(false);
  });
});

describe('deployCliPackage', () => {
  test('copies package.json, bin/, and dist/cli-node.js into <installDir>/cli', async () => {
    const packageLayout = await makePackageRoot();
    const installDir = await mkdtemp(join(tmpdir(), 'tmex-install-'));
    tempDirs.push(installDir);
    const installLayout = createInstallLayout(installDir);

    await deployCliPackage(packageLayout, installLayout);

    expect(await readFile(join(installLayout.cliDir, 'package.json'), 'utf8')).toContain(
      '"name": "tmex-cli"'
    );
    expect(await readFile(join(installLayout.cliDir, 'bin', 'tmex.js'), 'utf8')).toContain(
      'cli-node.js'
    );
    expect(await readFile(join(installLayout.cliDir, 'dist', 'cli-node.js'), 'utf8')).toContain(
      'export async function main'
    );
  });
});

describe('installTmexShim', () => {
  test('writes an executable shim that prefers node then baked-in bun path', async () => {
    const packageLayout = await makePackageRoot();
    const root = await mkdtemp(join(tmpdir(), 'tmex-shim-'));
    tempDirs.push(root);
    const installDir = join(root, 'install');
    const localBinDir = join(root, 'local-bin');
    const bunBinDir = join(root, 'no-bun-bin');
    const bunPath = join(root, 'fake-bun');
    await writeFile(bunPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const installLayout = createInstallLayout(installDir);
    await deployCliPackage(packageLayout, installLayout);

    const result = await installTmexShim({
      installLayout,
      bunPath,
      localBinDir,
      bunBinDir,
      pathEnv: '/usr/bin:/bin',
    });

    expect(result.shimPath).toBe(join(localBinDir, 'tmex'));
    expect(result.bunLinkPath).toBeNull();
    expect(result.pathHint).toContain(localBinDir);

    const shim = await readFile(result.shimPath, 'utf8');
    expect(shim.startsWith('#!/usr/bin/env bash')).toBe(true);
    expect(shim).toContain(TMEX_SHIM_MARKER);
    expect(shim).toContain('command -v node');
    expect(shim).toContain(join(installLayout.cliDir, 'bin', 'tmex.js'));
    expect(shim).toContain(bunPath);

    const mode = (await stat(result.shimPath)).mode;
    expect((mode & 0o111) !== 0).toBe(true);

    const syntax = spawnSync('bash', ['-n', result.shimPath], { encoding: 'utf8' });
    expect(syntax.status).toBe(0);
    expect(syntax.stderr).toBe('');
  });

  test('symlinks the shim into ~/.bun/bin when that directory exists', async () => {
    const packageLayout = await makePackageRoot();
    const root = await mkdtemp(join(tmpdir(), 'tmex-shim-bun-'));
    tempDirs.push(root);
    const installDir = join(root, 'install');
    const localBinDir = join(root, 'local-bin');
    const bunBinDir = join(root, 'bun-bin');
    await mkdir(bunBinDir, { recursive: true });
    const installLayout = createInstallLayout(installDir);
    await deployCliPackage(packageLayout, installLayout);

    const result = await installTmexShim({
      installLayout,
      bunPath: '/usr/bin/bun',
      localBinDir,
      bunBinDir,
      pathEnv: `${localBinDir}:/usr/bin`,
    });

    expect(result.bunLinkPath).toBe(join(bunBinDir, 'tmex'));
    expect(result.pathHint).toBeNull();
    const link = spawnSync('readlink', [result.bunLinkPath as string], { encoding: 'utf8' });
    expect(link.stdout.trim()).toBe(result.shimPath);
  });

  test('prints zh-CN PATH hint when local bin is missing from PATH', async () => {
    setLang('zh-CN');
    const packageLayout = await makePackageRoot();
    const root = await mkdtemp(join(tmpdir(), 'tmex-shim-zh-'));
    tempDirs.push(root);
    const installLayout = createInstallLayout(join(root, 'install'));
    await deployCliPackage(packageLayout, installLayout);
    const localBinDir = join(root, 'local-bin');

    const result = await installTmexShim({
      installLayout,
      bunPath: '/usr/bin/bun',
      localBinDir,
      bunBinDir: join(root, 'missing-bun-bin'),
      pathEnv: '/usr/bin',
    });

    expect(result.pathHint).toBe(t('cli.shim.pathHint', { binDir: localBinDir }));
    expect(result.pathHint).toContain('PATH');
    expect(result.pathHint).not.toContain('你');
  });
});

describe('removeTmexShims', () => {
  test('removes managed shim and bun symlink, leaves foreign binaries', async () => {
    const packageLayout = await makePackageRoot();
    const root = await mkdtemp(join(tmpdir(), 'tmex-shim-rm-'));
    tempDirs.push(root);
    const localBinDir = join(root, 'local-bin');
    const bunBinDir = join(root, 'bun-bin');
    await mkdir(bunBinDir, { recursive: true });
    const installLayout = createInstallLayout(join(root, 'install'));
    await deployCliPackage(packageLayout, installLayout);
    await installTmexShim({
      installLayout,
      bunPath: '/usr/bin/bun',
      localBinDir,
      bunBinDir,
      pathEnv: localBinDir,
    });
    const foreign = join(localBinDir, 'other');
    await writeFile(foreign, '#!/bin/sh\necho hi\n', { mode: 0o755 });

    await removeTmexShims({ localBinDir, bunBinDir });

    await expect(stat(join(localBinDir, 'tmex'))).rejects.toThrow();
    await expect(stat(join(bunBinDir, 'tmex'))).rejects.toThrow();
    expect(await readFile(foreign, 'utf8')).toContain('echo hi');
  });
});
