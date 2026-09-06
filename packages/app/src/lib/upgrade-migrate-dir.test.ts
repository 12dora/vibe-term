import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { legacyInstallDir, newInstallDir } from '../constants';
import { readEnvFile } from './env-file';
import { pathExists } from './fs-utils';
import {
  type DirMigrationRecord,
  finishInstallDirMigration,
  legacyLaunchdLabelFor,
  migrateInstallDir,
  planInstallDirMigration,
  revertInstallDirMigration,
  rewriteEnvValues,
} from './upgrade-migrate-dir';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vibeterm-migrate-'));
  tempDirs.push(dir);
  return dir;
}

/** 造一份「改名前」的安装目录：TMEX_* 键、data/tmex.db 三件套。 */
async function seedLegacyInstall(installDir: string): Promise<void> {
  await mkdir(join(installDir, 'data'), { recursive: true });
  await writeFile(
    join(installDir, 'app.env'),
    [
      'NODE_ENV=production',
      'GATEWAY_PORT=9883',
      'TMEX_BIND_HOST=127.0.0.1',
      'TMEX_MASTER_KEY=secret',
      `TMEX_TLS_DIR=${join(installDir, 'tls')}`,
      `DATABASE_URL=${join(installDir, 'data', 'tmex.db')}`,
      '',
    ].join('\n')
  );
  await writeFile(join(installDir, 'data', 'tmex.db'), 'db');
  await writeFile(join(installDir, 'data', 'tmex.db-wal'), 'wal');
  await writeFile(join(installDir, 'data', 'tmex.db-shm'), 'shm');
  await writeFile(join(installDir, 'install-meta.json'), '{}');
}

describe('planInstallDirMigration', () => {
  test('only fires for the platform default legacy directory', async () => {
    const custom = await scratch();
    expect(
      await planInstallDirMigration({
        installDir: custom,
        platform: 'linux',
        serviceName: 'tmex',
      })
    ).toBeNull();
  });

  test('does not fire when the new default directory already exists', async () => {
    const platform: NodeJS.Platform = process.platform === 'darwin' ? 'darwin' : 'linux';
    const plan = await planInstallDirMigration({
      installDir: legacyInstallDir(platform),
      platform,
      serviceName: 'tmex',
    });
    // 本机可能真的存在新目录；两种结果都要说得通。
    if (await pathExists(newInstallDir(platform))) {
      expect(plan).toBeNull();
    } else {
      expect(plan?.fromDir).toBe(legacyInstallDir(platform));
      expect(plan?.toDir).toBe(newInstallDir(platform));
      expect(plan?.newServiceName).toBe('vibeterm');
    }
  });

  test('keeps a custom service name and derives the legacy launchd label', async () => {
    expect(legacyLaunchdLabelFor('tmex')).toBe('com.tmex.tmex');
    expect(legacyLaunchdLabelFor('work')).toBe('com.tmex.work');
    expect(homedir().length).toBeGreaterThan(0);
  });
});

describe('rewriteEnvValues', () => {
  test('renames the prefix and repoints values that live under the old directory', () => {
    const next = rewriteEnvValues(
      {
        TMEX_MASTER_KEY: 'k',
        TMEX_TLS_DIR: '/old/tls',
        DATABASE_URL: '/old/data/tmex.db',
        GATEWAY_PORT: '9883',
        UNRELATED: '/oldish/keep',
      },
      '/old',
      '/new'
    );
    expect(next).toEqual({
      VIBETERM_MASTER_KEY: 'k',
      VIBETERM_TLS_DIR: '/new/tls',
      DATABASE_URL: '/new/data/tmex.db',
      GATEWAY_PORT: '9883',
      UNRELATED: '/oldish/keep',
    });
  });

  test('an explicit new-prefix key wins over the renamed legacy one', () => {
    const next = rewriteEnvValues({ VIBETERM_ROLES: 'hub', TMEX_ROLES: 'node' }, '/old', '/new');
    expect(next.VIBETERM_ROLES).toBe('hub');
  });
});

