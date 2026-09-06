import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEnvFile } from './env-file';
import { pathExists } from './fs-utils';
import type { PackageLayout } from './install-layout';
import { type UpgradeServiceControl, repairServiceIdentity, repairUpgrade } from './upgrade-apply';
import {
  type DirMigrationPlan,
  type DirMigrationRecord,
  createMigrationRecord,
} from './upgrade-migrate-dir';
import { type UpgradeJournal, readJournal, writeJournal } from './upgrade-state';
import { readCurrentVersion, switchCurrent } from './upgrade-switch';
import { executeUpgradeTxn } from './upgrade-txn';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vibeterm-migrate-txn-'));
  tempDirs.push(dir);
  return dir;
}

async function writePackage(root: string, version: string): Promise<PackageLayout> {
  await mkdir(join(root, 'bin'), { recursive: true });
  await mkdir(join(root, 'dist', 'runtime'), { recursive: true });
  await mkdir(join(root, 'resources', 'fe-dist'), { recursive: true });
  await mkdir(join(root, 'resources', 'gateway-drizzle'), { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify({
      name: 'vibeterm-cli',
      version,
      bin: { vibeterm: './bin/vibeterm.js', tmex: './bin/tmex.js' },
    })}\n`
  );
  await writeFile(join(root, 'bin', 'vibeterm.js'), 'export {}\n');
  await writeFile(join(root, 'bin', 'tmex.js'), "import './vibeterm.js';\n");
  await writeFile(join(root, 'dist', 'cli-node.js'), 'export {}\n');
  await writeFile(join(root, 'dist', 'runtime', 'server.js'), 'export {}\n');
  await writeFile(join(root, 'resources', 'fe-dist', 'index.html'), '<html></html>\n');
  await writeFile(join(root, 'resources', 'gateway-drizzle', '0000.sql'), '--\n');
  return {
    packageRoot: root,
    cliDistPath: join(root, 'dist', 'cli-node.js'),
    runtimeDirPath: join(root, 'dist', 'runtime'),
    resourceFePath: join(root, 'resources', 'fe-dist'),
    resourceDrizzlePath: join(root, 'resources', 'gateway-drizzle'),
  };
}

/** 造一份「改名前」的已装目录（TMEX_* 键、data/tmex.db、serviceName=tmex）。 */
async function seedLegacyInstall(installDir: string, version: string): Promise<void> {
  const pkg = await writePackage(join(installDir, '_seed-pkg'), version);
  await mkdir(join(installDir, 'data'), { recursive: true });
  const { deployPackageToVersionDir } = await import('./upgrade-apply');
  await deployPackageToVersionDir(pkg, installDir, version);
  await switchCurrent(installDir, version);
  await writeFile(
    join(installDir, 'install-meta.json'),
    `${JSON.stringify({
      serviceName: 'tmex',
      platform: process.platform,
      autostart: false,
      installDir,
      updatedAt: '2026-01-01T00:00:00.000Z',
      cliVersion: version,
      bunPath: '/usr/bin/bun',
    })}\n`
  );
  await writeFile(
    join(installDir, 'app.env'),
    [
      'NODE_ENV=production',
      'GATEWAY_PORT=19883',
      'TMEX_BIND_HOST=127.0.0.1',
      'TMEX_MASTER_KEY=secret',
      'TMEX_ROLES=standalone',
      `DATABASE_URL=${join(installDir, 'data', 'tmex.db')}`,
      '',
    ].join('\n')
  );
  await writeFile(join(installDir, 'data', 'tmex.db'), 'db-bytes');
}

function fakeService(): UpgradeServiceControl & { running: boolean; starts: number } {
  return {
    running: true,
    starts: 0,
    async stop() {
      this.running = false;
    },
    async start() {
      this.running = true;
      this.starts += 1;
    },
    async isRunning() {
      return this.running;
    },
  };
}

async function setup(): Promise<{
  root: string;
  fromDir: string;
  toDir: string;
  plan: DirMigrationPlan;
  pkg: PackageLayout;
}> {
  const root = await scratch();
  const fromDir = join(root, 'tmex');
  const toDir = join(root, 'vibeterm');
  await seedLegacyInstall(fromDir, '1.1.40');
  const pkg = await writePackage(join(root, '_pkg2'), '2.0.0');
  return {
    root,
    fromDir,
    toDir,
    pkg,
    plan: { fromDir, toDir, moveDir: true, oldServiceName: 'tmex', newServiceName: 'vibeterm' },
  };
}

type TxnRun = {
  installDir: string;
  toVersion: string;
  packageLayout: PackageLayout;
  bunPath: string;
  noService: true;
  skipShims: true;
};

function txnOptions(fromDir: string, pkg: PackageLayout): TxnRun {
  return {
    installDir: fromDir,
    toVersion: '2.0.0',
    packageLayout: pkg,
    bunPath: '/usr/bin/bun',
    noService: true,
    skipShims: true,
  };
}

async function readMeta(dir: string): Promise<{
  serviceName?: string;
  cliVersion?: string;
  installDir?: string;
}> {
  return JSON.parse(await readFile(join(dir, 'install-meta.json'), 'utf8'));
}

describe('executeUpgradeTxn install dir migration', () => {
  test('moves the install, rewrites app.env and records the new service name', async () => {
    const { fromDir, toDir, plan, pkg } = await setup();
    const service = fakeService();
    const rebuilt: Array<{
      installDir: string;
      serviceName: string;
      legacyServiceName?: string;
      legacyLabel?: boolean;
    }> = [];

    const finalDir = await executeUpgradeTxn(
      txnOptions(fromDir, pkg),
      {
        service,
        runCandidate: async () => ({ stop: async () => undefined }),
        healthCheck: async () => undefined,
        rebuildService: (opts) => {
          rebuilt.push(opts);
          return service;
        },
      },
      {
        installDir: fromDir,
        toVersion: '2.0.0',
        packageLayout: pkg,
        bunPath: '/usr/bin/bun',
        txnId: 'txn-mig-ok',
        keepBackup: false,
        resolvedFrom: '1.1.40',
        service,
        healthCheck: async () => undefined,
        log: () => undefined,
        serviceMode: 'none',
        migrationPlan: plan,
      }
    );

    expect(finalDir).toBe(toDir);
    expect(await pathExists(fromDir)).toBe(false);
    expect(rebuilt).toEqual([
      { installDir: toDir, serviceName: 'vibeterm', legacyServiceName: 'tmex' },
    ]);
    expect(await readCurrentVersion(toDir)).toBe('2.0.0');

    const env = await readEnvFile(join(toDir, 'app.env'));
    expect(env.VIBETERM_MASTER_KEY).toBe('secret');
    expect(env.TMEX_MASTER_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBe(join(toDir, 'data', 'vibeterm.db'));

    const meta = await readMeta(toDir);
    expect(meta.serviceName).toBe('vibeterm');
    expect(meta.cliVersion).toBe('2.0.0');
    // 网页卸载按 meta.installDir 找安装，迁移后必须指向新目录
    expect(meta.installDir).toBe(toDir);

    const journal = await readJournal(toDir);
    expect(journal?.phase).toBe('committed');
    expect(journal?.dirMigration?.toDir).toBe(toDir);
    expect(await readFile(join(toDir, 'run.sh'), 'utf8')).toContain(toDir);
  });

  test('moves everything back and re-registers the old label when health fails', async () => {
    const { fromDir, toDir, plan, pkg } = await setup();
    const before = await readFile(join(fromDir, 'app.env'), 'utf8');
    const service = fakeService();
    const rebuilt: Array<{
      installDir: string;
      serviceName: string;
      legacyServiceName?: string;
      legacyLabel?: boolean;
    }> = [];

    await expect(
      executeUpgradeTxn(
        txnOptions(fromDir, pkg),
        {
          service,
          runCandidate: async () => ({ stop: async () => undefined }),
          healthCheck: async () => undefined,
          rebuildService: (opts) => {
            rebuilt.push(opts);
            return service;
          },
        },
        {
          installDir: fromDir,
          toVersion: '2.0.0',
          packageLayout: pkg,
          bunPath: '/usr/bin/bun',
          txnId: 'txn-mig-fail',
          keepBackup: false,
          resolvedFrom: '1.1.40',
          service,
          healthCheck: async ({ expectedVersion }) => {
            if (expectedVersion === '2.0.0') throw new Error('unhealthy');
          },
          log: () => undefined,
          serviceMode: 'none',
          migrationPlan: plan,
        }
      )
    ).rejects.toThrow();

    expect(await pathExists(toDir)).toBe(false);
    expect(await pathExists(fromDir)).toBe(true);
    expect(await readFile(join(fromDir, 'app.env'), 'utf8')).toBe(before);
    expect(await readFile(join(fromDir, 'data', 'tmex.db'), 'utf8')).toBe('db-bytes');
    expect(await pathExists(join(fromDir, 'data', 'vibeterm.db'))).toBe(false);
    expect(await readCurrentVersion(fromDir)).toBe('1.1.40');

    expect(rebuilt[0]).toEqual({
      installDir: toDir,
      serviceName: 'vibeterm',
      legacyServiceName: 'tmex',
    });
    // 回滚要拆掉的是迁移后真正注册出去的那份（com.vibeterm.vibeterm / vibeterm.service）
    expect(rebuilt[1]).toEqual({
      installDir: fromDir,
      serviceName: 'tmex',
      legacyServiceName: 'vibeterm',
      legacyLabel: true,
    });

    const journal = await readJournal(fromDir);
    expect(journal?.dirMigration).toBeUndefined();

    const meta = await readMeta(fromDir);
    expect(meta.serviceName).toBe('tmex');
    expect(meta.cliVersion).toBe('1.1.40');
    expect(meta.installDir).toBe(fromDir);
  });

  test('rewrites the env keys of a custom install dir without moving it', async () => {
    const { fromDir, toDir, pkg } = await setup();
    const service = fakeService();

    const finalDir = await executeUpgradeTxn(
      txnOptions(fromDir, pkg),
      {
        service,
        runCandidate: async () => ({ stop: async () => undefined }),
        healthCheck: async () => undefined,
      },
      {
        installDir: fromDir,
        toVersion: '2.0.0',
        packageLayout: pkg,
        bunPath: '/usr/bin/bun',
        txnId: 'txn-no-mig',
        keepBackup: false,
        resolvedFrom: '1.1.40',
        service,
        healthCheck: async () => undefined,
        log: () => undefined,
        serviceMode: 'none',
        migrationPlan: {
          fromDir,
          toDir: fromDir,
          moveDir: false,
          oldServiceName: 'tmex',
          newServiceName: 'tmex',
        },
      }
    );

    expect(finalDir).toBe(fromDir);
    expect(await pathExists(toDir)).toBe(false);
    const env = await readEnvFile(join(fromDir, 'app.env'));
    // 目录不搬家也要迁 env 键，否则 relay status 之类直接读 app.env 的命令找不到键
    expect(env.VIBETERM_MASTER_KEY).toBe('secret');
    expect(env.TMEX_MASTER_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBe(join(fromDir, 'data', 'tmex.db'));
    expect(await pathExists(join(fromDir, 'backups', 'app.env.txn-no-mig'))).toBe(true);

    const meta = await readMeta(fromDir);
    expect(meta.serviceName).toBe('tmex');
    expect(meta.installDir).toBe(fromDir);
  });

  test('keeps the migration in place when the new service refuses to stop', async () => {
    const { fromDir, toDir, plan, pkg } = await setup();
    const service = fakeService();
    const stuck: UpgradeServiceControl = {
      async stop() {
        throw new Error('launchctl bootout failed');
      },
      async start() {
        return undefined;
      },
      async isRunning() {
        return true;
      },
    };

    await expect(
      executeUpgradeTxn(
        txnOptions(fromDir, pkg),
        {
          service,
          runCandidate: async () => ({ stop: async () => undefined }),
          healthCheck: async () => undefined,
          rebuildService: () => stuck,
        },
        {
          installDir: fromDir,
          toVersion: '2.0.0',
          packageLayout: pkg,
          bunPath: '/usr/bin/bun',
          txnId: 'txn-stuck',
          keepBackup: false,
          resolvedFrom: '1.1.40',
          service,
          healthCheck: async ({ expectedVersion }) => {
            if (expectedVersion === '2.0.0') throw new Error('unhealthy');
          },
          log: () => undefined,
          serviceMode: 'none',
          migrationPlan: plan,
        }
      )
    ).rejects.toThrow(/--repair/);

    // 新服务没停下就绝不能动目录 / DB
    expect(await pathExists(fromDir)).toBe(false);
    expect(await pathExists(join(toDir, 'data', 'vibeterm.db'))).toBe(true);
    expect(await pathExists(join(toDir, 'data', 'tmex.db'))).toBe(false);
    const journal = await readJournal(toDir);
    expect(journal?.dirMigration?.toDir).toBe(toDir);
  });
});

describe('repairServiceIdentity', () => {
  test('uses the new identity while the migration stands and the old one when undoing it', () => {
    const record = createMigrationRecord({
      fromDir: '/old',
      toDir: '/new',
      moveDir: true,
      oldServiceName: 'tmex',
      newServiceName: 'vibeterm',
    });
    const journal: UpgradeJournal = {
      txnId: 't',
      phase: 'started',
      fromVersion: '1.1.40',
      toVersion: '2.0.0',
      startedAt: 'x',
      updatedAt: 'x',
      dirMigration: record,
    };

    expect(repairServiceIdentity('/new', journal, 'verify_or_rollback')).toEqual({
      installDir: '/new',
      identity: { serviceName: 'vibeterm', legacyServiceName: 'tmex' },
    });
    // 事务还没起过新版本：回到旧目录 + 旧 label，绝不去启动 com.vibeterm.tmex
    expect(repairServiceIdentity('/new', journal, 'restart_old')).toEqual({
      installDir: '/old',
      identity: { serviceName: 'tmex', legacyServiceName: 'vibeterm', legacyLabel: true },
    });
    // rename 没成功时记录作废
    expect(repairServiceIdentity('/old', journal, 'restart_old')).toEqual({
      installDir: '/old',
      identity: {},
    });
  });
});

describe('repairUpgrade after a crash inside the migration', () => {
  test('undoes the migration and brings the old version back', async () => {
    const { root, fromDir, toDir } = await setup();
    const before = await readFile(join(fromDir, 'app.env'), 'utf8');
    // 崩溃点还原：迁移记录先落盘，再 rename——journal 随目录一起搬到新路径
    const record = createMigrationRecord({
      fromDir,
      toDir,
      moveDir: true,
      oldServiceName: 'tmex',
      newServiceName: 'vibeterm',
    });
    await writeJournal(fromDir, {
      txnId: 'txn-crash',
      phase: 'migrate-install-dir',
      fromVersion: '1.1.40',
      toVersion: '2.0.0',
      startedAt: '2026-09-06T00:00:00.000Z',
      updatedAt: '2026-09-06T00:00:01.000Z',
      dirMigration: record,
    });
    const { rename } = await import('node:fs/promises');
    await rename(fromDir, toDir);

    const service = fakeService();
    const localBinDir = join(root, '_shims');
    const action = await repairUpgrade(toDir, '/usr/bin/bun', {
      service,
      healthCheck: async () => undefined,
      shimDirs: [localBinDir, join(root, '_bun-bin')],
    });

    expect(action).toBe('restart_old');
    expect(await pathExists(toDir)).toBe(false);
    expect(await readFile(join(fromDir, 'app.env'), 'utf8')).toBe(before);
    expect(await pathExists(join(fromDir, 'data', 'tmex.db'))).toBe(true);
    expect(await pathExists(join(fromDir, 'data', 'vibeterm.db'))).toBe(false);
    expect(await readCurrentVersion(fromDir)).toBe('1.1.40');

    const journal = await readJournal(fromDir);
    expect(journal?.dirMigration).toBeUndefined();
    expect(journal?.phase).toBe('aborted');
    expect((await readMeta(fromDir)).installDir).toBe(fromDir);
  });

  test('rolls the migration back when the started version fails its repair health check', async () => {
    const { root, fromDir, toDir, plan, pkg } = await setup();
    const before = await readFile(join(fromDir, 'app.env'), 'utf8');
    const service = fakeService();
    await executeUpgradeTxn(
      { ...txnOptions(fromDir, pkg), keepBackup: true },
      {
        service,
        runCandidate: async () => ({ stop: async () => undefined }),
        healthCheck: async () => undefined,
        rebuildService: () => service,
      },
      {
        installDir: fromDir,
        toVersion: '2.0.0',
        packageLayout: pkg,
        bunPath: '/usr/bin/bun',
        txnId: 'txn-started',
        keepBackup: true,
        resolvedFrom: '1.1.40',
        service,
        healthCheck: async () => undefined,
        log: () => undefined,
        serviceMode: 'none',
        migrationPlan: plan,
      }
    );
    // 模拟「新版本已启动、还没提交就断电」：journal 停在 started
    const committed = await readJournal(toDir);
    await writeJournal(toDir, { ...(committed as UpgradeJournal), phase: 'started' });

    const localBinDir = join(root, '_shims');
    const action = await repairUpgrade(toDir, '/usr/bin/bun', {
      service,
      healthCheck: async ({ expectedVersion }) => {
        if (expectedVersion === '2.0.0') throw new Error('unhealthy');
      },
      shimDirs: [localBinDir, join(root, '_bun-bin')],
    });

    expect(action).toBe('verify_or_rollback');
    expect(await pathExists(toDir)).toBe(false);
    expect(await readFile(join(fromDir, 'app.env'), 'utf8')).toBe(before);
    expect(await readFile(join(fromDir, 'data', 'tmex.db'), 'utf8')).toBe('db-bytes');
    expect(await readCurrentVersion(fromDir)).toBe('1.1.40');
    expect((await readJournal(fromDir))?.phase).toBe('rolled_back');
    expect((await readMeta(fromDir)).installDir).toBe(fromDir);
    expect((await readMeta(fromDir)).serviceName).toBe('tmex');
  });
});
