import { afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPidAlive } from './upgrade-lock';
import {
  assertOwnedInstallProcess,
  createDirectProcessControl,
  formatPidRecord,
  killPidAndWait,
  parsePidRecord,
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
});
