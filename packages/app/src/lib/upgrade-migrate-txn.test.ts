import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEnvFile } from './env-file';
import { pathExists } from './fs-utils';
import type { PackageLayout } from './install-layout';
import { type UpgradeServiceControl, repairUpgrade } from './upgrade-apply';
import type { DirMigrationPlan, DirMigrationRecord } from './upgrade-migrate-dir';
import { readJournal, writeJournal } from './upgrade-state';
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
    plan: { fromDir, toDir, oldServiceName: 'tmex', newServiceName: 'vibeterm' },
  };
}

describe('executeUpgradeTxn install dir migration', () => {
  test('moves the install, rewrites app.env and records the new service name', async () => {
    const { fromDir, toDir, plan, pkg } = await setup();
    const service = fakeService();
    const rebuilt: Array<{ installDir: string; serviceName: string; legacyLabel?: boolean }> = [];

    const finalDir = await executeUpgradeTxn(
      {
        installDir: fromDir,
        toVersion: '2.0.0',
        packageLayout: pkg,
        bunPath: '/usr/bin/bun',
        noService: true,
        skipShims: true,
      },
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
    expect(rebuilt).toEqual([{ installDir: toDir, serviceName: 'vibeterm' }]);
    expect(await readCurrentVersion(toDir)).toBe('2.0.0');

    const env = await readEnvFile(join(toDir, 'app.env'));
    expect(env.VIBETERM_MASTER_KEY).toBe('secret');
    expect(env.TMEX_MASTER_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBe(join(toDir, 'data', 'vibeterm.db'));

    const meta = JSON.parse(await readFile(join(toDir, 'install-meta.json'), 'utf8')) as {
      serviceName?: string;
      cliVersion?: string;
    };
    expect(meta.serviceName).toBe('vibeterm');
    expect(meta.cliVersion).toBe('2.0.0');

    const journal = await readJournal(toDir);
    expect(journal?.phase).toBe('committed');
    expect(journal?.dirMigration?.toDir).toBe(toDir);
    expect(await readFile(join(toDir, 'run.sh'), 'utf8')).toContain(toDir);
  });

  test('moves everything back and re-registers the old label when health fails', async () => {
    const { fromDir, toDir, plan, pkg } = await setup();
    const before = await readFile(join(fromDir, 'app.env'), 'utf8');
    const service = fakeService();
    const rebuilt: Array<{ installDir: string; serviceName: string; legacyLabel?: boolean }> = [];

    await expect(
      executeUpgradeTxn(
        {
          installDir: fromDir,
          toVersion: '2.0.0',
          packageLayout: pkg,
          bunPath: '/usr/bin/bun',
          noService: true,
          skipShims: true,
        },
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

    expect(rebuilt[0]).toEqual({ installDir: toDir, serviceName: 'vibeterm' });
    expect(rebuilt[1]).toEqual({
      installDir: fromDir,
      serviceName: 'tmex',
      legacyLabel: true,
    });

    const journal = await readJournal(fromDir);
    expect(journal?.dirMigration).toBeUndefined();

    const meta = JSON.parse(await readFile(join(fromDir, 'install-meta.json'), 'utf8')) as {
      serviceName?: string;
      cliVersion?: string;
    };
    expect(meta.serviceName).toBe('tmex');
    expect(meta.cliVersion).toBe('1.1.40');
  });

  test('leaves a custom install dir untouched when there is no migration plan', async () => {
    const { fromDir, toDir, pkg } = await setup();
    const service = fakeService();

    const finalDir = await executeUpgradeTxn(
      {
        installDir: fromDir,
        toVersion: '2.0.0',
        packageLayout: pkg,
        bunPath: '/usr/bin/bun',
        noService: true,
        skipShims: true,
      },
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
        migrationPlan: null,
      }
    );

    expect(finalDir).toBe(fromDir);
    expect(await pathExists(toDir)).toBe(false);
    const env = await readEnvFile(join(fromDir, 'app.env'));
    expect(env.TMEX_MASTER_KEY).toBe('secret');
    expect(env.DATABASE_URL).toBe(join(fromDir, 'data', 'tmex.db'));
    const meta = JSON.parse(await readFile(join(fromDir, 'install-meta.json'), 'utf8')) as {
      serviceName?: string;
    };
    expect(meta.serviceName).toBe('tmex');
  });
});

describe('repairUpgrade after a crash inside the migration', () => {
  test('finishes the env rewrite, the db rename and the run.sh rewrite', async () => {
    const { fromDir, toDir } = await setup();
    // 崩溃点：目录已 rename，app.env / DB / run.sh 都还是旧的
    const { rename } = await import('node:fs/promises');
    await rename(fromDir, toDir);
    const record: DirMigrationRecord = {
      fromDir,
      toDir,
      envBackup: null,
      envRewritten: false,
      dbRenamed: false,
      oldServiceName: 'tmex',
      newServiceName: 'vibeterm',
      oldLabel: 'com.tmex.tmex',
    };
    await writeJournal(toDir, {
      txnId: 'txn-crash',
      phase: 'migrate-install-dir',
      fromVersion: '1.1.40',
      toVersion: '2.0.0',
      startedAt: '2026-09-06T00:00:00.000Z',
      updatedAt: '2026-09-06T00:00:01.000Z',
      dirMigration: record,
    });

    const service = fakeService();
    const localBinDir = join(toDir, '_shims');
    const action = await repairUpgrade(toDir, '/usr/bin/bun', {
      service,
      healthCheck: async () => undefined,
      shimDirs: [localBinDir, join(toDir, '_bun-bin')],
    });

    expect(action).toBe('restart_old');
    const env = await readEnvFile(join(toDir, 'app.env'));
    expect(env.VIBETERM_MASTER_KEY).toBe('secret');
    expect(env.DATABASE_URL).toBe(join(toDir, 'data', 'vibeterm.db'));
    expect(await pathExists(join(toDir, 'data', 'vibeterm.db'))).toBe(true);
    expect(await readFile(join(toDir, 'run.sh'), 'utf8')).toContain(toDir);
    expect(await readFile(join(localBinDir, 'vibeterm'), 'utf8')).toContain(toDir);
    expect(await readFile(join(localBinDir, 'tmex'), 'utf8')).toContain(toDir);
  });
});