describe('migrateInstallDir', () => {
  test('moves the directory, rewrites app.env and renames the database', async () => {
    const root = await scratch();
    const fromDir = join(root, 'tmex');
    const toDir = join(root, 'vibeterm');
    await seedLegacyInstall(fromDir);

    const record = await migrateInstallDir(
      { fromDir, toDir, oldServiceName: 'tmex', newServiceName: 'vibeterm' },
      { txnId: 'txn-1' }
    );

    expect(record).not.toBeNull();
    expect(record?.dbRenamed).toBe(true);
    expect(record?.envRewritten).toBe(true);
    expect(await pathExists(fromDir)).toBe(false);

    const env = await readEnvFile(join(toDir, 'app.env'));
    expect(env.VIBETERM_MASTER_KEY).toBe('secret');
    expect(env.TMEX_MASTER_KEY).toBeUndefined();
    expect(env.VIBETERM_TLS_DIR).toBe(join(toDir, 'tls'));
    expect(env.DATABASE_URL).toBe(join(toDir, 'data', 'vibeterm.db'));
    expect(env.GATEWAY_PORT).toBe('9883');

    for (const suffix of ['', '-wal', '-shm']) {
      expect(await pathExists(join(toDir, 'data', `vibeterm.db${suffix}`))).toBe(true);
      expect(await pathExists(join(toDir, 'data', `tmex.db${suffix}`))).toBe(false);
    }
    expect(await readFile(record?.envBackup as string, 'utf8')).toContain('TMEX_MASTER_KEY=secret');
  });

  test('returns null when the destination cannot be created', async () => {
    const root = await scratch();
    const fromDir = join(root, 'tmex');
    await seedLegacyInstall(fromDir);
    const record = await migrateInstallDir(
      {
        fromDir,
        toDir: join(root, 'missing-parent', 'deeper', 'vibeterm'),
        oldServiceName: 'tmex',
        newServiceName: 'vibeterm',
      },
      { txnId: 'txn-2' }
    );
    expect(record).toBeNull();
    expect(await pathExists(join(fromDir, 'app.env'))).toBe(true);
  });
});

describe('revertInstallDirMigration', () => {
  test('restores the directory, the app.env keys and the database file names', async () => {
    const root = await scratch();
    const fromDir = join(root, 'tmex');
    const toDir = join(root, 'vibeterm');
    await seedLegacyInstall(fromDir);
    const before = await readFile(join(fromDir, 'app.env'), 'utf8');

    const record = (await migrateInstallDir(
      { fromDir, toDir, oldServiceName: 'tmex', newServiceName: 'vibeterm' },
      { txnId: 'txn-3' }
    )) as DirMigrationRecord;

    await revertInstallDirMigration(record);

    expect(await pathExists(toDir)).toBe(false);
    expect(await readFile(join(fromDir, 'app.env'), 'utf8')).toBe(before);
    for (const suffix of ['', '-wal', '-shm']) {
      expect(await pathExists(join(fromDir, 'data', `tmex.db${suffix}`))).toBe(true);
      expect(await pathExists(join(fromDir, 'data', `vibeterm.db${suffix}`))).toBe(false);
    }
  });

  test('is a no-op when the migration never happened', async () => {
    const root = await scratch();
    const fromDir = join(root, 'tmex');
    await seedLegacyInstall(fromDir);
    await revertInstallDirMigration({
      fromDir,
      toDir: join(root, 'vibeterm'),
      envBackup: null,
      envRewritten: false,
      dbRenamed: false,
      oldServiceName: 'tmex',
      newServiceName: 'vibeterm',
      oldLabel: 'com.tmex.tmex',
    });
    expect(await pathExists(join(fromDir, 'app.env'))).toBe(true);
  });
});

describe('finishInstallDirMigration', () => {
  test('completes a migration that crashed between the rename and the env rewrite', async () => {
    const root = await scratch();
    const fromDir = join(root, 'tmex');
    const toDir = join(root, 'vibeterm');
    await seedLegacyInstall(fromDir);
    // 模拟崩溃：目录已经 rename，app.env / DB 还是旧的
    const { rename } = await import('node:fs/promises');
    await rename(fromDir, toDir);

    const finished = await finishInstallDirMigration(
      {
        fromDir,
        toDir,
        envBackup: null,
        envRewritten: false,
        dbRenamed: false,
        oldServiceName: 'tmex',
        newServiceName: 'vibeterm',
        oldLabel: 'com.tmex.tmex',
      },
      { txnId: 'txn-4' }
    );

    expect(finished.envRewritten).toBe(true);
    expect(finished.dbRenamed).toBe(true);
    const env = await readEnvFile(join(toDir, 'app.env'));
    expect(env.VIBETERM_MASTER_KEY).toBe('secret');
    expect(env.DATABASE_URL).toBe(join(toDir, 'data', 'vibeterm.db'));
  });

  test('is idempotent', async () => {
    const root = await scratch();
    const fromDir = join(root, 'tmex');
    const toDir = join(root, 'vibeterm');
    await seedLegacyInstall(fromDir);
    const record = (await migrateInstallDir(
      { fromDir, toDir, oldServiceName: 'tmex', newServiceName: 'vibeterm' },
      { txnId: 'txn-5' }
    )) as DirMigrationRecord;

    const again = await finishInstallDirMigration(record, { txnId: 'txn-5' });
    const env = await readEnvFile(join(toDir, 'app.env'));
    expect(again.dbRenamed).toBe(true);
    expect(env.DATABASE_URL).toBe(join(toDir, 'data', 'vibeterm.db'));
    expect(await pathExists(join(toDir, 'data', 'vibeterm.db'))).toBe(true);
  });
});
