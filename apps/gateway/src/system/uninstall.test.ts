import { afterEach, describe, expect, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestDispatchContext } from '../mesh/types';
import type { InstallInfo } from './install-info';
import { startLocalUninstall, uninstallController } from './uninstall';

const tempDirs: string[] = [];

afterEach(() => {
  uninstallController.resetForTests();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeCliInstall(installDir: string): void {
  const versionDir = join(installDir, 'versions', '1.2.3');
  mkdirSync(join(versionDir, 'cli', 'bin'), { recursive: true });
  writeFileSync(join(versionDir, 'cli', 'bin', 'tmex.js'), '#!/usr/bin/env node\n');
  symlinkSync(versionDir, join(installDir, 'current'));
  writeFileSync(
    join(installDir, 'install-meta.json'),
    `${JSON.stringify({ serviceName: 'tmex', installDir, platform: 'darwin' })}\n`
  );
}

function cliInstallInfo(installDir: string, extra?: Partial<InstallInfo>): InstallInfo {
  return {
    installedViaCli: true,
    deployment: 'launchd',
    installDir,
    serviceName: 'tmex',
    cliVersion: '1.2.3',
    bunPath: process.execPath,
    ...extra,
  };
}

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as EventEmitter & { unref: () => void };
  child.unref = () => undefined;
  queueMicrotask(() => child.emit('spawn'));
  return child as unknown as ChildProcess;
}

describe('UninstallController', () => {
  test('rejects when not installed via CLI', async () => {
    uninstallController.setDepsForTests({
      getInstallInfo: () =>
        cliInstallInfo('/tmp/nope', { installedViaCli: false, installDir: null }),
    });
    const res = await uninstallController.start();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      code: 'UNINSTALL_NOT_ALLOWED',
      reason: 'not_cli_install',
    });
  });

  test('rejects when deployment is none', async () => {
    const dir = tempDir('tmex-uninst-none-');
    uninstallController.setDepsForTests({
      getInstallInfo: () => cliInstallInfo(dir, { deployment: 'none' }),
    });
    const res = await uninstallController.start();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      code: 'UNINSTALL_NOT_ALLOWED',
      reason: 'no_service_manager',
    });
  });

  test('rejects when managed externally', async () => {
    const dir = tempDir('tmex-uninst-mng-');
    uninstallController.setDepsForTests({
      getInstallInfo: () => cliInstallInfo(dir),
      isManaged: () => true,
    });
    const res = await uninstallController.start();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      code: 'UNINSTALL_NOT_ALLOWED',
      reason: 'managed',
    });
  });

  test('rejects when an upgrade is in progress', async () => {
    const dir = tempDir('tmex-uninst-upg-');
    uninstallController.setDepsForTests({
      getInstallInfo: () => cliInstallInfo(dir),
      getUpgradeState: () => 'executing',
    });
    const res = await uninstallController.start();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'UPGRADE_IN_PROGRESS' });
  });

  test('copies CLI to a temp dir and spawns detached uninstall --yes --purge --delay-ms 1500', async () => {
    const installDir = tempDir('tmex-uninst-ok-');
    writeCliInstall(installDir);
    const copyRoot = tempDir('tmex-uninst-copies-');
    const spawned: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
    uninstallController.setDepsForTests({
      getInstallInfo: () => cliInstallInfo(installDir),
      tmpdir: () => copyRoot,
      randomId: () => 'deadbeef',
      spawn: (cmd, args, opts) => {
        spawned.push({
          cmd,
          args: [...args],
          opts: opts as Record<string, unknown>,
        });
        return fakeChild();
      },
    });
    const res = await uninstallController.start();
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      state: 'idle' | 'scheduled' | 'failed';
      startedAt: string | null;
      error: null;
    };
    expect(body.state).toBe('scheduled');
    expect(body.error).toBeNull();
    expect(typeof body.startedAt).toBe('string');
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.cmd).toBe(process.execPath);
    const tmpBin = join(copyRoot, 'tmex-uninstall-deadbeef', 'bin', 'tmex.js');
    expect(spawned[0]?.args).toEqual([
      tmpBin,
      'uninstall',
      '--yes',
      '--purge',
      '--install-dir',
      installDir,
      '--service-name',
      'tmex',
      '--delay-ms',
      '1500',
    ]);
    expect(spawned[0]?.opts.detached).toBe(true);
    expect(spawned[0]?.opts.stdio).toBe('ignore');
    expect(uninstallController.status()).toEqual(body);
  });

  test('second POST while scheduled is idempotent and does not spawn again', async () => {
    const installDir = tempDir('tmex-uninst-idemp-');
    writeCliInstall(installDir);
    const copyRoot = tempDir('tmex-uninst-idemp-tmp-');
    let spawns = 0;
    uninstallController.setDepsForTests({
      getInstallInfo: () => cliInstallInfo(installDir),
      tmpdir: () => copyRoot,
      randomId: () => 'abc',
      spawn: () => {
        spawns += 1;
        return fakeChild();
      },
    });
    const first = await uninstallController.start();
    const firstBody = await first.json();
    const second = await uninstallController.start();
    expect(second.status).toBe(202);
    expect(await second.json()).toEqual(firstBody);
    expect(spawns).toBe(1);
  });

  test('startLocalUninstall rejects requests without a user session', async () => {
    const res = await startLocalUninstall(
      new Request('http://localhost/api/system/uninstall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'full' }),
      })
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: 'UNAUTHORIZED' });
  });

  test('startLocalUninstall logs via and user then schedules when authenticated', async () => {
    const installDir = tempDir('tmex-uninst-auth-');
    writeCliInstall(installDir);
    const copyRoot = tempDir('tmex-uninst-auth-tmp-');
    uninstallController.setDepsForTests({
      getInstallInfo: () => cliInstallInfo(installDir),
      tmpdir: () => copyRoot,
      randomId: () => 'auth1',
      spawn: () => fakeChild(),
    });
    const req = new Request('http://localhost/api/system/uninstall', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'full' }),
    });
    requestDispatchContext.set(req, { uid: 'user-9', viaNodeId: 'self' });
    const lines: string[] = [];
    const originalInfo = console.info;
    console.info = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      const res = await startLocalUninstall(req);
      expect(res.status).toBe(202);
    } finally {
      console.info = originalInfo;
    }
    expect(
      lines.some((line) => line.includes('[system] uninstall requested via=self user=user-9'))
    ).toBe(true);
  });
});
