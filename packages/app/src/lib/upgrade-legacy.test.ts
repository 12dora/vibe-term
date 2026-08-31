import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathExists } from './fs-utils';
import { convertLegacyLayout } from './upgrade-legacy';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('convertLegacyLayout', () => {
  test('copies top-level dirs into versions/<from> and creates current', async () => {
    const installDir = await mkdtemp(join(tmpdir(), 'tmex-legacy-'));
    tempDirs.push(installDir);
    await mkdir(join(installDir, 'cli', 'bin'), { recursive: true });
    await mkdir(join(installDir, 'runtime'), { recursive: true });
    await mkdir(join(installDir, 'resources', 'fe-dist'), { recursive: true });
    await mkdir(join(installDir, 'native'), { recursive: true });
    await writeFile(join(installDir, 'cli', 'bin', 'tmex.js'), 'legacy-cli\n');
    await writeFile(join(installDir, 'runtime', 'server.js'), 'legacy-runtime\n');
    await writeFile(join(installDir, 'resources', 'fe-dist', 'index.html'), '<html></html>\n');
    await writeFile(join(installDir, 'native', 'node_datachannel.node'), 'legacy-native\n');
    await writeFile(
      join(installDir, 'install-meta.json'),
      `${JSON.stringify({ cliVersion: '1.0.0', serviceName: 'tmex', installDir }, null, 2)}\n`
    );
    await writeFile(join(installDir, 'app.env'), 'GATEWAY_PORT=9883\n');

    await convertLegacyLayout(installDir, {
      bunPath: '/usr/bin/bun',
      skipShims: true,
    });

    expect(await readlink(join(installDir, 'current'))).toBe(join('versions', '1.0.0'));
    expect(
      await readFile(join(installDir, 'versions', '1.0.0', 'cli', 'bin', 'tmex.js'), 'utf8')
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
    const installDir = await mkdtemp(join(tmpdir(), 'tmex-legacy-skip-'));
    tempDirs.push(installDir);
    await mkdir(join(installDir, 'versions', '1.0.0'), { recursive: true });
    const { switchCurrent } = await import('./upgrade-switch');
    await switchCurrent(installDir, '1.0.0');
    await convertLegacyLayout(installDir, { bunPath: '/usr/bin/bun', skipShims: true });
    expect(await readlink(join(installDir, 'current'))).toBe(join('versions', '1.0.0'));
  });

  test('aborts when install-meta has no cliVersion', async () => {
    const installDir = await mkdtemp(join(tmpdir(), 'tmex-legacy-meta-'));
    tempDirs.push(installDir);
    await mkdir(join(installDir, 'runtime'), { recursive: true });
    await writeFile(
      join(installDir, 'install-meta.json'),
      `${JSON.stringify({ serviceName: 'tmex' })}\n`
    );
    await expect(
      convertLegacyLayout(installDir, { bunPath: '/usr/bin/bun', skipShims: true })
    ).rejects.toThrow(/cliVersion|install-meta/i);
  });
});
