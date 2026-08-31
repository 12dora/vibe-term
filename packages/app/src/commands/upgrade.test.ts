import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseTarballName, releaseTarballUrl } from '../../../shared/src/release/source';
import { parseArgs } from '../lib/args';
import { sha256Hex } from '../lib/artifacts-manifest';
import { pathExists } from '../lib/fs-utils';
import { packNpmTarball } from '../lib/native-tarball';
import { runCommand } from '../lib/process';
import { releaseSha256SumsUrl } from '../lib/release-fetch';
import { readJournal } from '../lib/upgrade-state';
import { readCurrentVersion } from '../lib/upgrade-switch';
import { delegateUpgrade, reenableDirectAfterUpgrade, runUpgrade } from './upgrade';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function fakeFetch(tarball: Uint8Array): (url: string | URL) => Promise<Response> {
  return async (url) => {
    const href = String(url);
    if (href === releaseTarballUrl('1.1.0') || href.includes('tmex-cli-')) {
      return new Response(tarball, { status: 200 });
    }
    if (href.includes('SHA256SUMS')) {
      return new Response('missing', { status: 404 });
    }
    return new Response('nope', { status: 404 });
  };
}

describe('reenableDirectAfterUpgrade', () => {
  test('calls reenableDirectIfNeeded with installDir', async () => {
    let calledWith: string | undefined;
    await reenableDirectAfterUpgrade('/tmp/tmex-upgrade', {
      reenableDirectIfNeeded: async ({ installDir }) => {
        calledWith = installDir;
        return {
          ok: true,
          skipped: true,
          platformId: '',
          version: '',
          addonPath: '',
        };
      },
    });
    expect(calledWith).toBe('/tmp/tmex-upgrade');
  });

  test('does not throw when reenable reports failure', async () => {
    const logs: string[] = [];
    await reenableDirectAfterUpgrade('/tmp/tmex-upgrade-fail', {
      reenableDirectIfNeeded: async () => ({ ok: false, reason: 'integrity mismatch' }),
      log: (message) => logs.push(message),
    });
    expect(logs.join('\n')).toContain('integrity mismatch');
  });

  test('swallows thrown errors from reenableDirectIfNeeded', async () => {
    await reenableDirectAfterUpgrade('/tmp/tmex-upgrade-throw', {
      reenableDirectIfNeeded: async () => {
        throw new Error('no network');
      },
      log: () => undefined,
    });
  });
});

