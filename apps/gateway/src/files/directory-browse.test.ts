import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import type { BrowseDirectoryResponse, Device } from '@tmex/shared';
import { type DirectoryBrowseDeps, type SshExecResult, browseDirectory } from './directory-browse';
import type { RsyncDeviceSpec } from './ssh-command';

const posix = path.posix;

function localDevice(id = 'browse-local'): Device {
  return {
    id,
    name: 'local',
    type: 'local',
    authMode: 'auto',
    sortOrder: 0,
    createdAt: '',
    updatedAt: '',
  };
}

function sshDevice(id = 'browse-ssh'): Device {
  return {
    id,
    name: 'ssh',
    type: 'ssh',
    host: 'h',
    port: 22,
    username: 'u',
    authMode: 'key',
    sortOrder: 0,
    createdAt: '',
    updatedAt: '',
  };
}

const fakeSpec: RsyncDeviceSpec = {
  targetPrefix: 'u@h:',
  rsh: 'ssh -p 22',
  env: {},
  cleanup: () => {},
};

function depsFor(device: Device, extra: Partial<DirectoryBrowseDeps> = {}): DirectoryBrowseDeps {
  return {
    getDevice: (id) => (id === device.id ? device : null),
    enqueue: async (_deviceId, job) => job(),
    buildSpec: async () => fakeSpec,
    execSsh: async () => {
      throw new Error('execSsh should not be called');
    },
    ...extra,
  };
}

function expectOk(result: Awaited<ReturnType<typeof browseDirectory>>): BrowseDirectoryResponse {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('expected ok');
  return result.data;
}

let sandbox: string | null = null;

function makeSandbox(): string {
  sandbox = mkdtempSync(path.join(tmpdir(), 'tmex-browse-'));
  return sandbox;
}

afterEach(() => {
  if (sandbox) {
    rmSync(sandbox, { recursive: true, force: true });
    sandbox = null;
  }
});

