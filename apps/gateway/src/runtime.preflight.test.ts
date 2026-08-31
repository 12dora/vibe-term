import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGatewayRuntime } from './runtime';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('createGatewayRuntime preflight', () => {
  test('runs migrations once and never starts live side effects', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tmex-preflight-rt-'));
    tempDirs.push(dir);
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = join(dir, 'tmex.db');
    let migrations = 0;
    let live = 0;
    try {
      const runtime = await createGatewayRuntime({
        mode: 'preflight',
        runMigrationsOnStart: true,
        runMigrationsFn: () => {
          migrations += 1;
        },
        liveStart: async () => {
          live += 1;
          throw new Error('live start must not run in preflight');
        },
      });
      expect(migrations).toBe(1);
      expect(live).toBe(0);
      runtime.restoreRemoteAgentSessions?.();
      expect(live).toBe(0);
      await runtime.stop();
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  });
});
