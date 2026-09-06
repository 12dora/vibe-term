import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  LEGACY_PACKAGE_NAME,
  buildLegacyAsset,
} from '../../../../scripts/release/build-legacy-asset';
import { pathExists } from './fs-utils';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function packSourceTarball(version: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vibeterm-legacy-asset-'));
  tempDirs.push(root);
  await mkdir(join(root, 'package', 'bin'), { recursive: true });
  await mkdir(join(root, 'package', 'dist'), { recursive: true });
  await writeFile(
    join(root, 'package', 'package.json'),
    `${JSON.stringify(
      {
        name: 'vibeterm-cli',
        version,
        bin: {
          vibeterm: './bin/vibeterm.js',
          tmex: './bin/tmex.js',
          'vibeterm-cli': './bin/vibeterm.js',
        },
        files: ['bin', 'dist'],
      },
      null,
      2
    )}\n`
  );
  await writeFile(join(root, 'package', 'bin', 'vibeterm.js'), 'entry\n');
  await writeFile(join(root, 'package', 'bin', 'tmex.js'), "import './vibeterm.js';\n");
  await writeFile(join(root, 'package', 'dist', 'cli-node.js'), 'dist\n');

  const tgz = join(root, `vibeterm-cli-${version}.tgz`);
  const packed = spawnSync('tar', ['-czf', tgz, '-C', root, 'package'], { encoding: 'utf8' });
  expect(packed.status).toBe(0);
  return tgz;
}

describe('buildLegacyAsset', () => {
  test('repacks the tarball under the pre-rename name and package name', async () => {
    const source = await packSourceTarball('2.0.0');
    const out = buildLegacyAsset(source);

    expect(basename(out)).toBe(`${LEGACY_PACKAGE_NAME}-2.0.0.tgz`);
    expect(await pathExists(out)).toBe(true);

    const extract = await mkdtemp(join(tmpdir(), 'vibeterm-legacy-extract-'));
    tempDirs.push(extract);
    expect(spawnSync('tar', ['-xzf', out, '-C', extract], { encoding: 'utf8' }).status).toBe(0);

    const pkg = JSON.parse(
      await readFile(join(extract, 'package', 'package.json'), 'utf8')
    ) as Record<string, unknown>;
    expect(pkg.name).toBe('tmex-cli');
    expect(pkg.version).toBe('2.0.0');
    // ≤1.1.40 的 gateway 解包后按 bin.tmex 找入口
    expect((pkg.bin as Record<string, string>).tmex).toBe('./bin/tmex.js');
    expect((pkg.bin as Record<string, string>).vibeterm).toBe('./bin/vibeterm.js');

    expect(await readFile(join(extract, 'package', 'bin', 'vibeterm.js'), 'utf8')).toBe('entry\n');
    expect(await readFile(join(extract, 'package', 'bin', 'tmex.js'), 'utf8')).toBe(
      "import './vibeterm.js';\n"
    );
    expect(await readFile(join(extract, 'package', 'dist', 'cli-node.js'), 'utf8')).toBe('dist\n');
  });

  test('writes members in a stable sorted order', async () => {
    const source = await packSourceTarball('2.0.1');
    const listing = (path: string) =>
      spawnSync('tar', ['-tzf', path], { encoding: 'utf8' }).stdout.trim().split('\n');

    const first = listing(buildLegacyAsset(source));
    const second = listing(buildLegacyAsset(source));
    expect(first).toEqual(second);
    expect(first).toEqual([
      'package/bin/tmex.js',
      'package/bin/vibeterm.js',
      'package/dist/cli-node.js',
      'package/package.json',
    ]);
  });

  test('rejects a package that lost the legacy bin entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vibeterm-legacy-nobin-'));
    tempDirs.push(root);
    await mkdir(join(root, 'package', 'bin'), { recursive: true });
    await writeFile(
      join(root, 'package', 'package.json'),
      `${JSON.stringify({ name: 'vibeterm-cli', version: '2.0.0', bin: { vibeterm: './bin/vibeterm.js' } })}\n`
    );
    await writeFile(join(root, 'package', 'bin', 'vibeterm.js'), 'entry\n');
    const tgz = join(root, 'vibeterm-cli-2.0.0.tgz');
    expect(
      spawnSync('tar', ['-czf', tgz, '-C', root, 'package'], { encoding: 'utf8' }).status
    ).toBe(0);

    expect(() => buildLegacyAsset(tgz)).toThrow(/bin\.tmex/);
  });
});
