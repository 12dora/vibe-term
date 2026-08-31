import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseTarballUrl } from '../../../shared/src/release/source';
import { packNpmTarball } from '../lib/native-tarball';
import { runCommand } from '../lib/process';
import { releaseSha256SumsUrl } from '../lib/release-fetch';
import { delegateUpgrade, reenableDirectAfterUpgrade } from './upgrade';

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
        flags: { lang: 'en', 'bun-path': '/custom/bun', 'install-dir': installDir },
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
          { command: 'upgrade', positionals: [], flags: { 'install-dir': installDir } },
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
});
