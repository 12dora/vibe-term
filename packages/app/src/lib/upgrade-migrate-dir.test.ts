import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { legacyInstallDir, newInstallDir } from '../constants';
import { readEnvFile } from './env-file';
import { pathExists } from './fs-utils';
import {
  type DirMigrationPlan,
  type DirMigrationRecord,
  createMigrationRecord,
  finishInstallDirMigration,
  legacyLaunchdLabelFor,
  migrateInstallDir,
  planInstallMigration,
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
  await writeFile(join(installDir, 'tmex.pid'), '{"pid":1}');
  await writeFile(join(installDir, 'tmex.log'), 'log');
  await writeFile(join(installDir, 'tmex.err.log'), 'err');
}

function movePlan(fromDir: string, toDir: string): DirMigrationPlan {
  return {
    fromDir,
    toDir,
    moveDir: true,
    oldServiceName: 'tmex',
    newServiceName: 'vibeterm',
  };
}

describe('planInstallMigration', () => {
  test('a custom install dir stays put but still gets the env key migration', async () => {
    const custom = await scratch();
    const plan = await planInstallMigration({
      installDir: custom,
      platform: 'linux',
      serviceName: 'tmex',
    });
    expect(plan.moveDir).toBe(false);
    expect(plan.fromDir).toBe(custom);
    expect(plan.toDir).toBe(custom);
    // 目录不搬家时服务名保持原样，只换 label 前缀
    expect(plan.newServiceName).toBe('tmex');
  });

  test('does not move when the new default directory already exists', async () => {
    const platform: NodeJS.Platform = process.platform === 'darwin' ? 'darwin' : 'linux';
    const plan = await planInstallMigration({
      installDir: legacyInstallDir(platform),
      platform,
      serviceName: 'tmex',
    });
    // 本机可能真的存在新目录；两种结果都要说得通。
    if (await pathExists(newInstallDir(platform))) {
      expect(plan.moveDir).toBe(false);
    } else {
      expect(plan.moveDir).toBe(true);
      expect(plan.fromDir).toBe(legacyInstallDir(platform));
      expect(plan.toDir).toBe(newInstallDir(platform));
      expect(plan.newServiceName).toBe('vibeterm');
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

    const record = await migrateInstallDir(movePlan(fromDir, toDir), { txnId: 'txn-1' });

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

  test('rewrites the env keys in place when the plan does not move the directory', async () => {
    const root = await scratch();
    const installDir = join(root, 'custom');
    await seedLegacyInstall(installDir);

    const record = await migrateInstallDir(
      {
        fromDir: installDir,
        toDir: installDir,
        moveDir: false,
        oldServiceName: 'tmex',
        newServiceName: 'tmex',
      },
      { txnId: 'txn-env-only' }
    );

    const env = await readEnvFile(join(installDir, 'app.env'));
    expect(env.VIBETERM_MASTER_KEY).toBe('secret');
    expect(env.TMEX_MASTER_KEY).toBeUndefined();
    // 目录没搬家，库文件名不动
    expect(env.DATABASE_URL).toBe(join(installDir, 'data', 'tmex.db'));
    expect(record?.dbRenamed).toBe(false);
    expect(await readFile(record?.envBackup as string, 'utf8')).toContain('TMEX_MASTER_KEY=secret');
  });

  test('writes nothing and keeps no backup when the env is already migrated', async () => {
    const root = await scratch();
    const installDir = join(root, 'custom');
    await mkdir(installDir, { recursive: true });
    await writeFile(join(installDir, 'app.env'), 'GATEWAY_PORT=9883\nVIBETERM_MASTER_KEY=k\n');

    const record = await migrateInstallDir(
      {
        fromDir: installDir,
        toDir: installDir,
        moveDir: false,
        oldServiceName: 'vibeterm',
        newServiceName: 'vibeterm',
      },
      { txnId: 'txn-noop' }
    );

    expect(record?.envRewritten).toBe(true);
    expect(record?.envBackup).toBeNull();
    expect(await pathExists(join(installDir, 'backups'))).toBe(false);
  });

  test('records every step in the journal before performing it', async () => {
    const root = await scratch();
    const fromDir = join(root, 'tmex');
    const toDir = join(root, 'vibeterm');
    await seedLegacyInstall(fromDir);

    const steps: Array<{
      record: DirMigrationRecord;
      dir: string;
      dbStillLegacy: boolean;
      envStillLegacy: boolean;
    }> = [];
    await migrateInstallDir(movePlan(fromDir, toDir), {
      txnId: 'txn-steps',
      persist: async (record, dir) => {
        const envPath = join(record.toDir, 'app.env');
        steps.push({
          record,
          dir,
          dbStillLegacy: await pathExists(join(record.toDir, 'data', 'tmex.db')),
          envStillLegacy: (await readFile(envPath, 'utf8').catch(() => '')).includes(
            'TMEX_MASTER_KEY'
          ),
        });
      },
    });

    // 第一条在 rename 之前写到旧目录，且什么都还没做
    expect(steps[0].dir).toBe(fromDir);
    expect(steps[0].record).toEqual(createMigrationRecord(movePlan(fromDir, toDir)));
    expect(steps.slice(1).every((step) => step.dir === toDir)).toBe(true);

    // 备份先落盘、DB 改名的意图先落盘，最后才是 envRewritten
    const backupStep = steps.find((step) => step.record.envBackup !== null);
    expect(backupStep?.envStillLegacy).toBe(true);
    const dbStep = steps.find((step) => step.record.dbRenamed);
    expect(dbStep?.dbStillLegacy).toBe(true);
    expect(steps.at(-1)?.record.envRewritten).toBe(true);
    expect(steps.findIndex((step) => step.record.dbRenamed)).toBeLessThan(steps.length - 1);
  });

  test('drops the stale pid file and archives the legacy logs', async () => {
    const root = await scratch();
    const fromDir = join(root, 'tmex');
    const toDir = join(root, 'vibeterm');
    await seedLegacyInstall(fromDir);

    await migrateInstallDir(movePlan(fromDir, toDir), { txnId: 'txn-files' });

    // 旧服务已经停了，tmex.pid 只会让后续判断误以为还有实例在跑
    expect(await pathExists(join(toDir, 'tmex.pid'))).toBe(false);
    expect(await pathExists(join(toDir, 'tmex.log'))).toBe(false);
    expect(await readFile(join(toDir, 'vibeterm.log.legacy'), 'utf8')).toBe('log');
    expect(await readFile(join(toDir, 'vibeterm.err.log.legacy'), 'utf8')).toBe('err');
  });

  test('returns null when the destination cannot be created', async () => {
    const root = await scratch();
    const fromDir = join(root, 'tmex');
    await seedLegacyInstall(fromDir);
    const record = await migrateInstallDir(
      movePlan(fromDir, join(root, 'missing-parent', 'deeper', 'vibeterm')),
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

    const record = (await migrateInstallDir(movePlan(fromDir, toDir), {
      txnId: 'txn-3',
    })) as DirMigrationRecord;

    await revertInstallDirMigration(record);

    expect(await pathExists(toDir)).toBe(false);
    expect(await readFile(join(fromDir, 'app.env'), 'utf8')).toBe(before);
    for (const suffix of ['', '-wal', '-shm']) {
      expect(await pathExists(join(fromDir, 'data', `tmex.db${suffix}`))).toBe(true);
      expect(await pathExists(join(fromDir, 'data', `vibeterm.db${suffix}`))).toBe(false);
    }
    expect(await readFile(join(fromDir, 'tmex.log'), 'utf8')).toBe('log');
    expect(await pathExists(join(fromDir, 'vibeterm.log.legacy'))).toBe(false);
  });

  test('restores the database names when the env rewrite never happened', async () => {
    const root = await scratch();
    const fromDir = join(root, 'tmex');
    const toDir = join(root, 'vibeterm');
    await seedLegacyInstall(fromDir);
    const before = await readFile(join(fromDir, 'app.env'), 'utf8');

    // 崩溃点：DB 已改名、app.env 还没写完（记录里 dbRenamed 先于改名落盘，所以是 true）
    const steps: DirMigrationRecord[] = [];
    await migrateInstallDir(movePlan(fromDir, toDir), {
      txnId: 'txn-crash-db',
      persist: async (record) => {
        steps.push(record);
      },
    });
    const crashed = steps.find((record) => record.dbRenamed && !record.envRewritten);
    expect(crashed).toBeDefined();

    await revertInstallDirMigration(crashed as DirMigrationRecord);

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
    await revertInstallDirMigration(
      createMigrationRecord(movePlan(fromDir, join(root, 'vibeterm')))
    );
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
      createMigrationRecord(movePlan(fromDir, toDir)),
      { txnId: 'txn-4' }
    );

    expect(finished.envRewritten).toBe(true);
    expect(finished.dbRenamed).toBe(true);
    const env = await readEnvFile(join(toDir, 'app.env'));
    expect(env.VIBETERM_MASTER_KEY).toBe('secret');
    expect(env.DATABASE_URL).toBe(join(toDir, 'data', 'vibeterm.db'));
  });

  test('points DATABASE_URL at the new name when the db was already renamed', async () => {
    const root = await scratch();
    const fromDir = join(root, 'tmex');
    const toDir = join(root, 'vibeterm');
    await seedLegacyInstall(fromDir);
    const { rename } = await import('node:fs/promises');
    await rename(fromDir, toDir);
    // 崩溃点：DB 三件套已经改名，app.env 还指着 tmex.db
    for (const suffix of ['', '-wal', '-shm']) {
      await rename(
        join(toDir, 'data', `tmex.db${suffix}`),
        join(toDir, 'data', `vibeterm.db${suffix}`)
      );
    }

    const finished = await finishInstallDirMigration(
      { ...createMigrationRecord(movePlan(fromDir, toDir)), dbRenamed: true },
      { txnId: 'txn-4b' }
    );

    expect(finished.envRewritten).toBe(true);
    const env = await readEnvFile(join(toDir, 'app.env'));
    expect(env.DATABASE_URL).toBe(join(toDir, 'data', 'vibeterm.db'));
    expect(await pathExists(join(toDir, 'data', 'vibeterm.db'))).toBe(true);
  });

  test('is idempotent', async () => {
    const root = await scratch();
    const fromDir = join(root, 'tmex');
    const toDir = join(root, 'vibeterm');
    await seedLegacyInstall(fromDir);
    const record = (await migrateInstallDir(movePlan(fromDir, toDir), {
      txnId: 'txn-5',
    })) as DirMigrationRecord;

    const again = await finishInstallDirMigration(record, { txnId: 'txn-5' });
    const env = await readEnvFile(join(toDir, 'app.env'));
    expect(again.dbRenamed).toBe(true);
    expect(env.DATABASE_URL).toBe(join(toDir, 'data', 'vibeterm.db'));
    expect(await pathExists(join(toDir, 'data', 'vibeterm.db'))).toBe(true);
    // 重跑不会再压一份备份
    expect(await readdir(join(toDir, 'backups'))).toEqual(['app.env.txn-5']);
  });
});
