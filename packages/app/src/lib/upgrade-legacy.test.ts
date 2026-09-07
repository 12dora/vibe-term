import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathExists } from './fs-utils';
import { convertLegacyLayout, readRepairInstallMeta } from './upgrade-legacy';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('readRepairInstallMeta', () => {
  async function currentInstall(version = '2.0.0'): Promise<string> {
    const installDir = await mkdtemp(join(tmpdir(), 'vibeterm-repair-meta-'));
    tempDirs.push(installDir);
    await mkdir(join(installDir, 'versions', version), { recursive: true });
    await symlink(join('versions', version), join(installDir, 'current'));
    return installDir;
  }

  test.each(['{', 'null', '{}', '{"cliVersion":42}', '{"cliVersion":" "}'])(
    'derives metadata from current for invalid metadata %s without writing it',
    async (contents) => {
      const installDir = await currentInstall();
      const path = join(installDir, 'install-meta.json');
      await writeFile(path, contents);
      const result = await readRepairInstallMeta(installDir, '/usr/bin/bun');
      expect(result?.rebuilt).toBe(true);
      expect(result?.meta).toMatchObject({
        cliVersion: '2.0.0',
        serviceName: 'vibeterm',
        serviceMode: 'managed',
        installDir,
        bunPath: '/usr/bin/bun',
        platform: process.platform,
      });
      expect(await readFile(path, 'utf8')).toBe(contents);
    }
  );

  test('recovers missing metadata and selects the old default service name for 1.x', async () => {
    const installDir = await currentInstall('1.1.40');
    const result = await readRepairInstallMeta(installDir);
    expect(result?.meta.cliVersion).toBe('1.1.40');
    expect(result?.meta.serviceName).toBe('tmex');
    expect(await pathExists(join(installDir, 'install-meta.json'))).toBe(false);
  });

  test('preserves available service settings while rebuilding missing cliVersion', async () => {
    const installDir = await currentInstall();
    await writeFile(
      join(installDir, 'install-meta.json'),
      JSON.stringify({
        serviceName: 'custom',
        serviceMode: 'none',
        autostart: false,
        bunPath: '/custom/bun',
        installSource: 'install-script',
      })
    );
    expect((await readRepairInstallMeta(installDir))?.meta).toMatchObject({
      cliVersion: '2.0.0',
      serviceName: 'custom',
      serviceMode: 'none',
      autostart: false,
      bunPath: '/custom/bun',
      installSource: 'install-script',
    });
  });

  test('does not infer a version from an external current target or missing version directory', async () => {
    const installDir = await currentInstall();
    await rm(join(installDir, 'current'));
    await symlink('../external/2.0.0', join(installDir, 'current'));
    expect(await readRepairInstallMeta(installDir)).toBeNull();
    await rm(join(installDir, 'current'));
    await symlink('versions/9.9.9', join(installDir, 'current'));
    expect(await readRepairInstallMeta(installDir)).toBeNull();
  });

  test.each(['version-link', 'versions-link', 'file'] as const)(
    'rejects current targets that escape the install or are not directories: %s',
    async (kind) => {
      const installDir = await currentInstall();
      const externalDir = await mkdtemp(join(tmpdir(), 'vibeterm-external-version-'));
      tempDirs.push(externalDir);
      const versionDir = join(installDir, 'versions', '2.0.0');
      if (kind === 'versions-link') {
        await rm(join(installDir, 'versions'), { recursive: true });
        await mkdir(join(externalDir, '2.0.0'));
        await symlink(externalDir, join(installDir, 'versions'));
      } else {
        await rm(versionDir, { recursive: true });
        if (kind === 'version-link') await symlink(externalDir, versionDir);
        else await writeFile(versionDir, 'not a directory');
      }
      expect(await readRepairInstallMeta(installDir)).toBeNull();
    }
  );

  test('keeps readable metadata intact and does not fabricate a legacy layout version', async () => {
    const installDir = await currentInstall();
    const meta = {
      cliVersion: '1.1.40',
      serviceName: 'custom',
      platform: process.platform,
      autostart: false,
      installDir,
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    await writeFile(join(installDir, 'install-meta.json'), JSON.stringify(meta));
    expect(await readRepairInstallMeta(installDir)).toEqual({ meta, rebuilt: false });
    await rm(join(installDir, 'current'));
    await writeFile(join(installDir, 'install-meta.json'), '{}');
    expect(await readRepairInstallMeta(installDir)).toBeNull();
  });
});

describe('convertLegacyLayout', () => {
  test('copies top-level dirs into versions/<from> and creates current', async () => {
    const installDir = await mkdtemp(join(tmpdir(), 'vibeterm-legacy-'));
    tempDirs.push(installDir);
    await mkdir(join(installDir, 'cli', 'bin'), { recursive: true });
    await mkdir(join(installDir, 'runtime'), { recursive: true });
    await mkdir(join(installDir, 'resources', 'fe-dist'), { recursive: true });
    await mkdir(join(installDir, 'native'), { recursive: true });
    await writeFile(join(installDir, 'cli', 'bin', 'vibeterm.js'), 'legacy-cli\n');
    await writeFile(join(installDir, 'runtime', 'server.js'), 'legacy-runtime\n');
    await writeFile(join(installDir, 'resources', 'fe-dist', 'index.html'), '<html></html>\n');
    await writeFile(join(installDir, 'native', 'node_datachannel.node'), 'legacy-native\n');
    await writeFile(
      join(installDir, 'install-meta.json'),
      `${JSON.stringify({ cliVersion: '1.0.0', serviceName: 'vibeterm', installDir }, null, 2)}\n`
    );
    await writeFile(join(installDir, 'app.env'), 'GATEWAY_PORT=9883\n');

    await convertLegacyLayout(installDir, {
      bunPath: '/usr/bin/bun',
      skipShims: true,
      shimDirs: [join(installDir, '_shims'), join(installDir, '_bun-bin')],
    });

    expect(await readlink(join(installDir, 'current'))).toBe(join('versions', '1.0.0'));
    expect(
      await readFile(join(installDir, 'versions', '1.0.0', 'cli', 'bin', 'vibeterm.js'), 'utf8')
    ).toBe('legacy-cli\n');
    expect(await pathExists(join(installDir, 'cli'))).toBe(true);
    expect(
      await readFile(
        join(installDir, 'versions', '1.0.0', 'native', 'node_datachannel.node'),
        'utf8'
      )
    ).toBe('legacy-native\n');
    const run = await readFile(join(installDir, 'run.sh'), 'utf8');
    expect(run).toContain(`${installDir}/current/runtime/server.js`);
  });

  test('is a no-op when current already exists', async () => {
    const installDir = await mkdtemp(join(tmpdir(), 'vibeterm-legacy-skip-'));
    tempDirs.push(installDir);
    await mkdir(join(installDir, 'versions', '1.0.0'), { recursive: true });
    const { switchCurrent } = await import('./upgrade-switch');
    await switchCurrent(installDir, '1.0.0');
    await convertLegacyLayout(installDir, {
      bunPath: '/usr/bin/bun',
      skipShims: true,
      shimDirs: [join(installDir, '_shims'), join(installDir, '_bun-bin')],
    });
    expect(await readlink(join(installDir, 'current'))).toBe(join('versions', '1.0.0'));
  });

  test('aborts when install-meta has no cliVersion', async () => {
    const installDir = await mkdtemp(join(tmpdir(), 'vibeterm-legacy-meta-'));
    tempDirs.push(installDir);
    await mkdir(join(installDir, 'runtime'), { recursive: true });
    await writeFile(
      join(installDir, 'install-meta.json'),
      `${JSON.stringify({ serviceName: 'vibeterm' })}\n`
    );
    await expect(
      convertLegacyLayout(installDir, {
        bunPath: '/usr/bin/bun',
        skipShims: true,
        shimDirs: [join(installDir, '_shims'), join(installDir, '_bun-bin')],
      })
    ).rejects.toThrow(/cliVersion|install-meta/i);
  });

  test('does not write a shim when current/cli/bin/vibeterm.js is missing', async () => {
    const installDir = await mkdtemp(join(tmpdir(), 'vibeterm-legacy-nocli-'));
    tempDirs.push(installDir);
    const localBinDir = join(installDir, 'local-bin');
    await mkdir(localBinDir, { recursive: true });
    await mkdir(join(installDir, 'runtime'), { recursive: true });
    await writeFile(join(installDir, 'runtime', 'server.js'), 'legacy-runtime\n');
    await writeFile(join(localBinDir, 'vibeterm'), 'keep-me-shim\n');
    await writeFile(
      join(installDir, 'install-meta.json'),
      `${JSON.stringify({ cliVersion: '1.0.2', serviceName: 'vibeterm', installDir }, null, 2)}\n`
    );
    await convertLegacyLayout(installDir, {
      bunPath: '/usr/bin/bun',
      shimDirs: [localBinDir, join(installDir, 'missing-bun')],
    });
    expect(await readFile(join(localBinDir, 'vibeterm'), 'utf8')).toBe('keep-me-shim\n');
    expect(await pathExists(join(installDir, 'current', 'cli', 'bin', 'vibeterm.js'))).toBe(false);
  });

  test('writes a shim when the legacy layout has a CLI', async () => {
    const installDir = await mkdtemp(join(tmpdir(), 'vibeterm-legacy-cli-'));
    tempDirs.push(installDir);
    const localBinDir = join(installDir, 'local-bin');
    await mkdir(join(installDir, 'cli', 'bin'), { recursive: true });
    await mkdir(join(installDir, 'runtime'), { recursive: true });
    await writeFile(join(installDir, 'cli', 'bin', 'vibeterm.js'), 'legacy-cli\n');
    await writeFile(join(installDir, 'runtime', 'server.js'), 'legacy-runtime\n');
    await writeFile(
      join(installDir, 'install-meta.json'),
      `${JSON.stringify({ cliVersion: '1.0.0', serviceName: 'vibeterm', installDir }, null, 2)}\n`
    );
    await convertLegacyLayout(installDir, {
      bunPath: '/usr/bin/bun',
      shimDirs: [localBinDir, join(installDir, 'missing-bun')],
    });
    const shim = await readFile(join(localBinDir, 'vibeterm'), 'utf8');
    expect(shim).toContain('current/cli/bin/vibeterm.js');
  });
});
