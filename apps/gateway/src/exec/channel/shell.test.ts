import { afterEach, describe, expect, test } from 'bun:test';
import { ExecChannelError } from './errors';
import { resolveSftpServer, resolveUserShell, shellProbe } from './shell';

const original = { ...shellProbe };

afterEach(() => {
  Object.assign(shellProbe, original);
});

describe('resolveUserShell', () => {
  test('prefers the account shell when executable', () => {
    shellProbe.accountShell = () => '/bin/acct';
    shellProbe.fallbackShell = () => '/bin/fallback';
    shellProbe.isExecutable = (p) => p === '/bin/acct' || p === '/bin/fallback';
    expect(resolveUserShell()).toBe('/bin/acct');
  });

  test('falls back to the default shell resolver', () => {
    shellProbe.accountShell = () => '/nologin/missing';
    shellProbe.fallbackShell = () => '/bin/fallback';
    shellProbe.isExecutable = (p) => p === '/bin/fallback';
    expect(resolveUserShell()).toBe('/bin/fallback');
  });

  test('ends at /bin/sh when nothing is executable', () => {
    shellProbe.accountShell = () => null;
    shellProbe.fallbackShell = () => null;
    shellProbe.isExecutable = () => false;
    expect(resolveUserShell()).toBe('/bin/sh');
  });

  test('real host resolves to an executable shell', () => {
    Object.assign(shellProbe, original);
    expect(original.isExecutable(resolveUserShell())).toBe(true);
  });
});

describe('resolveSftpServer', () => {
  test('returns the first existing candidate in contract order', () => {
    shellProbe.isExecutable = (p) =>
      p === '/usr/libexec/sftp-server' || p === '/usr/lib/openssh/sftp-server';
    expect(resolveSftpServer()).toBe('/usr/lib/openssh/sftp-server');
  });

  test('throws exec_spawn_failed when none exists', () => {
    shellProbe.isExecutable = () => false;
    try {
      resolveSftpServer();
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ExecChannelError);
      expect((err as ExecChannelError).code).toBe('exec_spawn_failed');
    }
  });
});
