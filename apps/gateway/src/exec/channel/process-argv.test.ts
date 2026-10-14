import { afterEach, describe, expect, test } from 'bun:test';
import { buildLocalArgv } from './process-local';
import { buildSshArgv, buildSshRemote } from './process-ssh';
import { openSpec } from './process-test-util';
import { shellProbe } from './shell';

const original = { ...shellProbe };
afterEach(() => Object.assign(shellProbe, original));

describe('buildLocalArgv', () => {
  test('shell uses the user shell, sh uses /bin/sh', () => {
    expect(buildLocalArgv({ kind: 'shell', script: 'echo $0' }, '/bin/zsh')).toEqual([
      '/bin/zsh',
      '-c',
      'echo $0',
    ]);
    expect(buildLocalArgv({ kind: 'shell', script: 'echo $0', sh: true }, '/bin/zsh')).toEqual([
      '/bin/sh',
      '-c',
      'echo $0',
    ]);
  });

  test('argv is passed through verbatim', () => {
    expect(buildLocalArgv({ kind: 'argv', argv: ['git', 'status', '-s'] }, '/bin/zsh')).toEqual([
      'git',
      'status',
      '-s',
    ]);
  });

  test('login starts the login shell', () => {
    expect(buildLocalArgv({ kind: 'login' }, '/bin/zsh')).toEqual(['/bin/zsh', '-l']);
  });

  test('subsystem resolves sftp-server', () => {
    shellProbe.isExecutable = (p) => p === '/usr/libexec/sftp-server';
    expect(buildLocalArgv({ kind: 'subsystem', name: 'sftp' }, '/bin/zsh')).toEqual([
      '/usr/libexec/sftp-server',
    ]);
  });
});

const target = { dest: 'dev@host.example', sshArgs: ['ssh', '-p', '22'] };

describe('buildSshArgv', () => {
  test('argv without pty uses -T and quoted exec', () => {
    const argv = buildSshArgv(
      target,
      openSpec({ command: { kind: 'argv', argv: ['git', 'log'] } })
    );
    expect(argv).toEqual(['ssh', '-p', '22', '-T', 'dev@host.example', '--', "exec 'git' 'log'"]);
  });

  test('pty switches to -tt', () => {
    const argv = buildSshArgv(
      target,
      openSpec({ command: { kind: 'argv', argv: ['top'] }, pty: { cols: 80, rows: 24 } })
    );
    expect(argv.slice(3, 5)).toEqual(['-tt', 'dev@host.example']);
  });

  test('shell sends the raw script for the remote user shell', () => {
    const argv = buildSshArgv(
      target,
      openSpec({ command: { kind: 'shell', script: 'ls | wc -l' } })
    );
    expect(argv.at(-1)).toBe('ls | wc -l');
  });

  test('sh wraps in /bin/sh -c', () => {
    const remote = buildSshRemote(
      openSpec({ command: { kind: 'shell', script: "echo 'a b'", sh: true } })
    );
    expect(remote).toBe(`exec /bin/sh -c 'echo '\\''a b'\\'''`);
  });

  test('cwd and env are applied for every command kind', () => {
    const base = { cwd: '/srv/my app', env: { A: "x'y" } };
    expect(buildSshRemote(openSpec({ ...base, command: { kind: 'argv', argv: ['id'] } }))).toBe(
      `cd '/srv/my app' && env A='x'\\''y' 'id'`
    );
    expect(buildSshRemote(openSpec({ ...base, command: { kind: 'shell', script: 'pwd' } }))).toBe(
      `export A='x'\\''y'; cd '/srv/my app' && pwd`
    );
    expect(buildSshRemote(openSpec({ ...base, command: { kind: 'login' } }))).toBe(
      `export A='x'\\''y'; cd '/srv/my app' && exec "$SHELL" -l`
    );
  });

  test('login without context has no remote command', () => {
    const plain = buildSshArgv(target, openSpec({ command: { kind: 'login' }, stdin: true }));
    expect(plain).toEqual(['ssh', '-p', '22', '-T', 'dev@host.example']);
    const tty = buildSshArgv(
      target,
      openSpec({ command: { kind: 'login' }, pty: { cols: 80, rows: 24 } })
    );
    expect(tty).toEqual(['ssh', '-p', '22', '-tt', 'dev@host.example']);
  });

  test('subsystem uses -s and ignores pty', () => {
    const argv = buildSshArgv(
      target,
      openSpec({ command: { kind: 'subsystem', name: 'sftp' }, pty: { cols: 80, rows: 24 } })
    );
    expect(argv).toEqual(['ssh', '-p', '22', '-T', '-s', 'dev@host.example', 'sftp']);
  });
});
