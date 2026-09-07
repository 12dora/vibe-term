import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setLang, t } from '../i18n';
import {
  LEGACY_INSTALL_DIR_PREFIX,
  LEGACY_SHIM_MARKER,
  VIBETERM_SHIM_MARKER,
  defaultShimDirs,
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

// 主目录沙箱由 packages/app/bunfig.toml 的测试预载挂上，只在以本包为工作目录跑
// `bun test` 时生效；从仓库根直接指定文件跑没有沙箱，断言沙箱的用例跳过而不是误报。
const sandboxHome = process.env.VIBETERM_TEST_HOME ?? '';

describe('defaultShimDirs', () => {
  test('points at the home dir', () => {
    const [localBinDir, bunBinDir] = defaultShimDirs();
    expect(localBinDir).toBe(join(homedir(), '.local', 'bin'));
    expect(bunBinDir).toBe(join(homedir(), '.bun', 'bin'));
  });

  test.skipIf(!sandboxHome)('resolves inside the test home sandbox', () => {
    expect(homedir()).toBe(sandboxHome);
    expect(defaultShimDirs()[0]).toBe(join(sandboxHome, '.local', 'bin'));
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
      force: true,
    });

    const shim = await readFile(result.shimPath, 'utf8');
    expect(shim).toContain(VIBETERM_SHIM_MARKER);
    expect(shim).toContain(`# vibeterm-install-dir: ${secondLayout.installDir}`);
    expect(shim).not.toContain(`# vibeterm-install-dir: ${firstLayout.installDir}`);
    expect(result.skipWarning).toBeNull();
  });

  test('refuses to take over a shim owned by another install that still exists', async () => {
    const packageLayout = await makePackageRoot();
    const root = await mkdtemp(join(tmpdir(), 'vibeterm-shim-owned-'));
    tempDirs.push(root);
    const localBinDir = join(root, 'local-bin');
    const bunBinDir = join(root, 'bun-bin');
    await mkdir(bunBinDir, { recursive: true });
    const firstLayout = createInstallLayout(join(root, 'install-a'));
    const secondLayout = createInstallLayout(join(root, 'install-b'));
    await deployCliPackage(packageLayout, firstLayout);
    await deployCliPackage(packageLayout, secondLayout);
    await writeFile(
      firstLayout.metaPath,
      JSON.stringify({
        installDir: firstLayout.installDir,
        cliVersion: '2.0.3',
        serviceName: 'vibeterm',
        platform: process.platform,
        autostart: false,
        updatedAt: new Date().toISOString(),
      })
    );

    await installVibeTermShim({
      installLayout: firstLayout,
      bunPath: '/usr/bin/bun',
      localBinDir,
      bunBinDir,
      pathEnv: localBinDir,
    });
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const result = await installVibeTermShim({
      installLayout: secondLayout,
      bunPath: '/usr/bin/bun',
      localBinDir,
      bunBinDir,
      pathEnv: localBinDir,
    });

    expect(await readFile(join(localBinDir, 'vibeterm'), 'utf8')).toContain(
      `# vibeterm-install-dir: ${firstLayout.installDir}`
    );
    expect(await readFile(join(localBinDir, 'tmex'), 'utf8')).toContain(
      `# vibeterm-install-dir: ${firstLayout.installDir}`
    );
    expect(result.bunLinkPath).toBeNull();
    expect(warn.mock.calls).toHaveLength(1);
    expect(String(warn.mock.calls[0]?.[0])).not.toContain('\n');
    warn.mockRestore();
    expect(result.shimDeployed).toBe(false);
    expect(result.skipWarning).toContain(firstLayout.installDir);
    expect(result.skipWarning).toContain('--replace-shim');
  });

  test('takes over a shim whose recorded install dir is gone', async () => {
    const packageLayout = await makePackageRoot();
    const root = await mkdtemp(join(tmpdir(), 'vibeterm-shim-orphan-'));
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
    await rm(firstLayout.installDir, { recursive: true, force: true });
    const result = await installVibeTermShim({
      installLayout: secondLayout,
      bunPath: '/usr/bin/bun',
      localBinDir,
      bunBinDir: join(root, 'missing-bun-bin'),
      pathEnv: localBinDir,
    });

    expect(await readFile(result.shimPath, 'utf8')).toContain(
      `# vibeterm-install-dir: ${secondLayout.installDir}`
    );
    expect(result.skipWarning).toBeNull();
  });

  test('refreshes its own shim without an override', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vibeterm-shim-same-'));
    tempDirs.push(root);
    const options = {
      installLayout: createInstallLayout(join(root, 'install')),
      bunPath: '/first/bun',
      localBinDir: join(root, 'local-bin'),
      bunBinDir: join(root, 'missing-bun-bin'),
    };
    await installVibeTermShim(options);
    const result = await installVibeTermShim({ ...options, bunPath: '/second/bun' });
    expect(result.shimDeployed).toBe(true);
    expect(result.skipWarning).toBeNull();
    expect(await readFile(result.shimPath, 'utf8')).toContain('/second/bun');
  });

  test.each([false, true])('unknown managed shim ownership requires override=%s', async (force) => {
    const root = await mkdtemp(join(tmpdir(), 'vibeterm-shim-unknown-'));
    tempDirs.push(root);
    const localBinDir = join(root, 'local-bin');
    await mkdir(localBinDir);
    const shimPath = join(localBinDir, 'vibeterm');
    const original = `#!/bin/sh\n${LEGACY_SHIM_MARKER}\n`;
    await writeFile(shimPath, original);
    const result = await installVibeTermShim({
      installLayout: createInstallLayout(join(root, 'install')),
      bunPath: '/usr/bin/bun',
      localBinDir,
      bunBinDir: join(root, 'missing-bun-bin'),
      force,
    });
    expect(result.shimDeployed).toBe(force);
    if (force) {
      expect(result.skipWarning).toBeNull();
      expect(await readFile(shimPath, 'utf8')).toContain(VIBETERM_SHIM_MARKER);
    } else {
      expect(result.skipWarning).toContain('--replace-shim');
      expect(await readFile(shimPath, 'utf8')).toBe(original);
      expect(await pathExists(result.aliasShimPath)).toBe(false);
    }
  });

  test.each([false, true])(
    'recognizes migrated legacy ownership, same install=%s',
    async (same) => {
      const root = await mkdtemp(join(tmpdir(), 'vibeterm-shim-migrated-'));
      tempDirs.push(root);
      const localBinDir = join(root, 'local-bin');
      const migratedDir = join(root, 'vibeterm');
      const legacyDir = join(root, 'tmex');
      await mkdir(localBinDir);
      await mkdir(migratedDir);
      await writeFile(
        join(migratedDir, 'install-meta.json'),
        JSON.stringify({
          installDir: migratedDir,
          cliVersion: '2.0.3',
        })
      );
      const original = `#!/bin/sh\n${LEGACY_SHIM_MARKER}\n${LEGACY_INSTALL_DIR_PREFIX} ${legacyDir}\n`;
      await writeFile(join(localBinDir, 'tmex'), original);
      const result = await installVibeTermShim({
        installLayout: createInstallLayout(same ? migratedDir : join(root, 'other')),
        bunPath: '/usr/bin/bun',
        localBinDir,
        bunBinDir: join(root, 'missing-bun-bin'),
      });
      expect(result.shimDeployed).toBe(same);
      if (same) {
        expect(result.skipWarning).toBeNull();
        expect(await readFile(result.aliasShimPath, 'utf8')).toContain(
          `# vibeterm-install-dir: ${migratedDir}`
        );
      } else {
        expect(result.skipWarning).toContain(migratedDir);
        expect(result.skipWarning).toContain('--replace-shim');
        expect(await readFile(result.aliasShimPath, 'utf8')).toBe(original);
        expect(await pathExists(result.shimPath)).toBe(false);
      }
    }
  );

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

