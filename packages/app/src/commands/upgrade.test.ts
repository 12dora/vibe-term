import { describe, expect, test } from 'bun:test';
import { releaseTarballUrl } from '../../../shared/src/release/source';
import { packNpmTarball } from '../lib/native-tarball';
import { runCommand } from '../lib/process';
import { delegateUpgrade, reenableDirectAfterUpgrade } from './upgrade';

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
    const tarball = packNpmTarball({
      'package/package.json': '{"name":"tmex-cli","version":"1.1.0"}\n',
      'package/bin/tmex.js': 'export {}\n',
    });
    const spawned: Array<{ command: string; args: string[] }> = [];

    await delegateUpgrade({ command: 'upgrade', positionals: [], flags: { lang: 'en' } }, '1.1.0', {
      fetch: async (url) => {
        expect(String(url)).toBe(releaseTarballUrl('1.1.0'));
        return new Response(tarball, { status: 200 });
      },
      runCommand: async (command, args, options) => {
        spawned.push({ command, args });
        if (command === 'tar') {
          return runCommand(command, args, options);
        }
        return { code: 0, stdout: '', stderr: '' };
      },
      execPath: '/usr/local/bin/node',
    });

    const extract = spawned.find((call) => call.command === 'tar');
    expect(extract).toBeDefined();
    expect(extract?.args[0]).toBe('-xzf');

    const apply = spawned.find((call) => call.command === '/usr/local/bin/node');
    expect(apply).toBeDefined();
    expect(apply?.args[0]).toMatch(/package\/bin\/tmex\.js$/);
    expect(apply?.args.slice(1, 3)).toEqual(['upgrade', '--apply-current-package']);
    expect(apply?.args).toContain('--lang');
    expect(apply?.args).toContain('en');
    expect(spawned.some((call) => call.command === 'npx')).toBe(false);
  });

  test('propagates the extracted CLI exit code', async () => {
    const tarball = packNpmTarball({
      'package/bin/tmex.js': 'export {}\n',
    });
    await expect(
      delegateUpgrade({ command: 'upgrade', positionals: [], flags: {} }, '1.1.0', {
        fetch: async () => new Response(tarball, { status: 200 }),
        runCommand: async (command, args, options) => {
          if (command === 'tar') return runCommand(command, args, options);
          return { code: 7, stdout: '', stderr: '' };
        },
        execPath: '/usr/bin/node',
      })
    ).rejects.toThrow(/7/);
  });

  test('does not spawn npx on 404', async () => {
    const spawned: string[] = [];
    await expect(
      delegateUpgrade({ command: 'upgrade', positionals: [], flags: {} }, '9.9.9', {
        fetch: async () => new Response('Not Found', { status: 404 }),
        runCommand: async (command) => {
          spawned.push(command);
          return { code: 0, stdout: '', stderr: '' };
        },
      })
    ).rejects.toThrow(/9\.9\.9/);
    expect(spawned).toEqual([]);
  });
});
