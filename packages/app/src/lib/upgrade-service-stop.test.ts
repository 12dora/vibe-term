import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createManagedServiceControl } from './upgrade-apply';
import { isPortBusy, waitForServiceRelease } from './upgrade-process';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function installDirWithPort(port: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vibeterm-stop-'));
  tempDirs.push(dir);
  await writeFile(
    join(dir, 'app.env'),
    [`GATEWAY_PORT=${port}`, 'VIBETERM_BIND_HOST=127.0.0.1', ''].join('\n')
  );
  return dir;
}

describe('waitForServiceRelease', () => {
  test('waits until the port is actually free', async () => {
    const installDir = await installDirWithPort(19999);
    let busy = 2;
    await waitForServiceRelease({
      installDir,
      timeoutMs: 5_000,
      probes: {
        ownedAlive: () => false,
        portBusy: async () => {
          busy -= 1;
          return busy > 0;
        },
      },
    });
    expect(busy).toBe(0);
  });

  test('warns and continues when a foreign process keeps the port', async () => {
    const installDir = await installDirWithPort(19999);
    const warnings: string[] = [];
    // 端口被别人占着不该让停服流程失败：自己的进程已经退出，后面的健康检查自会暴露问题
    await waitForServiceRelease({
      installDir,
      timeoutMs: 5_000,
      portGraceMs: 200,
      log: (message) => warnings.push(message),
      probes: { ownedAlive: () => false, portBusy: async () => true },
    });
    expect(warnings.join('\n')).toContain('still in use');
  });

  test('fails while the install still owns a live pid', async () => {
    const installDir = await installDirWithPort(19999);
    await expect(
      waitForServiceRelease({
        installDir,
        timeoutMs: 300,
        probes: { ownedAlive: () => true, portBusy: async () => false },
      })
    ).rejects.toThrow(/did not stop|未在/);
  });

  test('a free port reports as not busy', async () => {
    // 端口未被占用时必须返回 false，否则每次停服务都会白等到超时
    expect(await isPortBusy(0)).toBe(false);
  });
});

describe('createManagedServiceControl stop', () => {
  test('does not return before the port is released', async () => {
    const installDir = await installDirWithPort(19999);
    const probed: boolean[] = [];
    const control = createManagedServiceControl({
      serviceName: 'vibeterm',
      legacyServiceName: 'tmex',
      installDir,
      autostart: false,
      runScriptPath: join(installDir, 'run.sh'),
      deps: { manager: 'none', run: async () => ({ code: 0, stdout: '', stderr: '' }) },
      probes: {
        ownedAlive: () => false,
        portBusy: async () => {
          probed.push(true);
          return probed.length < 3;
        },
      },
    });

    await control.stop();
    expect(probed.length).toBe(3);
  });
});