describe('delegateUpgrade', () => {
  test('downloads the GitHub release tarball and re-execs upgrade --apply-current-package', async () => {
    const installDir = await mkdtemp(join(tmpdir(), 'tmex-upg-dl-'));
    tempDirs.push(installDir);
    const tarball = packNpmTarball({
      'package/package.json': '{"name":"tmex-cli","version":"1.1.0"}\n',
      'package/bin/tmex.js': 'export {}\n',
    });
    const spawned: Array<{ command: string; args: string[] }> = [];
    const logs: string[] = [];

    await delegateUpgrade(
      {
        command: 'upgrade',
        positionals: [],
        flags: {
          lang: 'en',
          'bun-path': '/custom/bun',
          'install-dir': installDir,
          'allow-unverified': true,
        },
      },
      '1.1.0',
      {
        fetch: fakeFetch(tarball),
        runCommand: async (command, args, options) => {
          spawned.push({ command, args });
          if (command === 'tar') {
            return runCommand(command, args, options);
          }
          return { code: 0, stdout: '', stderr: '' };
        },
        execPath: '/usr/local/bin/node',
        log: (message) => logs.push(message),
      }
    );

    const extract = spawned.find((call) => call.command === 'tar');
    expect(extract).toBeDefined();
    expect(extract?.args[0]).toBe('-xzf');
    expect(extract?.args[1]).toContain(installDir);

    const apply = spawned.find((call) => call.command === '/usr/local/bin/node');
    expect(apply).toBeDefined();
    expect(apply?.args[0]).toMatch(/package\/bin\/tmex\.js$/);
    expect(apply?.args.slice(1, 3)).toEqual(['upgrade', '--apply-current-package']);
    expect(apply?.args).toContain('--lang');
    expect(apply?.args).toContain('en');
    expect(apply?.args).toContain('--bun-path');
    expect(apply?.args).toContain('/custom/bun');
    expect(apply?.args).toContain('--txn');
    expect(apply?.args).toContain('--install-dir');
    expect(apply?.args).toContain(installDir);
    expect(spawned.some((call) => call.command === 'npx')).toBe(false);
    expect(logs.join('\n')).toContain('unverified');
    expect(releaseSha256SumsUrl('1.1.0')).toContain('SHA256SUMS');
  });

  test('propagates the extracted CLI exit code', async () => {
    const installDir = await mkdtemp(join(tmpdir(), 'tmex-upg-exit-'));
    tempDirs.push(installDir);
    const previous = process.exitCode;
    process.exitCode = undefined;
    const tarball = packNpmTarball({
      'package/bin/tmex.js': 'export {}\n',
    });
    try {
      await expect(
        delegateUpgrade(
          {
            command: 'upgrade',
            positionals: [],
            flags: { 'install-dir': installDir, 'allow-unverified': true },
          },
          '1.1.0',
          {
            fetch: fakeFetch(tarball),
            runCommand: async (command, args, options) => {
              if (command === 'tar') return runCommand(command, args, options);
              return { code: 7, stdout: '', stderr: '' };
            },
            execPath: '/usr/bin/node',
            log: () => undefined,
          }
        )
      ).rejects.toThrow(/7/);
      expect(process.exitCode).toBe(7);
    } finally {
      process.exitCode = previous ?? 0;
    }
  });

  test('does not spawn npx on 404', async () => {
    const installDir = await mkdtemp(join(tmpdir(), 'tmex-upg-404-'));
    tempDirs.push(installDir);
    const spawned: string[] = [];
    await expect(
      delegateUpgrade(
        { command: 'upgrade', positionals: [], flags: { 'install-dir': installDir } },
        '9.9.9',
        {
          fetch: async () => new Response('Not Found', { status: 404 }),
          runCommand: async (command) => {
            spawned.push(command);
            return { code: 0, stdout: '', stderr: '' };
          },
        }
      )
    ).rejects.toThrow(/9\.9\.9/);
    expect(spawned).toEqual([]);
  });

  test('1.1.0 without --allow-unverified fails on SHA256SUMS 404', async () => {
    const installDir = await mkdtemp(join(tmpdir(), 'tmex-upg-noflag-'));
    tempDirs.push(installDir);
    const tarball = packNpmTarball({
      'package/bin/tmex.js': 'export {}\n',
    });
    const spawned: string[] = [];
    await expect(
      delegateUpgrade(
        { command: 'upgrade', positionals: [], flags: { 'install-dir': installDir } },
        '1.1.0',
        {
          fetch: fakeFetch(tarball),
          runCommand: async (command) => {
            spawned.push(command);
            return { code: 0, stdout: '', stderr: '' };
          },
        }
      )
    ).rejects.toThrow(/allow-unverified|SHA256SUMS/);
    expect(spawned).toEqual([]);
  });

  test('1.1.4 SHA256SUMS 404 fails even with --allow-unverified', async () => {
    const installDir = await mkdtemp(join(tmpdir(), 'tmex-upg-114-'));
    tempDirs.push(installDir);
    const tarball = packNpmTarball({
      'package/bin/tmex.js': 'export {}\n',
    });
    await expect(
      delegateUpgrade(
        {
          command: 'upgrade',
          positionals: [],
          flags: { 'install-dir': installDir, 'allow-unverified': true },
        },
        '1.1.4',
        {
          fetch: async (url) => {
            const href = String(url);
            if (href.includes('SHA256SUMS')) return new Response('missing', { status: 404 });
            if (href.includes('tmex-cli-')) return new Response(tarball, { status: 200 });
            return new Response('nope', { status: 404 });
          },
          runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
        }
      )
    ).rejects.toThrow(/1\.1\.4/);
  });
});

