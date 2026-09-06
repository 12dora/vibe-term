import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setLang, t } from '../i18n';
import {
  LEGACY_INSTALL_DIR_PREFIX,
  LEGACY_SHIM_MARKER,
  VIBETERM_SHIM_MARKER,
  deployCliPackage,
  findLegacyMarkedShims,
  installVibeTermShim,
  isDirOnPath,
  removeVibeTermShims,
} from './cli-shim';
import { pathExists } from './fs-utils';
import { createInstallLayout } from './install-layout';
import type { PackageLayout } from './install-layout';

const tempDirs: string[] = [];

afterEach(async () => {
  setLang('en');
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makePackageRoot(): Promise<PackageLayout> {
  const packageRoot = await mkdtemp(join(tmpdir(), 'vibeterm-pkg-'));
  tempDirs.push(packageRoot);
  await mkdir(join(packageRoot, 'bin'), { recursive: true });
  await mkdir(join(packageRoot, 'dist'), { recursive: true });
  await writeFile(
    join(packageRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: 'vibeterm-cli',
        version: '2.0.0',
        bin: { vibeterm: './bin/vibeterm.js', tmex: './bin/tmex.js' },
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    join(packageRoot, 'bin', 'vibeterm.js'),
    "#!/usr/bin/env node\nimport { main } from '../dist/cli-node.js';\n"
  );
  await writeFile(
    join(packageRoot, 'bin', 'tmex.js'),
    "#!/usr/bin/env node\nimport './vibeterm.js';\n"
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
    const installDir = await mkdtemp(join(tmpdir(), 'vibeterm-install-'));
    tempDirs.push(installDir);
    const installLayout = createInstallLayout(installDir);

    await deployCliPackage(packageLayout, installLayout);

    expect(await readFile(join(installLayout.cliDir, 'package.json'), 'utf8')).toContain(
      '"name": "vibeterm-cli"'
    );
    expect(await readFile(join(installLayout.cliDir, 'bin', 'vibeterm.js'), 'utf8')).toContain(
      'cli-node.js'
    );
    expect(await readFile(join(installLayout.cliDir, 'bin', 'tmex.js'), 'utf8')).toContain(
      'vibeterm.js'
    );
    expect(await readFile(join(installLayout.cliDir, 'dist', 'cli-node.js'), 'utf8')).toContain(
      'export async function main'
    );
  });
});

describe('installVibeTermShim', () => {
  test('writes an executable shim that prefers node then baked-in bun path', async () => {
    const packageLayout = await makePackageRoot();
    const root = await mkdtemp(join(tmpdir(), 'vibeterm-shim-'));
    tempDirs.push(root);
    const installDir = join(root, 'install');
    const localBinDir = join(root, 'local-bin');
    const bunBinDir = join(root, 'no-bun-bin');
    const bunPath = join(root, 'fake-bun');
    await writeFile(bunPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const installLayout = createInstallLayout(installDir);
    await deployCliPackage(packageLayout, installLayout);

    const result = await installVibeTermShim({
      installLayout,
      bunPath,
      localBinDir,
      bunBinDir,
      pathEnv: '/usr/bin:/bin',
    });

    expect(result.shimPath).toBe(join(localBinDir, 'vibeterm'));
    expect(result.aliasShimPath).toBe(join(localBinDir, 'tmex'));
    expect(result.bunLinkPath).toBeNull();
    expect(result.pathHint).toContain(localBinDir);

    const shim = await readFile(result.shimPath, 'utf8');
    expect(shim.startsWith('#!/usr/bin/env bash')).toBe(true);
    expect(shim).toContain(VIBETERM_SHIM_MARKER);
    expect(shim).toContain(`# vibeterm-install-dir: ${installDir}`);
    expect(shim).toContain('command -v node');
    expect(shim).toMatch(/-ge 20/);
    expect(shim).toContain(join(installDir, 'current', 'cli', 'bin', 'vibeterm.js'));
    expect(shim).toContain(bunPath);

    const mode = (await stat(result.shimPath)).mode;
    expect((mode & 0o111) !== 0).toBe(true);

    const syntax = spawnSync('bash', ['-n', result.shimPath], { encoding: 'utf8' });
    expect(syntax.status).toBe(0);
    expect(syntax.stderr).toBe('');
  });

  test('symlinks the shim into ~/.bun/bin when that directory exists', async () => {
    const packageLayout = await makePackageRoot();
    const root = await mkdtemp(join(tmpdir(), 'vibeterm-shim-bun-'));
    tempDirs.push(root);
    const installDir = join(root, 'install');
    const localBinDir = join(root, 'local-bin');
    const bunBinDir = join(root, 'bun-bin');
    await mkdir(bunBinDir, { recursive: true });
    const installLayout = createInstallLayout(installDir);
    await deployCliPackage(packageLayout, installLayout);

    const result = await installVibeTermShim({
      installLayout,
      bunPath: '/usr/bin/bun',
      localBinDir,
      bunBinDir,
      pathEnv: `${localBinDir}:/usr/bin`,
    });

    expect(result.bunLinkPath).toBe(join(bunBinDir, 'vibeterm'));
    expect(result.pathHint).toBeNull();
    const link = spawnSync('readlink', [result.bunLinkPath as string], { encoding: 'utf8' });
    expect(link.stdout.trim()).toBe(result.shimPath);
  });

  test('prints zh-CN PATH hint when local bin is missing from PATH', async () => {
    setLang('zh-CN');
    const packageLayout = await makePackageRoot();
    const root = await mkdtemp(join(tmpdir(), 'vibeterm-shim-zh-'));
    tempDirs.push(root);
    const installLayout = createInstallLayout(join(root, 'install'));
    await deployCliPackage(packageLayout, installLayout);
    const localBinDir = join(root, 'local-bin');

    const result = await installVibeTermShim({
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

  test('does not warn about PATH when the bun bin symlink directory is on PATH', async () => {
    const packageLayout = await makePackageRoot();
    const root = await mkdtemp(join(tmpdir(), 'vibeterm-shim-path-bun-'));
    tempDirs.push(root);
    const localBinDir = join(root, 'local-bin');
    const bunBinDir = join(root, 'bun-bin');
    await mkdir(bunBinDir, { recursive: true });
    const installLayout = createInstallLayout(join(root, 'install'));
    await deployCliPackage(packageLayout, installLayout);

    const result = await installVibeTermShim({
      installLayout,
      bunPath: '/usr/bin/bun',
      localBinDir,
      bunBinDir,
      pathEnv: `${bunBinDir}:/usr/bin`,
    });

    expect(result.bunLinkPath).toBe(join(bunBinDir, 'vibeterm'));
    expect(result.pathHint).toBeNull();
  });

  test('leaves a foreign file at ~/.local/bin/vibeterm untouched', async () => {
    const packageLayout = await makePackageRoot();
    const root = await mkdtemp(join(tmpdir(), 'vibeterm-shim-foreign-file-'));
    tempDirs.push(root);
    const localBinDir = join(root, 'local-bin');
    await mkdir(localBinDir, { recursive: true });
    const shimPath = join(localBinDir, 'vibeterm');
    await writeFile(shimPath, '#!/bin/sh\necho foreign-file\n', { mode: 0o755 });
    const installLayout = createInstallLayout(join(root, 'install'));
    await deployCliPackage(packageLayout, installLayout);

    const result = await installVibeTermShim({
      installLayout,
      bunPath: '/usr/bin/bun',
      localBinDir,
      bunBinDir: join(root, 'missing-bun-bin'),
      pathEnv: localBinDir,
    });

    expect(await readFile(shimPath, 'utf8')).toBe('#!/bin/sh\necho foreign-file\n');
    expect(result.skipWarning).toBe(t('cli.shim.skipForeign', { path: shimPath }));
  });

  test('leaves a foreign symlink at ~/.local/bin/vibeterm untouched', async () => {
    const packageLayout = await makePackageRoot();
    const root = await mkdtemp(join(tmpdir(), 'vibeterm-shim-foreign-link-'));
    tempDirs.push(root);
    const localBinDir = join(root, 'local-bin');
    await mkdir(localBinDir, { recursive: true });
    const target = join(root, 'other-vibeterm');
    await writeFile(target, '#!/bin/sh\necho other-bin\n', { mode: 0o755 });
    const shimPath = join(localBinDir, 'vibeterm');
    await symlink(target, shimPath);
    const installLayout = createInstallLayout(join(root, 'install'));
    await deployCliPackage(packageLayout, installLayout);

    const result = await installVibeTermShim({
      installLayout,
      bunPath: '/usr/bin/bun',
      localBinDir,
      bunBinDir: join(root, 'missing-bun-bin'),
      pathEnv: localBinDir,
    });

    expect(await readlink(shimPath)).toBe(target);
    expect(await readFile(target, 'utf8')).toContain('echo other-bin');
    expect(result.skipWarning).toBe(t('cli.shim.skipForeign', { path: shimPath }));
  });

  test('replaces a managed shim and records the install dir', async () => {
    const packageLayout = await makePackageRoot();
    const root = await mkdtemp(join(tmpdir(), 'vibeterm-shim-replace-'));
    tempDirs.push(root);
    const localBinDir = join(root, 'local-bin');
    const firstLayout = createInstallLayout(join(root, 'install-a'));
    const secondLayout = createInstallLayout(join(root, 'install-b'));
    await deployCliPackage(packageLayout, firstLayout);
    await deployCliPackage(packageLayout, secondLayout);

    await installVibeTermShim({
      installLayout: firstLayout,
      bunPath: '/usr/bin/bun',
      localBinDir,
      bunBinDir: join(root, 'missing-bun-bin'),
      pathEnv: localBinDir,
    });
    const result = await installVibeTermShim({
      installLayout: secondLayout,
      bunPath: '/usr/bin/bun',
      localBinDir,
      bunBinDir: join(root, 'missing-bun-bin'),
      pathEnv: localBinDir,
    });

    const shim = await readFile(result.shimPath, 'utf8');
    expect(shim).toContain(VIBETERM_SHIM_MARKER);
    expect(shim).toContain(`# vibeterm-install-dir: ${secondLayout.installDir}`);
    expect(shim).not.toContain(`# vibeterm-install-dir: ${firstLayout.installDir}`);
    expect(result.skipWarning).toBeNull();
  });

  test('does not replace a foreign ~/.bun/bin/vibeterm symlink', async () => {
    const packageLayout = await makePackageRoot();
    const root = await mkdtemp(join(tmpdir(), 'vibeterm-shim-bun-foreign-'));
    tempDirs.push(root);
    const localBinDir = join(root, 'local-bin');
    const bunBinDir = join(root, 'bun-bin');
    await mkdir(bunBinDir, { recursive: true });
    const other = join(root, 'other-bun-vibeterm');
    await writeFile(other, '#!/bin/sh\necho bun-foreign\n', { mode: 0o755 });
    await symlink(other, join(bunBinDir, 'vibeterm'));
    const installLayout = createInstallLayout(join(root, 'install'));
    await deployCliPackage(packageLayout, installLayout);

    const result = await installVibeTermShim({
      installLayout,
      bunPath: '/usr/bin/bun',
      localBinDir,
      bunBinDir,
      pathEnv: `${localBinDir}:${bunBinDir}`,
    });

    expect(result.bunLinkPath).toBeNull();
    expect(await readlink(join(bunBinDir, 'vibeterm'))).toBe(other);
    expect(result.skipWarning).toContain(
      t('cli.shim.skipForeign', { path: join(bunBinDir, 'vibeterm') })
    );
  });

  test('replacing ~/.bun/bin/vibeterm never unlinks the target before rename', async () => {
    const packageLayout = await makePackageRoot();
    const root = await mkdtemp(join(tmpdir(), 'vibeterm-shim-bun-atomic-'));
    tempDirs.push(root);
    const localBinDir = join(root, 'local-bin');
    const bunBinDir = join(root, 'bun-bin');
    await mkdir(bunBinDir, { recursive: true });
    const installLayout = createInstallLayout(join(root, 'install'));
    await deployCliPackage(packageLayout, installLayout);
    await installVibeTermShim({
      installLayout,
      bunPath: '/usr/bin/bun',
      localBinDir,
      bunBinDir,
      pathEnv: `${localBinDir}:${bunBinDir}`,
    });
    const linkPath = join(bunBinDir, 'vibeterm');
    expect(await pathExists(linkPath)).toBe(true);
    const previous = await readlink(linkPath);

    const tmp = `${linkPath}.${process.pid}.${Date.now()}.tmp`;
    await symlink(join(localBinDir, 'vibeterm'), tmp);
    expect(await pathExists(linkPath)).toBe(true);
    expect(await readlink(linkPath)).toBe(previous);

    const { rename } = await import('node:fs/promises');
    await rename(tmp, linkPath);
    expect(await pathExists(linkPath)).toBe(true);

    const source = await readFile(new URL('./cli-shim.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/await rm\(linkPath/);
  });
});

describe('removeVibeTermShims', () => {
  test('removes managed shim and bun symlink, leaves foreign binaries', async () => {
    const packageLayout = await makePackageRoot();
    const root = await mkdtemp(join(tmpdir(), 'vibeterm-shim-rm-'));
    tempDirs.push(root);
    const localBinDir = join(root, 'local-bin');
    const bunBinDir = join(root, 'bun-bin');
    await mkdir(bunBinDir, { recursive: true });
    const installLayout = createInstallLayout(join(root, 'install'));
    await deployCliPackage(packageLayout, installLayout);
    await installVibeTermShim({
      installLayout,
      bunPath: '/usr/bin/bun',
      localBinDir,
      bunBinDir,
      pathEnv: localBinDir,
    });
    const foreign = join(localBinDir, 'other');
    await writeFile(foreign, '#!/bin/sh\necho hi\n', { mode: 0o755 });

    await removeVibeTermShims({ localBinDir, bunBinDir });

    for (const name of ['vibeterm', 'tmex']) {
      await expect(stat(join(localBinDir, name))).rejects.toThrow();
      await expect(stat(join(bunBinDir, name))).rejects.toThrow();
    }
    expect(await readFile(foreign, 'utf8')).toContain('echo hi');
  });

  test('uninstall ignores a managed shim recorded for another install dir', async () => {
    const packageLayout = await makePackageRoot();
    const root = await mkdtemp(join(tmpdir(), 'vibeterm-shim-rm-other-'));
    tempDirs.push(root);
    const localBinDir = join(root, 'local-bin');
    const bunBinDir = join(root, 'bun-bin');
    await mkdir(bunBinDir, { recursive: true });
    const installLayout = createInstallLayout(join(root, 'install-keep'));
    await deployCliPackage(packageLayout, installLayout);
    await installVibeTermShim({
      installLayout,
      bunPath: '/usr/bin/bun',
      localBinDir,
      bunBinDir,
      pathEnv: localBinDir,
    });

    await removeVibeTermShims({
      localBinDir,
      bunBinDir,
      installDir: join(root, 'install-other'),
    });

    const shim = await readFile(join(localBinDir, 'vibeterm'), 'utf8');
    expect(shim).toContain(VIBETERM_SHIM_MARKER);
    expect(shim).toContain(`# vibeterm-install-dir: ${installLayout.installDir}`);
    expect(await readlink(join(bunBinDir, 'vibeterm'))).toBe(join(localBinDir, 'vibeterm'));

    await removeVibeTermShims({
      localBinDir,
      bunBinDir,
      installDir: installLayout.installDir,
    });
    for (const name of ['vibeterm', 'tmex']) {
      await expect(stat(join(localBinDir, name))).rejects.toThrow();
      await expect(stat(join(bunBinDir, name))).rejects.toThrow();
    }
  });
});

describe('shim compatibility with the pre-rename layout', () => {
  test('installs both vibeterm and tmex shims with identical content', async () => {
    const packageLayout = await makePackageRoot();
    const root = await mkdtemp(join(tmpdir(), 'vibeterm-shim-dual-'));
    tempDirs.push(root);
    const localBinDir = join(root, 'local-bin');
    const bunBinDir = join(root, 'bun-bin');
    await mkdir(bunBinDir, { recursive: true });
    const installLayout = createInstallLayout(join(root, 'install'));
    await deployCliPackage(packageLayout, installLayout);

    const result = await installVibeTermShim({
      installLayout,
      bunPath: '/usr/bin/bun',
      localBinDir,
      bunBinDir,
      pathEnv: localBinDir,
    });

    expect(result.aliasShimPath).toBe(join(localBinDir, 'tmex'));
    expect(result.aliasBunLinkPath).toBe(join(bunBinDir, 'tmex'));
    const primary = await readFile(join(localBinDir, 'vibeterm'), 'utf8');
    const alias = await readFile(join(localBinDir, 'tmex'), 'utf8');
    expect(alias).toBe(primary);
    expect(alias).toContain(join(installLayout.installDir, 'current', 'cli', 'bin', 'vibeterm.js'));
    expect(await readlink(join(bunBinDir, 'tmex'))).toBe(join(localBinDir, 'tmex'));
  });

  test('replaces a shim written before the rename and reports it as a leftover', async () => {
    const packageLayout = await makePackageRoot();
    const root = await mkdtemp(join(tmpdir(), 'vibeterm-shim-legacy-'));
    tempDirs.push(root);
    const localBinDir = join(root, 'local-bin');
    await mkdir(localBinDir, { recursive: true });
    const installLayout = createInstallLayout(join(root, 'install'));
    const legacyShim = `#!/usr/bin/env bash\n${LEGACY_SHIM_MARKER}\n${LEGACY_INSTALL_DIR_PREFIX} ${installLayout.installDir}\n`;
    await writeFile(join(localBinDir, 'tmex'), legacyShim, { mode: 0o755 });

    expect(await findLegacyMarkedShims({ localBinDir, bunBinDir: join(root, 'no-bun') })).toEqual([
      join(localBinDir, 'tmex'),
    ]);

    await deployCliPackage(packageLayout, installLayout);
    const result = await installVibeTermShim({
      installLayout,
      bunPath: '/usr/bin/bun',
      localBinDir,
      bunBinDir: join(root, 'no-bun'),
      pathEnv: localBinDir,
    });

    expect(result.skipWarning).toBeNull();
    expect(await readFile(join(localBinDir, 'tmex'), 'utf8')).toContain(VIBETERM_SHIM_MARKER);
    expect(await findLegacyMarkedShims({ localBinDir, bunBinDir: join(root, 'no-bun') })).toEqual(
      []
    );
  });

  test('removes a shim written before the rename when the install dir matches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vibeterm-shim-legacy-rm-'));
    tempDirs.push(root);
    const localBinDir = join(root, 'local-bin');
    await mkdir(localBinDir, { recursive: true });
    const installDir = join(root, 'install');
    await writeFile(
      join(localBinDir, 'tmex'),
      `#!/usr/bin/env bash\n${LEGACY_SHIM_MARKER}\n${LEGACY_INSTALL_DIR_PREFIX} ${installDir}\n`,
      { mode: 0o755 }
    );

    await removeVibeTermShims({ localBinDir, bunBinDir: join(root, 'no-bun'), installDir });
    await expect(stat(join(localBinDir, 'tmex'))).rejects.toThrow();
  });

  test('deploys both bins from a package that only ships bin/tmex.js', async () => {
    const packageRoot = await mkdtemp(join(tmpdir(), 'vibeterm-pkg-legacy-'));
    tempDirs.push(packageRoot);
    await mkdir(join(packageRoot, 'bin'), { recursive: true });
    await mkdir(join(packageRoot, 'dist'), { recursive: true });
    await writeFile(
      join(packageRoot, 'package.json'),
      `${JSON.stringify({ name: 'tmex-cli', version: '1.1.40', bin: { tmex: './bin/tmex.js' } })}\n`
    );
    await writeFile(join(packageRoot, 'bin', 'tmex.js'), 'legacy-entry\n');
    await writeFile(join(packageRoot, 'dist', 'cli-node.js'), 'export async function main() {}\n');
    const installDir = await mkdtemp(join(tmpdir(), 'vibeterm-install-legacy-'));
    tempDirs.push(installDir);
    const installLayout = createInstallLayout(installDir);

    await deployCliPackage(
      {
        packageRoot,
        cliDistPath: join(packageRoot, 'dist', 'cli-node.js'),
        runtimeDirPath: join(packageRoot, 'dist', 'runtime'),
        resourceFePath: join(packageRoot, 'resources', 'fe-dist'),
        resourceDrizzlePath: join(packageRoot, 'resources', 'gateway-drizzle'),
      },
      installLayout
    );

    expect(await readFile(join(installLayout.cliDir, 'bin', 'vibeterm.js'), 'utf8')).toBe(
      'legacy-entry\n'
    );
    expect(await readFile(join(installLayout.cliDir, 'bin', 'tmex.js'), 'utf8')).toBe(
      'legacy-entry\n'
    );
  });
});