describe('shim entry resolution at exec time', () => {
  async function makeFakeNodeDir(root: string): Promise<string> {
    const binDir = join(root, 'fake-node-bin');
    await mkdir(binDir, { recursive: true });
    await writeFile(
      join(binDir, 'node'),
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "v22.0.0"; exit 0; fi\necho "entry:$1"\n',
      { mode: 0o755 }
    );
    return binDir;
  }

  async function installShimForEntryTest(prefix: string): Promise<{
    root: string;
    installDir: string;
    cliBinDir: string;
    shimPath: string;
    nodeBinDir: string;
  }> {
    const packageLayout = await makePackageRoot();
    const root = await mkdtemp(join(tmpdir(), prefix));
    tempDirs.push(root);
    const installDir = join(root, 'install');
    const localBinDir = join(root, 'local-bin');
    const installLayout = createInstallLayout(installDir);
    await deployCliPackage(packageLayout, installLayout);
    const result = await installVibeTermShim({
      installLayout,
      bunPath: '',
      localBinDir,
      bunBinDir: join(root, 'missing-bun-bin'),
      pathEnv: localBinDir,
    });
    const cliBinDir = join(installDir, 'current', 'cli', 'bin');
    await mkdir(cliBinDir, { recursive: true });
    return {
      root,
      installDir,
      cliBinDir,
      shimPath: result.shimPath,
      nodeBinDir: await makeFakeNodeDir(root),
    };
  }

  function runShim(shimPath: string, nodeBinDir: string) {
    return spawnSync(shimPath, [], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${nodeBinDir}:/usr/bin:/bin` },
    });
  }

  test('falls back to bin/tmex.js after a rollback to a 1.x version dir', async () => {
    const ctx = await installShimForEntryTest('vibeterm-shim-entry-legacy-');
    await writeFile(join(ctx.cliBinDir, 'tmex.js'), 'legacy-entry\n');

    const run = runShim(ctx.shimPath, ctx.nodeBinDir);

    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe(`entry:${join(ctx.cliBinDir, 'tmex.js')}`);
  });

  test('prefers bin/vibeterm.js when both bins exist', async () => {
    const ctx = await installShimForEntryTest('vibeterm-shim-entry-both-');
    await writeFile(join(ctx.cliBinDir, 'tmex.js'), 'legacy-entry\n');
    await writeFile(join(ctx.cliBinDir, 'vibeterm.js'), 'entry\n');

    const run = runShim(ctx.shimPath, ctx.nodeBinDir);

    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe(`entry:${join(ctx.cliBinDir, 'vibeterm.js')}`);
  });

  test('reports a clear error when neither bin exists', async () => {
    const ctx = await installShimForEntryTest('vibeterm-shim-entry-none-');

    const run = runShim(ctx.shimPath, ctx.nodeBinDir);

    expect(run.status).toBe(127);
    expect(run.stdout).toBe('');
    expect(run.stderr.trim()).toBe(
      `vibeterm: cli entry not found: ${join(ctx.cliBinDir, 'vibeterm.js')}`
    );
  });

  test('the tmex alias shim resolves the same entry', async () => {
    const ctx = await installShimForEntryTest('vibeterm-shim-entry-alias-');
    await writeFile(join(ctx.cliBinDir, 'tmex.js'), 'legacy-entry\n');

    const run = runShim(join(ctx.root, 'local-bin', 'tmex'), ctx.nodeBinDir);

    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe(`entry:${join(ctx.cliBinDir, 'tmex.js')}`);
  });
});