describe('upgrade flag unification', () => {
  test('passthrough argv from download is accepted by both flag tables', async () => {
    const { parseArgs, assertKnownFlags } = await import('../lib/args');
    const { assertKnownUpgradeFlags, passthroughUpgradeFlags } = await import('./upgrade');
    const parsed = parseArgs([
      'upgrade',
      '--apply-current-package',
      '--no-service',
      '--txn',
      'deadbeef',
      '--version',
      '1.1.4',
      '--install-dir',
      '/tmp/tmex',
      '--allow-missing-native',
      '--keep-backup',
    ]);
    expect(() => assertKnownFlags(parsed)).not.toThrow();
    expect(() => assertKnownUpgradeFlags(parsed)).not.toThrow();
    const argv = passthroughUpgradeFlags(parsed, { txn: 'deadbeef', version: '1.1.4' });
    expect(argv).toContain('--no-service');
    expect(argv).toContain('--txn');
    expect(argv).not.toContain('--allow-unverified');
    const applyParsed = parseArgs(['upgrade', '--apply-current-package', ...argv]);
    expect(() => assertKnownFlags(applyParsed)).not.toThrow();
    expect(() => assertKnownUpgradeFlags(applyParsed)).not.toThrow();
  });

  test('runUpgrade apply-current-package threads parsed --txn into repairUpgrade', async () => {
    const installDir = await mkdtemp(join(tmpdir(), 'tmex-upg-run-'));
    tempDirs.push(installDir);
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
          bunPath: process.execPath,
          serviceMode: 'none',
        },
        null,
        2
      )}\n`
    );
    const extract = join(installDir, 'staging', 'live-txn', 'extract', 'package');
    await mkdir(join(extract, 'bin'), { recursive: true });
    await mkdir(join(extract, 'dist', 'runtime'), { recursive: true });
    await mkdir(join(extract, 'resources', 'fe-dist'), { recursive: true });
    await mkdir(join(extract, 'resources', 'gateway-drizzle'), { recursive: true });
    await writeFile(join(extract, 'package.json'), '{"name":"tmex-cli","version":"2.0.0"}\n');
    await writeFile(join(extract, 'bin', 'tmex.js'), 'export {}\n');
    await writeFile(join(extract, 'dist', 'cli-node.js'), 'export {}\n');
    await writeFile(join(extract, 'dist', 'runtime', 'server.js'), 'export {}\n');
    await writeFile(join(extract, 'resources', 'fe-dist', 'index.html'), '<html></html>\n');
    await writeFile(join(extract, 'resources', 'gateway-drizzle', '0000.sql'), '--\n');
    const parsed = parseArgs([
      'upgrade',
      '--apply-current-package',
      '--install-dir',
      installDir,
      '--txn',
      'live-txn',
      '--version',
      '2.0.0',
      '--no-service',
      '--bun-path',
      process.execPath,
    ]);
    let repairTxn: string | null | undefined;
    let applyTxn: string | undefined;
    await runUpgrade(parsed, {
      repair: async (_installDir, _bunPath, opts) => {
        repairTxn = opts?.activeTxnId ?? null;
        return 'none';
      },
      apply: async (opts) => {
        applyTxn = opts.txnId;
      },
    });
    expect(repairTxn).toBe('live-txn');
    expect(applyTxn).toBe('live-txn');
  });

  test('download extract then extracted CLI repair+apply commits and later cleans staging', async () => {
    const installDir = await mkdtemp(join(tmpdir(), 'tmex-upg-e2e-'));
    tempDirs.push(installDir);
    await mkdir(join(installDir, 'versions', '1.0.0', 'runtime'), { recursive: true });
    await mkdir(join(installDir, 'data'), { recursive: true });
    await writeFile(join(installDir, 'versions', '1.0.0', 'runtime', 'server.js'), 'export {}\n');
    const { switchCurrent } = await import('../lib/upgrade-switch');
    await switchCurrent(installDir, '1.0.0');
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
          bunPath: process.execPath,
          serviceMode: 'none',
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

    const appRoot = join(import.meta.dir, '../..');
    const wrapper = `#!/usr/bin/env bun
import { parseArgs } from ${JSON.stringify(`${appRoot}/src/lib/args.ts`)};
import { assertKnownUpgradeFlags } from ${JSON.stringify(`${appRoot}/src/commands/upgrade.ts`)};
import { asString } from ${JSON.stringify(`${appRoot}/src/lib/validate.ts`)};
import { packageLayoutFromRoot } from ${JSON.stringify(`${appRoot}/src/lib/install-layout.ts`)};
import { applyUpgrade, repairUpgrade } from ${JSON.stringify(`${appRoot}/src/lib/upgrade-apply.ts`)};

const parsed = parseArgs(process.argv.slice(2));
assertKnownUpgradeFlags(parsed);
const installDir = asString(parsed.flags['install-dir']);
const txn = asString(parsed.flags.txn);
const toVersion = asString(parsed.flags.version) || '2.0.0';
if (!installDir || !txn) throw new Error('missing install-dir or txn');
const service = {
  running: true,
  async stop() { this.running = false; },
  async start() { this.running = true; },
  async isRunning() { return this.running; },
};
await repairUpgrade(installDir, process.execPath, { service, activeTxnId: txn, healthCheck: async () => undefined });
const layout = await packageLayoutFromRoot(import.meta.dir + '/..');
await applyUpgrade(
  { installDir, toVersion, packageLayout: layout, bunPath: process.execPath, noService: true, skipShims: true, txnId: txn },
  { service, runCandidate: async () => ({ stop: async () => undefined }), healthCheck: async () => undefined }
);
`;
    const tarball = packNpmTarball({
      'package/package.json':
        '{"name":"tmex-cli","version":"2.0.0","bin":{"tmex":"./bin/tmex.js"}}\n',
      'package/bin/tmex.js': wrapper,
      'package/dist/cli-node.js': 'export {}\n',
      'package/dist/runtime/server.js': 'export {}\n',
      'package/resources/fe-dist/index.html': '<html></html>\n',
      'package/resources/gateway-drizzle/0000.sql': '--\n',
    });
    const hex = sha256Hex(tarball);
    await delegateUpgrade(
      {
        command: 'upgrade',
        positionals: [],
        flags: { 'install-dir': installDir, 'no-service': true, version: '2.0.0' },
      },
      '2.0.0',
      {
        fetch: async (url) => {
          const href = String(url);
          if (href === releaseTarballUrl('2.0.0') || href.includes(releaseTarballName('2.0.0'))) {
            return new Response(tarball, { status: 200 });
          }
          if (href.includes('SHA256SUMS')) {
            return new Response(`${hex}  ${releaseTarballName('2.0.0')}\n`, { status: 200 });
          }
          return new Response('nope', { status: 404 });
        },
        runCommand: async (command, args, options) => {
          if (command === 'tar') return runCommand(command, args, options);
          return runCommand(process.execPath, args, options);
        },
        execPath: process.execPath,
        log: () => undefined,
      }
    );
    expect(await readCurrentVersion(installDir)).toBe('2.0.0');
    expect((await readJournal(installDir))?.phase).toBe('committed');
    const journal = await readJournal(installDir);
    expect(await pathExists(join(installDir, 'staging', journal?.txnId ?? 'missing'))).toBe(false);
  }, 30_000);
});
