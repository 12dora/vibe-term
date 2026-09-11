import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEnvFile } from './env-file';
import { pathExists } from './fs-utils';
import { type UpgradeJournal, writeJournal } from './upgrade-state';
import { envFileBackupPath } from './upgrade-stun-env';
import { switchCurrent } from './upgrade-switch';
import { rollbackToOld } from './upgrade-txn';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('rollbackToOld app.env', () => {
  test('restores app.env from the txn backup including the frozen STUN key', async () => {
    const installDir = await mkdtemp(join(tmpdir(), 'vibeterm-txn-env-'));
    tempDirs.push(installDir);
    await mkdir(join(installDir, 'versions', '2.0.0', 'runtime'), { recursive: true });
    await mkdir(join(installDir, 'versions', '2.1.0', 'runtime'), { recursive: true });
    await writeFile(join(installDir, 'versions', '2.0.0', 'runtime', 'server.js'), 'export {}\n');
    await writeFile(join(installDir, 'versions', '2.1.0', 'runtime', 'server.js'), 'export {}\n');
    await switchCurrent(installDir, '2.1.0');

    const original = [
      'NODE_ENV=production',
      'GATEWAY_PORT=19883',
      'VIBETERM_BIND_HOST=127.0.0.1',
      'VIBETERM_MASTER_KEY=test',
      'VIBETERM_STUN_SERVERS=stun:stun.l.google.com:19302',
      '',
    ].join('\n');
    const migrated = original.replace('VIBETERM_STUN_SERVERS=stun:stun.l.google.com:19302\n', '');
    await writeFile(join(installDir, 'app.env'), migrated);
    await mkdir(join(installDir, 'backups', 'txn-stun'), { recursive: true });
    await writeFile(envFileBackupPath(installDir, 'txn-stun'), original);

    const journal: UpgradeJournal = {
      txnId: 'txn-stun',
      phase: 'started',
      fromVersion: '2.0.0',
      toVersion: '2.1.0',
      startedAt: '2026-08-31T00:00:00.000Z',
      updatedAt: '2026-08-31T00:00:01.000Z',
    };
    await writeJournal(installDir, journal);

    const service = {
      running: true,
      async stop() {
        this.running = false;
      },
      async start() {
        this.running = true;
      },
      async isRunning() {
        return this.running;
      },
    };

    await rollbackToOld(
      installDir,
      journal,
      '/usr/bin/bun',
      service,
      async () => undefined,
      'unhealthy',
      () => undefined
    );

    expect(await readFile(join(installDir, 'app.env'), 'utf8')).toBe(original);
    expect((await readEnvFile(join(installDir, 'app.env'))).VIBETERM_STUN_SERVERS).toBe(
      'stun:stun.l.google.com:19302'
    );
    expect(await pathExists(join(installDir, 'versions', '2.1.0'))).toBe(false);
  });
});
