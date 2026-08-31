import { afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathExists } from './fs-utils';
import type { PackageLayout } from './install-layout';
import { type UpgradeServiceControl, applyUpgrade, repairUpgrade } from './upgrade-apply';
import { isPidAlive } from './upgrade-lock';
import { readJournal, writeJournal } from './upgrade-state';
import { readCurrentVersion, switchCurrent } from './upgrade-switch';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tmex-apply-'));
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
    `${JSON.stringify({ name: 'tmex-cli', version, bin: { tmex: './bin/tmex.js' } }, null, 2)}\n`
  );
  await writeFile(join(root, 'bin', 'tmex.js'), 'export {}\n');
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

async function seedInstall(installDir: string, version: string): Promise<void> {
  const pkg = await writePackage(join(installDir, '_seed-pkg'), version);
  await mkdir(join(installDir, 'versions', version, 'runtime'), { recursive: true });
  await mkdir(join(installDir, 'data'), { recursive: true });
  const { deployPackageToVersionDir } = await import('./upgrade-apply');
  await deployPackageToVersionDir(pkg, installDir, version);
  await switchCurrent(installDir, version);
  await writeFile(
    join(installDir, 'install-meta.json'),
    `${JSON.stringify(
      {
        serviceName: 'tmex',
        platform: process.platform,
        autostart: false,
        installDir,
        updatedAt: '2026-01-01T00:00:00.000Z',
        cliVersion: version,
        bunPath: '/usr/bin/bun',
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    join(installDir, 'app.env'),
    [
      'NODE_ENV=production',
      'TMEX_BIND_HOST=127.0.0.1',
      'GATEWAY_PORT=19883',
      `DATABASE_URL=${join(installDir, 'data', 'tmex.db')}`,
      'TMEX_MASTER_KEY=test',
      'TMEX_ROLES=standalone',
      '',
    ].join('\n')
  );
  await writeFile(join(installDir, 'data', 'tmex.db'), 'db-bytes');
}

function fakeService(): UpgradeServiceControl & {
  running: boolean;
  starts: number;
  stops: number;
} {
  return {
    running: true,
    starts: 0,
    stops: 0,
    async stop() {
      this.running = false;
      this.stops += 1;
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

describe('repairUpgrade journal recovery', () => {
  test('staging deletes candidate and staging then marks aborted', async () => {
    const installDir = await scratch();
    await seedInstall(installDir, '1.0.0');
    await mkdir(join(installDir, 'staging', 'txn-1'), { recursive: true });
    await mkdir(join(installDir, 'versions', '2.0.0'), { recursive: true });
    await writeFile(join(installDir, 'versions', '2.0.0', 'garbage'), 'x');
    await writeJournal(installDir, {
      txnId: 'txn-1',
      phase: 'staging',
      fromVersion: '1.0.0',
      toVersion: '2.0.0',
      startedAt: '2026-08-31T00:00:00.000Z',
      updatedAt: '2026-08-31T00:00:01.000Z',
    });

    const action = await repairUpgrade(installDir, '/usr/bin/bun', { service: fakeService() });
    expect(action).toBe('abort_candidate');
    expect(await pathExists(join(installDir, 'versions', '2.0.0'))).toBe(false);
    expect(await pathExists(join(installDir, 'staging', 'txn-1'))).toBe(false);
    expect(await readCurrentVersion(installDir)).toBe('1.0.0');
    expect((await readJournal(installDir))?.phase).toBe('aborted');
  });

  test('switching restarts the old service and drops the candidate', async () => {
    const installDir = await scratch();
    await seedInstall(installDir, '1.0.0');
    await mkdir(join(installDir, 'versions', '2.0.0'), { recursive: true });
    await writeJournal(installDir, {
      txnId: 'txn-2',
      phase: 'switching',
      fromVersion: '1.0.0',
      toVersion: '2.0.0',
      startedAt: '2026-08-31T00:00:00.000Z',
      updatedAt: '2026-08-31T00:00:01.000Z',
    });
    const service = fakeService();
    service.running = false;
    const action = await repairUpgrade(installDir, '/usr/bin/bun', {
      service,
      healthCheck: async () => undefined,
    });
    expect(action).toBe('restart_old');
    expect(service.starts).toBe(1);
    expect(await pathExists(join(installDir, 'versions', '2.0.0'))).toBe(false);
    expect((await readJournal(installDir))?.phase).toBe('aborted');
  });

  test('started commits when health check passes', async () => {
    const installDir = await scratch();
    await seedInstall(installDir, '1.0.0');
    const pkg = await writePackage(join(installDir, '_pkg2'), '2.0.0');
    const { deployPackageToVersionDir } = await import('./upgrade-apply');
    await deployPackageToVersionDir(pkg, installDir, '2.0.0');
    await switchCurrent(installDir, '2.0.0');
    await writeJournal(installDir, {
      txnId: 'txn-3',
      phase: 'started',
      fromVersion: '1.0.0',
      toVersion: '2.0.0',
      startedAt: '2026-08-31T00:00:00.000Z',
      updatedAt: '2026-08-31T00:00:01.000Z',
    });
    const action = await repairUpgrade(installDir, '/usr/bin/bun', {
      service: fakeService(),
      healthCheck: async ({ expectedVersion }) => {
        expect(expectedVersion).toBe('2.0.0');
      },
    });
    expect(action).toBe('verify_or_rollback');
    expect((await readJournal(installDir))?.phase).toBe('committed');
    expect(await readCurrentVersion(installDir)).toBe('2.0.0');
  });

  test('started repair never restarts a service that is already running', async () => {
    const installDir = await scratch();
    await seedInstall(installDir, '1.0.0');
    const pkg = await writePackage(join(installDir, '_pkg2b'), '2.0.0');
    const { deployPackageToVersionDir } = await import('./upgrade-apply');
    await deployPackageToVersionDir(pkg, installDir, '2.0.0');
    await switchCurrent(installDir, '2.0.0');
    await writeJournal(installDir, {
      txnId: 'txn-3b',
      phase: 'started',
      fromVersion: '1.0.0',
      toVersion: '2.0.0',
      startedAt: '2026-08-31T00:00:00.000Z',
      updatedAt: '2026-08-31T00:00:01.000Z',
    });
    const service = fakeService();
    await repairUpgrade(installDir, '/usr/bin/bun', {
      service,
      healthCheck: async () => undefined,
    });
    expect(service.starts).toBe(0);
    expect((await readJournal(installDir))?.phase).toBe('committed');
  });

  test('started rolls back when health check fails', async () => {
    const installDir = await scratch();
    await seedInstall(installDir, '1.0.0');
    const pkg = await writePackage(join(installDir, '_pkg2'), '2.0.0');
    const { deployPackageToVersionDir } = await import('./upgrade-apply');
    await deployPackageToVersionDir(pkg, installDir, '2.0.0');
    await switchCurrent(installDir, '2.0.0');
    await mkdir(join(installDir, 'backups', 'txn-4'), { recursive: true });
    await writeFile(join(installDir, 'backups', 'txn-4', 'tmex.db'), 'old-db');
    await writeJournal(installDir, {
      txnId: 'txn-4',
      phase: 'started',
      fromVersion: '1.0.0',
      toVersion: '2.0.0',
      startedAt: '2026-08-31T00:00:00.000Z',
      updatedAt: '2026-08-31T00:00:01.000Z',
      dbBackup: true,
    });
    await expect(
      repairUpgrade(installDir, '/usr/bin/bun', {
        service: fakeService(),
        healthCheck: async ({ expectedVersion }) => {
          if (expectedVersion === '2.0.0') throw new Error('new-unhealthy');
        },
      })
    ).resolves.toBe('verify_or_rollback');
    expect(await readCurrentVersion(installDir)).toBe('1.0.0');
    expect((await readJournal(installDir))?.phase).toBe('rolled_back');
    expect(await pathExists(join(installDir, 'versions', '2.0.0'))).toBe(false);
    expect(await readFile(join(installDir, 'data', 'tmex.db'), 'utf8')).toBe('old-db');
  });
});

describe('applyUpgrade live candidate', () => {
  test('preflight talks to a tiny Bun /healthz server then switches current', async () => {
    const installDir = await scratch();
    await seedInstall(installDir, '1.0.0');
    const pkgRoot = join(installDir, '_pkg2');
    const pkg = await writePackage(pkgRoot, '2.0.0');
    await writeFile(
      join(pkgRoot, 'dist', 'runtime', 'server.js'),
      `const version = "2.0.0";
const port = Number(process.env.GATEWAY_PORT);
Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch(req) {
    if (new URL(req.url).pathname === "/healthz") {
      return Response.json({ status: "ok", version });
    }
    return new Response("no", { status: 404 });
  },
});
`
    );
    const service = fakeService();
    await applyUpgrade(
      {
        installDir,
        toVersion: '2.0.0',
        packageLayout: pkg,
        bunPath: process.execPath,
        noService: true,
        skipShims: true,
      },
      {
        service,
        healthCheck: async (opts) => {
          if (opts.url.includes(':19883/')) return;
          const { pollHealthz } = await import('./upgrade-apply');
          await pollHealthz(opts);
        },
      }
    );
    expect(await readCurrentVersion(installDir)).toBe('2.0.0');
    expect((await readJournal(installDir))?.phase).toBe('committed');
  }, 30_000);
});

describe('applyUpgrade', () => {
  test('switches current after a successful preflight and prunes older versions', async () => {
    const installDir = await scratch();
    await seedInstall(installDir, '1.0.0');
    const pkg = await writePackage(join(installDir, '_pkg2'), '2.0.0');
    const service = fakeService();
    const healthCalls: string[] = [];

    await applyUpgrade(
      {
        installDir,
        toVersion: '2.0.0',
        packageLayout: pkg,
        bunPath: '/usr/bin/bun',
        noService: true,
        skipShims: true,
      },
      {
        service,
        runCandidate: async () => ({ stop: async () => undefined }),
        healthCheck: async ({ expectedVersion }) => {
          healthCalls.push(expectedVersion);
        },
        reenableDirect: async () => undefined,
      }
    );

    expect(await readlink(join(installDir, 'current'))).toBe(join('versions', '2.0.0'));
    expect((await readJournal(installDir))?.phase).toBe('committed');
    expect(service.stops).toBe(1);
    expect(service.starts).toBe(1);
    expect(healthCalls).toContain('2.0.0');
    expect(await pathExists(join(installDir, 'versions', '1.0.0'))).toBe(true);
    const committed = await readJournal(installDir);
    expect(committed?.phase).toBe('committed');
    expect(await pathExists(join(installDir, 'staging', committed?.txnId ?? 'missing'))).toBe(
      false
    );
    expect(await pathExists(join(installDir, 'versions', '2.0.0', 'runtime', 'server.js'))).toBe(
      true
    );
    const meta = JSON.parse(await readFile(join(installDir, 'install-meta.json'), 'utf8')) as {
      serviceMode?: string;
      cliVersion?: string;
    };
    expect(meta.cliVersion).toBe('2.0.0');
    expect(meta.serviceMode).toBe('none');
  });

  test('preflight failure never stops the old service and deletes the candidate', async () => {
    const installDir = await scratch();
    await seedInstall(installDir, '1.0.0');
    const pkg = await writePackage(join(installDir, '_pkg2'), '2.0.0');
    const service = fakeService();
    await expect(
      applyUpgrade(
        {
          installDir,
          toVersion: '2.0.0',
          packageLayout: pkg,
          bunPath: '/usr/bin/bun',
          noService: true,
          skipShims: true,
        },
        {
          service,
          runCandidate: async () => ({ stop: async () => undefined }),
          healthCheck: async () => {
            throw new Error('preflight-boom');
          },
        }
      )
    ).rejects.toThrow(/preflight-boom|Preflight/i);
    expect(service.stops).toBe(0);
    expect(await readCurrentVersion(installDir)).toBe('1.0.0');
    expect(await pathExists(join(installDir, 'versions', '2.0.0'))).toBe(false);
    expect((await readJournal(installDir))?.phase).toBe('aborted');
  });

  test('same-version apply is a healthy no-op and does not abort', async () => {
    const installDir = await scratch();
    await seedInstall(installDir, '1.0.0');
    const pkg = await writePackage(join(installDir, '_pkg-same'), '1.0.0');
    const logs: string[] = [];
    await applyUpgrade(
      {
        installDir,
        toVersion: '1.0.0',
        packageLayout: pkg,
        bunPath: '/usr/bin/bun',
        noService: true,
        skipShims: true,
      },
      {
        service: fakeService(),
        log: (message) => logs.push(message),
      }
    );
    expect(await readCurrentVersion(installDir)).toBe('1.0.0');
    expect(logs.join('\n')).toMatch(/1\.0\.0/);
    const journal = await readJournal(installDir);
    expect(journal === null || journal.phase !== 'aborted').toBe(true);
  });

  test('records keepBackup so a later repair does not delete the backup', async () => {
    const installDir = await scratch();
    await seedInstall(installDir, '1.0.0');
    const pkg = await writePackage(join(installDir, '_pkg2'), '2.0.0');
    await applyUpgrade(
      {
        installDir,
        toVersion: '2.0.0',
        packageLayout: pkg,
        bunPath: '/usr/bin/bun',
        noService: true,
        skipShims: true,
        keepBackup: true,
      },
      {
        service: fakeService(),
        runCandidate: async () => ({ stop: async () => undefined }),
        healthCheck: async () => undefined,
      }
    );
    const journal = await readJournal(installDir);
    expect(journal?.phase).toBe('committed');
    expect(journal?.keepBackup).toBe(true);
    expect(await pathExists(join(installDir, 'backups', journal?.txnId ?? ''))).toBe(true);
    await repairUpgrade(installDir, '/usr/bin/bun', {
      service: fakeService(),
      healthCheck: async () => undefined,
    });
    expect(await pathExists(join(installDir, 'backups', journal?.txnId ?? ''))).toBe(true);
  });
});

describe('repairUpgrade release gates', () => {
  test('rollback health check omits expectedVersion so 1.1.3 bodies can pass', async () => {
    const installDir = await scratch();
    await seedInstall(installDir, '1.1.3');
    const pkg = await writePackage(join(installDir, '_pkg2'), '1.1.4');
    const { deployPackageToVersionDir } = await import('./upgrade-apply');
    await deployPackageToVersionDir(pkg, installDir, '1.1.4');
    await switchCurrent(installDir, '1.1.4');
    await mkdir(join(installDir, 'backups', 'txn-113'), { recursive: true });
    await writeFile(join(installDir, 'backups', 'txn-113', 'tmex.db'), 'old-113');
    await writeJournal(installDir, {
      txnId: 'txn-113',
      phase: 'started',
      fromVersion: '1.1.3',
      toVersion: '1.1.4',
      startedAt: '2026-08-31T00:00:00.000Z',
      updatedAt: '2026-08-31T00:00:01.000Z',
      dbBackup: true,
    });
    const seen: Array<string | undefined> = [];
    await repairUpgrade(installDir, '/usr/bin/bun', {
      service: fakeService(),
      healthCheck: async ({ expectedVersion }) => {
        seen.push(expectedVersion);
        if (expectedVersion === '1.1.4') throw new Error('new-unhealthy');
      },
    });
    expect(seen[0]).toBe('1.1.4');
    expect(seen[1]).toBeUndefined();
    expect(await readCurrentVersion(installDir)).toBe('1.1.3');
    expect((await readJournal(installDir))?.phase).toBe('rolled_back');
  });

  test('rollback aborts and keeps journal plus backup when stop fails', async () => {
    const installDir = await scratch();
    await seedInstall(installDir, '1.0.0');
    await mkdir(join(installDir, 'versions', '2.0.0'), { recursive: true });
    await mkdir(join(installDir, 'backups', 'txn-stop'), { recursive: true });
    await writeFile(join(installDir, 'backups', 'txn-stop', 'tmex.db'), 'old-db');
    await switchCurrent(installDir, '2.0.0');
    await writeJournal(installDir, {
      txnId: 'txn-stop',
      phase: 'started',
      fromVersion: '1.0.0',
      toVersion: '2.0.0',
      startedAt: '2026-08-31T00:00:00.000Z',
      updatedAt: '2026-08-31T00:00:01.000Z',
      dbBackup: true,
    });
    const service = fakeService();
    service.stop = async () => {
      throw new Error('stop-failed');
    };
    await expect(
      repairUpgrade(installDir, '/usr/bin/bun', {
        service,
        healthCheck: async () => {
          throw new Error('new-unhealthy');
        },
      })
    ).rejects.toThrow(/stop-failed/);
    expect((await readJournal(installDir))?.phase).toBe('started');
    expect(await pathExists(join(installDir, 'backups', 'txn-stop', 'tmex.db'))).toBe(true);
    expect(await readFile(join(installDir, 'data', 'tmex.db'), 'utf8')).toBe('db-bytes');
  });

  test('repair from switching keeps journal and backup when start fails', async () => {
    const installDir = await scratch();
    await seedInstall(installDir, '1.0.0');
    await mkdir(join(installDir, 'versions', '2.0.0'), { recursive: true });
    await mkdir(join(installDir, 'backups', 'txn-start'), { recursive: true });
    await writeFile(join(installDir, 'backups', 'txn-start', 'tmex.db'), 'keep-me');
    await writeJournal(installDir, {
      txnId: 'txn-start',
      phase: 'switching',
      fromVersion: '1.0.0',
      toVersion: '2.0.0',
      startedAt: '2026-08-31T00:00:00.000Z',
      updatedAt: '2026-08-31T00:00:01.000Z',
      dbBackup: true,
    });
    const service = fakeService();
    service.running = false;
    service.start = async () => {
      throw new Error('bootstrap-failed');
    };
    await expect(
      repairUpgrade(installDir, '/usr/bin/bun', { service, healthCheck: async () => undefined })
    ).rejects.toThrow(/bootstrap-failed/);
    expect((await readJournal(installDir))?.phase).toBe('switching');
    expect(await pathExists(join(installDir, 'backups', 'txn-start', 'tmex.db'))).toBe(true);
    expect(await pathExists(join(installDir, 'versions', '2.0.0'))).toBe(true);
  });

  test('preflight repair kills the recorded candidate pid before deleting the dir', async () => {
    const installDir = await scratch();
    await seedInstall(installDir, '1.0.0');
    const serverJs = join(installDir, 'versions', '2.0.0', 'runtime', 'server.js');
    await mkdir(join(installDir, 'versions', '2.0.0', 'runtime'), { recursive: true });
    await writeFile(serverJs, 'export {}\n');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', serverJs], {
      stdio: 'ignore',
      detached: true,
    });
    if (!child.pid) throw new Error('failed to spawn candidate stand-in');
    child.unref();
    try {
      await writeJournal(installDir, {
        txnId: 'txn-cand',
        phase: 'preflight',
        fromVersion: '1.0.0',
        toVersion: '2.0.0',
        startedAt: '2026-08-31T00:00:00.000Z',
        updatedAt: '2026-08-31T00:00:01.000Z',
        candidatePid: child.pid,
        candidateStartedAt: new Date().toISOString(),
      });
      const action = await repairUpgrade(installDir, '/usr/bin/bun', {
        service: fakeService(),
        healthCheck: async () => undefined,
      });
      expect(action).toBe('abort_candidate');
      expect(isPidAlive(child.pid)).toBe(false);
      expect(await pathExists(join(installDir, 'versions', '2.0.0'))).toBe(false);
    } finally {
      try {
        process.kill(child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  });
});

describe('repairUpgrade active txn and legacy dirs', () => {
  test('missing journal keeps active staging and deletes orphan staging', async () => {
    const installDir = await scratch();
    await seedInstall(installDir, '1.0.0');
    await mkdir(join(installDir, 'staging', 'active-txn', 'extract'), { recursive: true });
    await writeFile(join(installDir, 'staging', 'active-txn', 'keep'), 'payload');
    await mkdir(join(installDir, 'staging', 'orphan'), { recursive: true });
    await writeFile(join(installDir, 'staging', 'orphan', 'x'), 'x');
    const action = await repairUpgrade(installDir, '/usr/bin/bun', {
      service: fakeService(),
      activeTxnId: 'active-txn',
    });
    expect(action).toBe('cleanup');
    expect(await pathExists(join(installDir, 'staging', 'active-txn', 'keep'))).toBe(true);
    expect(await pathExists(join(installDir, 'staging', 'orphan'))).toBe(false);
  });

  test('terminal journal cleanup keeps the active txn staging', async () => {
    const installDir = await scratch();
    await seedInstall(installDir, '1.0.0');
    await mkdir(join(installDir, 'staging', 'live-txn'), { recursive: true });
    await writeFile(join(installDir, 'staging', 'live-txn', 'keep'), 'y');
    await writeJournal(installDir, {
      txnId: 'live-txn',
      phase: 'aborted',
      fromVersion: '1.0.0',
      toVersion: '2.0.0',
      startedAt: '2026-08-31T00:00:00.000Z',
      updatedAt: '2026-08-31T00:00:01.000Z',
    });
    await repairUpgrade(installDir, '/usr/bin/bun', {
      service: fakeService(),
      activeTxnId: 'live-txn',
    });
    expect(await pathExists(join(installDir, 'staging', 'live-txn', 'keep'))).toBe(true);
  });

  test('legacy missing-journal repair plus failed preflight keeps top-level dirs', async () => {
    const installDir = await scratch();
    await mkdir(join(installDir, 'cli', 'bin'), { recursive: true });
    await mkdir(join(installDir, 'runtime'), { recursive: true });
    await mkdir(join(installDir, 'resources', 'fe-dist'), { recursive: true });
    await mkdir(join(installDir, 'native'), { recursive: true });
    await mkdir(join(installDir, 'data'), { recursive: true });
    await writeFile(join(installDir, 'cli', 'bin', 'tmex.js'), 'legacy-cli\n');
    await writeFile(join(installDir, 'runtime', 'server.js'), 'legacy-runtime\n');
    await writeFile(join(installDir, 'resources', 'fe-dist', 'index.html'), '<html></html>\n');
    await writeFile(join(installDir, 'native', 'node_datachannel.node'), 'legacy-native\n');
    await writeFile(join(installDir, 'data', 'tmex.db'), 'db-bytes');
    await writeFile(
      join(installDir, 'install-meta.json'),
      `${JSON.stringify(
        {
          serviceName: 'tmex',
          platform: process.platform,
          autostart: false,
          installDir,
          updatedAt: '2026-01-01T00:00:00.000Z',
          cliVersion: '1.0.0',
          bunPath: '/usr/bin/bun',
        },
        null,
        2
      )}\n`
    );
    await writeFile(
      join(installDir, 'app.env'),
      [
        'NODE_ENV=production',
        'TMEX_BIND_HOST=127.0.0.1',
        'GATEWAY_PORT=19883',
        `DATABASE_URL=${join(installDir, 'data', 'tmex.db')}`,
        'TMEX_MASTER_KEY=test',
        'TMEX_ROLES=standalone',
        '',
      ].join('\n')
    );
    const pkg = await writePackage(join(installDir, '_pkg2'), '2.0.0');
    const service = fakeService();
    await expect(
      applyUpgrade(
        {
          installDir,
          toVersion: '2.0.0',
          packageLayout: pkg,
          bunPath: '/usr/bin/bun',
          noService: true,
          skipShims: true,
        },
        {
          service,
          runCandidate: async () => ({ stop: async () => undefined }),
          healthCheck: async () => {
            throw new Error('preflight-boom');
          },
        }
      )
    ).rejects.toThrow(/preflight-boom|Preflight/i);
    expect(service.stops).toBe(0);
    expect(await pathExists(join(installDir, 'cli'))).toBe(true);
    expect(await pathExists(join(installDir, 'runtime'))).toBe(true);
    expect(await pathExists(join(installDir, 'resources'))).toBe(true);
    expect(await pathExists(join(installDir, 'native'))).toBe(true);
    expect(await pathExists(join(installDir, 'current'))).toBe(true);
  });
});

describe('repairUpgrade stopping and old health', () => {
  test('backup journal with service still running does not start again', async () => {
    const installDir = await scratch();
    await seedInstall(installDir, '1.0.0');
    await writeJournal(installDir, {
      txnId: 'txn-backup-run',
      phase: 'backup',
      fromVersion: '1.0.0',
      toVersion: '2.0.0',
      startedAt: '2026-08-31T00:00:00.000Z',
      updatedAt: '2026-08-31T00:00:01.000Z',
    });
    const service = fakeService();
    service.running = true;
    const action = await repairUpgrade(installDir, '/usr/bin/bun', {
      service,
      healthCheck: async () => undefined,
    });
    expect(action).toBe('restart_old');
    expect(service.starts).toBe(0);
  });

  test('backup journal with service stopped starts once', async () => {
    const installDir = await scratch();
    await seedInstall(installDir, '1.0.0');
    await writeJournal(installDir, {
      txnId: 'txn-backup-stop',
      phase: 'backup',
      fromVersion: '1.0.0',
      toVersion: '2.0.0',
      startedAt: '2026-08-31T00:00:00.000Z',
      updatedAt: '2026-08-31T00:00:01.000Z',
    });
    const service = fakeService();
    service.running = false;
    const action = await repairUpgrade(installDir, '/usr/bin/bun', {
      service,
      healthCheck: async () => undefined,
    });
    expect(action).toBe('restart_old');
    expect(service.starts).toBe(1);
  });

  test('stopping journal recovers via restart_old', async () => {
    const installDir = await scratch();
    await seedInstall(installDir, '1.0.0');
    await writeJournal(installDir, {
      txnId: 'txn-stopping',
      phase: 'stopping',
      fromVersion: '1.0.0',
      toVersion: '2.0.0',
      startedAt: '2026-08-31T00:00:00.000Z',
      updatedAt: '2026-08-31T00:00:01.000Z',
    });
    const service = fakeService();
    service.running = false;
    expect(
      await repairUpgrade(installDir, '/usr/bin/bun', {
        service,
        healthCheck: async () => undefined,
      })
    ).toBe('restart_old');
  });

  test('stop failure does not copy the database', async () => {
    const installDir = await scratch();
    await seedInstall(installDir, '1.0.0');
    const pkg = await writePackage(join(installDir, '_pkg2'), '2.0.0');
    const service = fakeService();
    service.stop = async () => {
      throw new Error('stop-failed');
    };
    await expect(
      applyUpgrade(
        {
          installDir,
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
        }
      )
    ).rejects.toThrow(/stop-failed/);
    const journal = await readJournal(installDir);
    expect(journal?.phase).toBe('stopping');
    expect(await pathExists(join(installDir, 'backups', journal?.txnId ?? 'missing'))).toBe(false);
    expect(await readFile(join(installDir, 'data', 'tmex.db'), 'utf8')).toBe('db-bytes');
  });

  test('1.0.2 managed repair uses status-only health and can roll back', async () => {
    const installDir = await scratch();
    await seedInstall(installDir, '1.0.2');
    const metaPath = join(installDir, 'install-meta.json');
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as Record<string, unknown>;
    meta.serviceMode = 'managed';
    await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
    const pkg = await writePackage(join(installDir, '_pkg2'), '1.1.4');
    const { deployPackageToVersionDir } = await import('./upgrade-apply');
    await deployPackageToVersionDir(pkg, installDir, '1.1.4');
    await switchCurrent(installDir, '1.1.4');
    await mkdir(join(installDir, 'backups', 'txn-102'), { recursive: true });
    await writeFile(join(installDir, 'backups', 'txn-102', 'tmex.db'), 'old-102');
    await writeJournal(installDir, {
      txnId: 'txn-102',
      phase: 'started',
      fromVersion: '1.0.2',
      toVersion: '1.1.4',
      startedAt: '2026-08-31T00:00:00.000Z',
      updatedAt: '2026-08-31T00:00:01.000Z',
      dbBackup: true,
    });
    const seen: Array<{ expectedVersion?: string; statusOnly?: boolean; minStartedAt?: string }> =
      [];
    await repairUpgrade(installDir, '/usr/bin/bun', {
      service: fakeService(),
      healthCheck: async (opts) => {
        seen.push({
          expectedVersion: opts.expectedVersion,
          statusOnly: opts.statusOnly,
          minStartedAt: opts.minStartedAt,
        });
        if (opts.expectedVersion === '1.1.4') throw new Error('new-unhealthy');
      },
    });
    expect(seen[0]?.expectedVersion).toBe('1.1.4');
    expect(seen[1]?.statusOnly).toBe(true);
    expect(seen[1]?.minStartedAt).toBeUndefined();
    expect(await readCurrentVersion(installDir)).toBe('1.0.2');
    expect((await readJournal(installDir))?.phase).toBe('rolled_back');
  });
});
