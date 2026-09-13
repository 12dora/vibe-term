import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertRuntimeBundle, createInstallLayout, hasCurrentLayout } from './install-layout';

describe('createInstallLayout', () => {
  test('nativeDir is <installDir>/native when current is absent', () => {
    const layout = createInstallLayout('/tmp/vibeterm-install-test');
    expect(layout.nativeDir).toBe(join('/tmp/vibeterm-install-test', 'native'));
    expect(layout.runtimeDir).toBe(join('/tmp/vibeterm-install-test', 'runtime'));
    expect(layout.runtimeCliAuthPath).toBe(
      join('/tmp/vibeterm-install-test', 'runtime', 'cli-auth.js')
    );
    expect(layout.runtimeServerPath).toBe(
      join('/tmp/vibeterm-install-test', 'runtime', 'server.js')
    );
    expect(layout.envPath).toBe(join('/tmp/vibeterm-install-test', 'app.env'));
    expect(layout.cliDir).toBe(join('/tmp/vibeterm-install-test', 'cli'));
    expect(layout.currentLink).toBe(join('/tmp/vibeterm-install-test', 'current'));
    expect(layout.versionsDir).toBe(join('/tmp/vibeterm-install-test', 'versions'));
  });

  test('resolves versioned paths through current when the symlink exists', async () => {
    const installDir = await mkdtemp(join(tmpdir(), 'vibeterm-layout-cur-'));
    await mkdir(join(installDir, 'versions', '1.2.3'), { recursive: true });
    await symlink(join('versions', '1.2.3'), join(installDir, 'current'));
    expect(hasCurrentLayout(installDir)).toBe(true);
    const layout = createInstallLayout(installDir);
    expect(layout.nativeDir).toBe(join(installDir, 'current', 'native'));
    expect(layout.cliDir).toBe(join(installDir, 'current', 'cli'));
    expect(layout.envPath).toBe(join(installDir, 'app.env'));
    await rm(installDir, { recursive: true, force: true });
  });
});

describe('assertRuntimeBundle', () => {
  test('accepts a single-file runtime and requires chunks when referenced', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vibeterm-runtime-bundle-'));
    const runtimeDir = join(dir, 'runtime');
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(join(runtimeDir, 'server.js'), 'export {}\n');
    await assertRuntimeBundle(runtimeDir);

    await writeFile(join(runtimeDir, 'server.js'), 'import "./chunks/agent.js";\n');
    await expect(assertRuntimeBundle(runtimeDir)).rejects.toThrow(/chunks/);

    await mkdir(join(runtimeDir, 'chunks'), { recursive: true });
    await writeFile(join(runtimeDir, 'chunks', 'agent.js'), 'export {}\n');
    await assertRuntimeBundle(runtimeDir);
    await rm(dir, { recursive: true, force: true });
  });
});