describe('browseDirectory — local', () => {
  test('lists directories, excludes files, flags symlink-to-dir, filters hidden', async () => {
    const root = makeSandbox();
    mkdirSync(path.join(root, 'Visible'));
    mkdirSync(path.join(root, 'alpha'));
    mkdirSync(path.join(root, '.secret'));
    writeFileSync(path.join(root, 'file.txt'), 'x');
    mkdirSync(path.join(root, 'real-dir'));
    symlinkSync(path.join(root, 'real-dir'), path.join(root, 'link-dir'));
    symlinkSync(path.join(root, 'file.txt'), path.join(root, 'link-file'));

    const shown = expectOk(
      await browseDirectory(localDevice().id, root, false, depsFor(localDevice()))
    );
    expect(shown.path).toBe(posix.resolve(root));
    expect(shown.parent).toBe(posix.dirname(posix.resolve(root)));
    expect(shown.truncated).toBe(false);
    expect(shown.entries.map((e) => e.name)).toEqual(['alpha', 'link-dir', 'real-dir', 'Visible']);
    const link = shown.entries.find((e) => e.name === 'link-dir');
    expect(link).toEqual({
      name: 'link-dir',
      path: posix.join(posix.resolve(root), 'link-dir'),
      hidden: false,
      symlink: true,
    });
    expect(shown.entries.find((e) => e.name === 'real-dir')?.symlink).toBe(false);
    expect(shown.entries.some((e) => e.name === '.secret' || e.name === 'file.txt')).toBe(false);

    const withHidden = expectOk(
      await browseDirectory(localDevice().id, root, true, depsFor(localDevice()))
    );
    expect(withHidden.entries.map((e) => e.name)).toEqual([
      '.secret',
      'alpha',
      'link-dir',
      'real-dir',
      'Visible',
    ]);
    expect(withHidden.entries.find((e) => e.name === '.secret')).toEqual({
      name: '.secret',
      path: posix.join(posix.resolve(root), '.secret'),
      hidden: true,
      symlink: false,
    });
  });

  test('skips entries that cannot be stat-ed (broken symlink)', async () => {
    const root = makeSandbox();
    mkdirSync(path.join(root, 'ok'));
    symlinkSync(path.join(root, 'missing-target'), path.join(root, 'broken'));

    const shown = expectOk(
      await browseDirectory(localDevice().id, root, false, depsFor(localDevice()))
    );
    expect(shown.entries.map((e) => e.name)).toEqual(['ok']);
  });

  test('caps at 2000 entries and sets truncated', async () => {
    const root = makeSandbox();
    for (let i = 0; i < 2001; i++) {
      mkdirSync(path.join(root, `d${String(i).padStart(4, '0')}`));
    }
    const shown = expectOk(
      await browseDirectory(localDevice().id, root, false, depsFor(localDevice()))
    );
    expect(shown.entries).toHaveLength(2000);
    expect(shown.truncated).toBe(true);
  });

  test('returns not_a_directory for a file path', async () => {
    const root = makeSandbox();
    const file = path.join(root, 'a.txt');
    writeFileSync(file, 'x');
    const result = await browseDirectory(localDevice().id, file, false, depsFor(localDevice()));
    expect(result).toEqual({ ok: false, code: 'not_a_directory' });
  });

  test('returns not_found for a missing path', async () => {
    const root = makeSandbox();
    const result = await browseDirectory(
      localDevice().id,
      path.join(root, 'nope'),
      false,
      depsFor(localDevice())
    );
    expect(result).toEqual({ ok: false, code: 'not_found' });
  });

  test('returns permission_denied when the directory cannot be listed', async () => {
    const root = makeSandbox();
    const locked = path.join(root, 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0);
    try {
      const result = await browseDirectory(localDevice().id, locked, false, depsFor(localDevice()));
      expect(result).toEqual({ ok: false, code: 'permission_denied' });
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  test('empty path starts at os.homedir()', async () => {
    const shown = expectOk(
      await browseDirectory(localDevice().id, '', false, depsFor(localDevice()))
    );
    expect(shown.path).toBe(posix.resolve(homedir()));
  });

  test('rejects relative path and tilde', async () => {
    const deps = depsFor(localDevice());
    expect(await browseDirectory(localDevice().id, 'rel', false, deps)).toEqual({
      ok: false,
      code: 'invalid',
    });
    expect(await browseDirectory(localDevice().id, '~/code', false, deps)).toEqual({
      ok: false,
      code: 'invalid',
    });
  });

  test('parent is null at filesystem root', async () => {
    const shown = expectOk(
      await browseDirectory(localDevice().id, '/', false, depsFor(localDevice()))
    );
    expect(shown.path).toBe('/');
    expect(shown.parent).toBeNull();
  });

  test('unknown device → device_not_found', async () => {
    const result = await browseDirectory('missing', '/tmp', false, depsFor(localDevice()));
    expect(result).toEqual({ ok: false, code: 'device_not_found' });
  });
});

function encodeSshListing(
  resolvedPath: string,
  entries: Array<{ type: 'd' | 'l'; name: string }>
): Uint8Array {
  const chunks: string[] = [`P${resolvedPath}`];
  for (const entry of entries) {
    chunks.push(entry.type, entry.name);
  }
  return new TextEncoder().encode(`${chunks.join('\0')}\0`);
}

describe('browseDirectory — SSH', () => {
  test('parses find output, flags symlink dirs, filters hidden, sorts case-insensitively', async () => {
    let seenCommand = '';
    const execSsh = async (_spec: RsyncDeviceSpec, command: string): Promise<SshExecResult> => {
      seenCommand = command;
      return {
        stdout: encodeSshListing('/home/u/My Docs', [
          { type: 'd', name: 'Zebra' },
          { type: 'l', name: 'link-dir' },
          { type: 'd', name: '.cache' },
          { type: 'd', name: 'alpha' },
        ]),
        stderr: '',
        exitCode: 0,
      };
    };

    const shown = expectOk(
      await browseDirectory(
        sshDevice().id,
        '/home/u/My Docs',
        false,
        depsFor(sshDevice(), { execSsh })
      )
    );
    expect(seenCommand).toContain('for f in .* *');
    expect(seenCommand).toContain("printf 'P%s");
    expect(seenCommand).toContain('[ -L "$f" ]');
    expect(seenCommand).toContain("'/home/u/My Docs'");
    expect(shown.path).toBe('/home/u/My Docs');
    expect(shown.parent).toBe('/home/u');
    expect(shown.entries.map((e) => e.name)).toEqual(['alpha', 'link-dir', 'Zebra']);
    expect(shown.entries.find((e) => e.name === 'link-dir')?.symlink).toBe(true);
    expect(shown.entries.find((e) => e.name === 'alpha')?.symlink).toBe(false);
    expect(shown.entries.some((e) => e.name === '.cache')).toBe(false);

    const withHidden = expectOk(
      await browseDirectory(
        sshDevice().id,
        '/home/u/My Docs',
        true,
        depsFor(sshDevice(), { execSsh })
      )
    );
    expect(withHidden.entries.map((e) => e.name)).toEqual(['.cache', 'alpha', 'link-dir', 'Zebra']);
  });

  test('quotes unicode and spaces in a single remote command', async () => {
    let seenCommand = '';
    const execSsh = async (_spec: RsyncDeviceSpec, command: string): Promise<SshExecResult> => {
      seenCommand = command;
      return {
        stdout: encodeSshListing('/tmp/文档 夹', [{ type: 'd', name: '子目录' }]),
        stderr: '',
        exitCode: 0,
      };
    };
    const shown = expectOk(
      await browseDirectory(
        sshDevice().id,
        '/tmp/文档 夹',
        false,
        depsFor(sshDevice(), { execSsh })
      )
    );
    expect(seenCommand).toContain("'/tmp/文档 夹'");
    expect(shown.entries).toEqual([
      {
        name: '子目录',
        path: '/tmp/文档 夹/子目录',
        hidden: false,
        symlink: false,
      },
    ]);
  });

  test('empty path uses $HOME via the remote script and falls back to /', async () => {
    let seenCommand = '';
    const execSsh = async (_spec: RsyncDeviceSpec, command: string): Promise<SshExecResult> => {
      seenCommand = command;
      return {
        stdout: encodeSshListing('/home/u', [{ type: 'd', name: 'proj' }]),
        stderr: '',
        exitCode: 0,
      };
    };
    const shown = expectOk(
      await browseDirectory(sshDevice().id, '', false, depsFor(sshDevice(), { execSsh }))
    );
    expect(seenCommand).toContain('${HOME:-/}');
    expect(shown.path).toBe('/home/u');
    expect(shown.parent).toBe('/home');
    expect(shown.entries.map((e) => e.name)).toEqual(['proj']);
  });

  test('parent is null when remote path is /', async () => {
    const execSsh = async (): Promise<SshExecResult> => ({
      stdout: encodeSshListing('/', [{ type: 'd', name: 'etc' }]),
      stderr: '',
      exitCode: 0,
    });
    const shown = expectOk(
      await browseDirectory(sshDevice().id, '/', false, depsFor(sshDevice(), { execSsh }))
    );
    expect(shown.parent).toBeNull();
  });

  test('maps remote errors and timeout', async () => {
    const device = sshDevice();
    const run = (execSsh: DirectoryBrowseDeps['execSsh']) =>
      browseDirectory(device.id, '/x', false, depsFor(device, { execSsh }));

    async function expectCode(
      execSsh: DirectoryBrowseDeps['execSsh'],
      code: 'not_found' | 'not_a_directory' | 'permission_denied' | 'connection_failed' | 'timeout'
    ) {
      const result = await run(execSsh);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.code).toBe(code);
    }

    await expectCode(
      async () => ({ stdout: new Uint8Array(), stderr: 'not_found', exitCode: 2 }),
      'not_found'
    );
    await expectCode(
      async () => ({ stdout: new Uint8Array(), stderr: 'not_a_directory', exitCode: 20 }),
      'not_a_directory'
    );
    await expectCode(
      async () => ({
        stdout: new Uint8Array(),
        stderr: 'find: ‘/x’: Permission denied',
        exitCode: 1,
      }),
      'permission_denied'
    );
    await expectCode(
      async () => ({
        stdout: new Uint8Array(),
        stderr: 'ssh: connect to host h port 22: Connection refused',
        exitCode: 255,
      }),
      'connection_failed'
    );
    await expectCode(
      async () => ({
        stdout: new Uint8Array(),
        stderr: '[tmex] ssh timed out',
        exitCode: 124,
      }),
      'timeout'
    );
  });
});
