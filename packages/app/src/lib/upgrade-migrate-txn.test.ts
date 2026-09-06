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
  planInstallMigration,
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

function fakeService(failStopAt?: number): UpgradeServiceControl & {
  running: boolean;
  starts: number;
  stops: number;
} {
  return {
    running: true,
    starts: 0,
    stops: 0,
    async stop() {
      this.stops += 1;
      if (failStopAt !== undefined && this.stops === failStopAt) throw new Error('stop-boom');
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

/** 造一份「已经改完名」的安装：VIBETERM_* 键、data/vibeterm.db、serviceName=vibeterm。 */
async function seedModernInstall(installDir: string, version: string): Promise<void> {
  const pkg = await writePackage(join(installDir, '_seed-pkg'), version);
  await mkdir(join(installDir, 'data'), { recursive: true });
  const { deployPackageToVersionDir } = await import('./upgrade-apply');
  await deployPackageToVersionDir(pkg, installDir, version);
  await switchCurrent(installDir, version);
  await writeFile(
    join(installDir, 'install-meta.json'),
    `${JSON.stringify({
      serviceName: 'vibeterm',
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
      'VIBETERM_BIND_HOST=127.0.0.1',
      'VIBETERM_MASTER_KEY=secret',
      `DATABASE_URL=${join(installDir, 'data', 'vibeterm.db')}`,
      '',
    ].join('\n')
  );
  await writeFile(join(installDir, 'data', 'vibeterm.db'), 'db-bytes');
}

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

describe('restoring a pre-2.0 version', () => {
  test('the txn rollback re-registers under the legacy label and drops the new runtime files', async () => {
    const { fromDir, pkg } = await setup();
    const service = fakeService();
    const rebuilt: Array<{
      installDir: string;
      serviceName: string;
      legacyServiceName?: string;
      legacyLabel?: boolean;
    }> = [];
    // 2.0.0 起过一次留下的新命名残留
    await writeFile(join(fromDir, 'vibeterm.pid'), '{"pid":1}');
    await writeFile(join(fromDir, 'vibeterm.log'), 'new');
    await writeFile(join(fromDir, 'vibeterm.err.log'), 'new');

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
          txnId: 'txn-legacy-label',
          keepBackup: false,
          resolvedFrom: '1.1.40',
          service,
          healthCheck: async ({ expectedVersion }) => {
            if (expectedVersion === '2.0.0') throw new Error('unhealthy');
          },
          log: () => undefined,
          serviceMode: 'none',
          serviceName: 'tmex',
          migrationPlan: null,
        }
      )
    ).rejects.toThrow();

    // 1.1.40 的 runtime 只认 com.tmex.tmex / tmex.log
    expect(rebuilt).toEqual([
      {
        installDir: fromDir,
        serviceName: 'tmex',
        legacyServiceName: 'tmex',
        legacyLabel: true,
      },
    ]);
    expect(await pathExists(join(fromDir, 'vibeterm.pid'))).toBe(false);
    expect(await pathExists(join(fromDir, 'vibeterm.log'))).toBe(false);
    expect(await pathExists(join(fromDir, 'vibeterm.err.log'))).toBe(false);
  });

  test('repair restart_old without a migration uses the legacy label too', async () => {
    const { fromDir } = await setup();
    await writeJournal(fromDir, {
      txnId: 'txn-stopping',
      phase: 'stopping',
      fromVersion: '1.1.40',
      toVersion: '2.0.0',
      startedAt: '2026-09-06T00:00:00.000Z',
      updatedAt: '2026-09-06T00:00:01.000Z',
    });
    await writeFile(join(fromDir, 'vibeterm.pid'), '{"pid":1}');
    await writeFile(join(fromDir, 'vibeterm.log'), 'new');

    const service = fakeService();
    service.running = false;
    const rebuilt: Array<{
      installDir: string;
      serviceName: string;
      legacyServiceName?: string;
      legacyLabel?: boolean;
    }> = [];
    const { action } = await repairUpgrade(fromDir, '/usr/bin/bun', {
      healthCheck: async () => undefined,
      shimDirs: [join(fromDir, '_shims'), join(fromDir, '_bun-bin')],
      rebuildService: (opts) => {
        rebuilt.push(opts);
        return service;
      },
    });

    expect(action).toBe('restart_old');
    expect(service.starts).toBe(1);
    expect(rebuilt.at(-1)).toEqual({
      installDir: fromDir,
      serviceName: 'tmex',
      legacyServiceName: 'tmex',
      legacyLabel: true,
    });
    expect(await pathExists(join(fromDir, 'vibeterm.pid'))).toBe(false);
    expect(await pathExists(join(fromDir, 'vibeterm.log'))).toBe(false);
  });
});

describe('a 2.x upgrade that fails must keep the new service identity', () => {
  test('no migration plan, no relabel to com.tmex.*', async () => {
    const root = await scratch();
    const installDir = join(root, 'vibeterm');
    await seedModernInstall(installDir, '2.0.0');
    const pkg = await writePackage(join(root, '_pkg201'), '2.0.1');
    const service = fakeService();
    const rebuilt: unknown[] = [];

    // 已经是新目录 / 新 env：根本不该产生迁移计划
    expect(
      await planInstallMigration({ installDir, platform: 'linux', serviceName: 'vibeterm' })
    ).toBeNull();

    await expect(
      executeUpgradeTxn(
        { ...txnOptions(installDir, pkg), toVersion: '2.0.1' },
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
          installDir,
          toVersion: '2.0.1',
          packageLayout: pkg,
          bunPath: '/usr/bin/bun',
          txnId: 'txn-2x',
          keepBackup: false,
          resolvedFrom: '2.0.0',
          service,
          healthCheck: async ({ expectedVersion }) => {
            if (expectedVersion === '2.0.1') throw new Error('unhealthy');
          },
          log: () => undefined,
          serviceMode: 'none',
          serviceName: 'vibeterm',
          migrationPlan: null,
        }
      )
    ).rejects.toThrow();

    // 回滚到 2.0.0 不能把服务改回 com.tmex.*
    expect(rebuilt).toEqual([]);
    expect(await readCurrentVersion(installDir)).toBe('2.0.0');
    const env = await readEnvFile(join(installDir, 'app.env'));
    expect(env.DATABASE_URL).toBe(join(installDir, 'data', 'vibeterm.db'));
  });
});

describe('an interrupted migration undo', () => {
  test('repair keeps going towards the old version instead of the candidate', async () => {
    const { root, fromDir, toDir, plan, pkg } = await setup();
    // 第三次 stop（rollbackToOld 里那次）失败 = 撤销完目录、还没切回 current 就断电
    const service = fakeService(3);
    await expect(
      executeUpgradeTxn(
        txnOptions(fromDir, pkg),
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
          txnId: 'txn-undo-crash',
          keepBackup: true,
          resolvedFrom: '1.1.40',
          service,
          healthCheck: async ({ expectedVersion }) => {
            if (expectedVersion === '2.0.0') throw new Error('unhealthy');
          },
          log: () => undefined,
          serviceMode: 'none',
          serviceName: 'tmex',
          migrationPlan: plan,
        }
      )
    ).rejects.toThrow();

    // 目录已经搬回来了，但回滚还没收尾：记录必须留着，方向必须已经定死
    expect(await pathExists(toDir)).toBe(false);
    const crashed = await readJournal(fromDir);
    expect(crashed?.phase).toBe('reverting');
    expect(crashed?.dirMigration?.undone).toBe(true);
    expect(await readCurrentVersion(fromDir)).toBe('2.0.0');

    // 调用方在读 journal 之前建好的控制器不能被沿用（目录 / 身份都已经变了）
    const stale = fakeService();
    const restored = fakeService();
    restored.running = false;
    const rebuilt: Array<{
      installDir: string;
      serviceName: string;
      legacyServiceName?: string;
      legacyLabel?: boolean;
    }> = [];
    const { action, installDir } = await repairUpgrade(fromDir, '/usr/bin/bun', {
      service: stale,
      rebuildService: (opts) => {
        rebuilt.push(opts);
        return restored;
      },
      healthCheck: async () => undefined,
      shimDirs: [join(root, '_shims'), join(root, '_bun-bin')],
    });

    expect(action).toBe('restart_old');
    expect(installDir).toBe(fromDir);
    expect(stale.starts).toBe(0);
    expect(restored.starts).toBe(1);
    expect(rebuilt.at(-1)).toEqual({
      installDir: fromDir,
      serviceName: 'tmex',
      legacyServiceName: 'vibeterm',
      legacyLabel: true,
    });
    expect(await readCurrentVersion(fromDir)).toBe('1.1.40');
    const journal = await readJournal(fromDir);
    expect(journal?.phase).toBe('aborted');
    expect(journal?.dirMigration).toBeUndefined();
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
    // rename 没成功（或本来就没有迁移）：仍然按「恢复 1.x」用旧 label 注册
    expect(repairServiceIdentity('/old', journal, 'restart_old')).toEqual({
      installDir: '/old',
      identity: { legacyLabel: true },
    });
    // 恢复的是 2.x 就不该再用旧 label
    expect(
      repairServiceIdentity('/old', { ...journal, fromVersion: '2.0.0' }, 'restart_old')
    ).toEqual({ installDir: '/old', identity: {} });
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
    const { action } = await repairUpgrade(toDir, '/usr/bin/bun', {
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
    const { action } = await repairUpgrade(toDir, '/usr/bin/bun', {
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
