import { afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDirectProcessControl } from './upgrade-apply';
import { isPidAlive } from './upgrade-lock';
import { killPidAndWait } from './upgrade-process';

const tempDirs: string[] = [];

afterEach(async () => {
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

describe('createDirectProcessControl', () => {
  test('stop waits for SIGKILL to take effect', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tmex-direct-stop-'));
    tempDirs.push(dir);
    const pidPath = join(dir, 'tmex.pid');
    const child = spawn('bash', ['-c', "trap '' TERM; sleep 30"], {
      stdio: 'ignore',
      detached: true,
    });
    if (!child.pid) throw new Error('spawn failed');
    child.unref();
    await writeFile(pidPath, `${child.pid}\n`);
    const control = createDirectProcessControl({
      runScriptPath: join(dir, 'missing-run.sh'),
      pidPath,
    });
    await control.stop();
    expect(isPidAlive(child.pid)).toBe(false);
  });
});
