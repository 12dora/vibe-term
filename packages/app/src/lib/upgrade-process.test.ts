import { afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPidAlive, processStartIdentity } from './upgrade-lock';
import {
  assertOwnedInstallProcess,
  cmdlineOwnsRuntime,
  createDirectProcessControl,
  formatPidRecord,
  killPidAndWait,
  parsePidRecord,
  processCommandLine,
} from './upgrade-process';

const tempDirs: string[] = [];
const livePids: number[] = [];

afterEach(async () => {
  for (const pid of livePids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('killPidAndWait', () => {
  test('SIGKILL path waits until the process is gone', async () => {
    const child = spawn('bash', ['-c', "trap '' TERM; sleep 30"], {
      stdio: 'ignore',
      detached: true,
    });
    if (!child.pid) throw new Error('spawn failed');
    child.unref();
    expect(isPidAlive(child.pid)).toBe(true);
    await killPidAndWait(child.pid, 8_000);
    expect(isPidAlive(child.pid)).toBe(false);
  });

  test('does not SIGTERM when ownership check fails immediately before signal', async () => {
    const signals: string[] = [];
    await expect(
      killPidAndWait(4242, 1_000, {
        isAlive: () => true,
        assertOwned: () => {
          throw new Error('not the tmex runtime');
        },
        kill: (_pid, sig) => {
          signals.push(String(sig));
        },
      })
    ).rejects.toThrow(/not the tmex runtime/);
    expect(signals).toEqual([]);
  });

  test('does not SIGKILL when ownership is lost after SIGTERM', async () => {
    const signals: string[] = [];
    let owned = true;
    await expect(
      killPidAndWait(4242, 1_000, {
        isAlive: () => true,
        assertOwned: () => {
          if (!owned) throw new Error('not the tmex runtime');
        },
        kill: (_pid, sig) => {
          signals.push(String(sig));
          if (sig === 'SIGTERM') owned = false;
        },
        waitExit: async () => {
          throw new Error('still alive');
        },
      })
    ).rejects.toThrow(/not the tmex runtime/);
    expect(signals).toEqual(['SIGTERM']);
  });

  test('skips signaling when the pid exits between verify and kill', async () => {
    const signals: string[] = [];
    let aliveChecks = 0;
    await killPidAndWait(4242, 1_000, {
      isAlive: () => {
        aliveChecks += 1;
        return aliveChecks === 1;
      },
      assertOwned: () => undefined,
      kill: (_pid, sig) => {
        signals.push(String(sig));
      },
    });
    expect(signals).toEqual([]);
  });
});

describe('parsePidRecord', () => {
  test('accepts a plain-number pid file', () => {
    expect(parsePidRecord('12345\n')).toEqual({ pid: 12345 });
  });

  test('accepts an extended JSON pid record', () => {
    const record = parsePidRecord(
      formatPidRecord({ pid: 9, identity: 'boot', runtimePath: '/tmp/server.js' })
    );
    expect(record?.pid).toBe(9);
    expect(record?.identity).toBe('boot');
    expect(record?.runtimePath).toBe('/tmp/server.js');
  });
});

describe('createDirectProcessControl', () => {
  test('foreign live PID throws on stop, does not signal, and keeps the pid file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tmex-direct-foreign-'));
    tempDirs.push(dir);
    const pidPath = join(dir, 'tmex.pid');
    const child = spawn('bash', ['-c', 'sleep 30'], {
      stdio: 'ignore',
      detached: true,
    });
    if (!child.pid) throw new Error('spawn failed');
    child.unref();
    livePids.push(child.pid);
    await writeFile(pidPath, `${child.pid}\n`);
    const control = createDirectProcessControl({
      runScriptPath: join(dir, 'missing-run.sh'),
      pidPath,
      installDir: dir,
    });
    await expect(control.stop()).rejects.toThrow(/not the tmex runtime|不属于/);
    expect(isPidAlive(child.pid)).toBe(true);
    expect(await Bun.file(pidPath).text()).toBe(`${child.pid}\n`);
    await expect(control.isRunning()).rejects.toThrow(/not the tmex runtime|不属于/);
  });

  test('owned current/runtime/server.js process can be stopped', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tmex-direct-owned-'));
    tempDirs.push(dir);
    const serverJs = join(dir, 'current', 'runtime', 'server.js');
    await mkdir(join(dir, 'current', 'runtime'), { recursive: true });
    await writeFile(serverJs, 'setInterval(() => {}, 1000);\n');
    const child = spawn(process.execPath, [serverJs], {
      stdio: 'ignore',
      detached: true,
    });
    if (!child.pid) throw new Error('spawn failed');
    child.unref();
    livePids.push(child.pid);
    const pidPath = join(dir, 'tmex.pid');
    await writeFile(pidPath, `${child.pid}\n`);
    // Linux 上 /proc/<pid>/cmdline 在 exec 完成前是空的，先等子进程真正带着 server.js 跑起来。
    for (let i = 0; i < 100 && !(processCommandLine(child.pid) ?? '').includes(serverJs); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assertOwnedInstallProcess({ pid: child.pid, installDir: dir });
    const control = createDirectProcessControl({
      runScriptPath: join(dir, 'missing-run.sh'),
      pidPath,
      installDir: dir,
    });
    expect(await control.isRunning()).toBe(true);
    await control.stop();
    expect(isPidAlive(child.pid)).toBe(false);
  });

  test('legacy pid with vim argv containing server.js is not owned', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tmex-direct-vim-'));
    tempDirs.push(dir);
    const serverJs = join(dir, 'current', 'runtime', 'server.js');
    await mkdir(join(dir, 'current', 'runtime'), { recursive: true });
    await writeFile(serverJs, 'export {}\n');
    const child = spawn('bash', ['-c', 'sleep 30'], {
      stdio: 'ignore',
      detached: true,
    });
    if (!child.pid) throw new Error('spawn failed');
    child.unref();
    livePids.push(child.pid);
    expect(() =>
      assertOwnedInstallProcess({
        pid: child.pid,
        installDir: dir,
        commandLine: `vim ${serverJs}`,
      })
    ).toThrow(/not the tmex runtime|不属于/);
  });

  test('legacy pid identity-primary still accepts a matching start identity', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tmex-direct-ident-'));
    tempDirs.push(dir);
    await mkdir(join(dir, 'current', 'runtime'), { recursive: true });
    await writeFile(join(dir, 'current', 'runtime', 'server.js'), 'export {}\n');
    const child = spawn('bash', ['-c', 'sleep 30'], {
      stdio: 'ignore',
      detached: true,
    });
    if (!child.pid) throw new Error('spawn failed');
    child.unref();
    livePids.push(child.pid);
    const identity = processStartIdentity(child.pid);
    expect(identity).toBeTruthy();
    assertOwnedInstallProcess({
      pid: child.pid,
      installDir: dir,
      expectedIdentity: identity,
      commandLine: `vim ${join(dir, 'current', 'runtime', 'server.js')}`,
    });
  });
});

describe('cmdlineOwnsRuntime', () => {
  test('requires bun/node executable and an argv token equal to the runtime path', () => {
    const runtime = '/tmp/tmex-install/current/runtime/server.js';
    expect(cmdlineOwnsRuntime(`bun ${runtime}`, [runtime])).toBe(true);
    expect(cmdlineOwnsRuntime(`/usr/local/bin/node ${runtime}`, [runtime])).toBe(true);
    expect(cmdlineOwnsRuntime(`vim ${runtime}`, [runtime])).toBe(false);
    expect(cmdlineOwnsRuntime(`tail -f ${runtime}`, [runtime])).toBe(false);
    expect(cmdlineOwnsRuntime(`bun ${runtime}.bak`, [runtime])).toBe(false);
    expect(cmdlineOwnsRuntime(`bun /tmp/other/server.js ${runtime}x`, [runtime])).toBe(false);
  });
});
