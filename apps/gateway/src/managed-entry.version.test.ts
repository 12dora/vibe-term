import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('managed gateway --version', () => {
  test('exits immediately without loading production config, creating DB, or binding a port', async () => {
    const work = mkdtempSync(join(tmpdir(), 'tmex-managed-version-'));
    temporaryDirectories.push(work);
    const databasePath = join(work, 'must-not-exist.db');
    const env = { ...process.env };
    Reflect.deleteProperty(env, 'TMEX_MASTER_KEY');
    env.NODE_ENV = 'production';
    env.DATABASE_URL = databasePath;
    env.GATEWAY_PORT = 'not-a-port';
    env.TMEX_BIND_HOST = '127.0.0.1';

    const startedAt = performance.now();
    const child = Bun.spawn(
      [process.execPath, resolve(import.meta.dir, 'managed-entry.ts'), '--version'],
      {
        cwd: work,
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );

    try {
      const completed = await Promise.race([
        Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]),
        Bun.sleep(1000).then(() => null),
      ]);
      if (completed === null) {
        child.kill('SIGKILL');
        await child.exited;
        throw new Error('managed gateway --version did not exit within one second');
      }

      const [exitCode, stdout, stderr] = completed;
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toMatch(/^tmex-gateway \S+$/);
      expect(stderr).toBe('');
      expect(performance.now() - startedAt).toBeLessThan(1000);
      expect(existsSync(databasePath)).toBe(false);
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await child.exited;
      }
    }
  });
});
