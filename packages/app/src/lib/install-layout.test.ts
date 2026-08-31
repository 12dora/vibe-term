import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstallLayout, hasCurrentLayout } from './install-layout';

describe('createInstallLayout', () => {
  test('nativeDir is <installDir>/native when current is absent', () => {
    const layout = createInstallLayout('/tmp/tmex-install-test');
    expect(layout.nativeDir).toBe(join('/tmp/tmex-install-test', 'native'));
    expect(layout.runtimeDir).toBe(join('/tmp/tmex-install-test', 'runtime'));
    expect(layout.runtimeCliAuthPath).toBe(
      join('/tmp/tmex-install-test', 'runtime', 'cli-auth.js')
    );
    expect(layout.runtimeServerPath).toBe(join('/tmp/tmex-install-test', 'runtime', 'server.js'));
    expect(layout.envPath).toBe(join('/tmp/tmex-install-test', 'app.env'));
    expect(layout.cliDir).toBe(join('/tmp/tmex-install-test', 'cli'));
    expect(layout.currentLink).toBe(join('/tmp/tmex-install-test', 'current'));
    expect(layout.versionsDir).toBe(join('/tmp/tmex-install-test', 'versions'));
  });

  test('resolves versioned paths through current when the symlink exists', async () => {
    const installDir = await mkdtemp(join(tmpdir(), 'tmex-layout-cur-'));
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
