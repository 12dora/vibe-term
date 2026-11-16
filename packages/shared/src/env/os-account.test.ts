import { describe, expect, test } from 'bun:test';
import { currentOsAccount, passwdEntryForUid } from './os-account';

const PASSWD = [
  'root:x:0:0:root:/root:/bin/ash',
  'alice:x:1000:1000:Linux User,,,:/home/alice:/bin/ash',
  '',
].join('\n');

describe('passwdEntryForUid', () => {
  test('finds the entry by uid', () => {
    expect(passwdEntryForUid(PASSWD, 1000)).toEqual({
      username: 'alice',
      homedir: '/home/alice',
      shell: '/bin/ash',
    });
  });

  test('returns null for unknown uid or missing file', () => {
    expect(passwdEntryForUid(PASSWD, 4242)).toBeNull();
    expect(passwdEntryForUid(null, 1000)).toBeNull();
  });
});

describe('currentOsAccount', () => {
  test('keeps userInfo values when they are real', () => {
    const account = currentOsAccount({
      userInfo: () => ({
        username: 'bob',
        homedir: '/h/bob',
        shell: '/bin/zsh',
        uid: 2000,
        gid: 2000,
      }),
      readPasswd: () => PASSWD,
    });
    expect(account.username).toBe('bob');
    expect(account.shell).toBe('/bin/zsh');
  });

  test('falls back to /etc/passwd when Bun reports "unknown"', () => {
    const account = currentOsAccount({
      userInfo: () => ({
        username: 'unknown',
        homedir: '/home/alice',
        shell: 'unknown',
        uid: 1000,
        gid: 1000,
      }),
      readPasswd: () => PASSWD,
      env: {},
    });
    expect(account).toEqual({
      username: 'alice',
      homedir: '/home/alice',
      shell: '/bin/ash',
      uid: 1000,
      gid: 1000,
    });
  });

  test('falls back to $LOGNAME when passwd has no entry', () => {
    const account = currentOsAccount({
      userInfo: () => ({ username: 'unknown', homedir: '/x', shell: null, uid: 77, gid: 77 }),
      readPasswd: () => PASSWD,
      env: { LOGNAME: 'carol' },
    });
    expect(account.username).toBe('carol');
    expect(account.shell).toBeNull();
  });
});

describe('currentOsAccount after su without -', () => {
  test('a stale $USER that does not own the uid is replaced by the passwd owner', () => {
    const account = currentOsAccount({
      userInfo: () => ({ username: 'alice', homedir: '/root', shell: '/bin/ash', uid: 0, gid: 0 }),
      readPasswd: () => PASSWD,
    });
    expect(account.username).toBe('root');
    expect(account.homedir).toBe('/root');
  });

  test('keeps an alias that shares the uid', () => {
    const passwd = `${PASSWD}toor:x:0:0:alias:/root:/bin/sh\n`;
    const account = currentOsAccount({
      userInfo: () => ({ username: 'toor', homedir: '/root', shell: '/bin/sh', uid: 0, gid: 0 }),
      readPasswd: () => passwd,
    });
    expect(account.username).toBe('toor');
  });

  test('ignores comments, NIS lines and CRLF', () => {
    const passwd = '#root:x:0:0::/x:/bin/false\n+::::::\r\nroot:x:0:0:root:/root:/bin/ash\r\n';
    const account = currentOsAccount({
      userInfo: () => ({ username: 'unknown', homedir: '', shell: 'unknown', uid: 0, gid: 0 }),
      readPasswd: () => passwd,
      env: {},
    });
    expect(account).toMatchObject({ username: 'root', homedir: '/root', shell: '/bin/ash' });
  });

  test('falls back when userInfo throws (Node without a passwd entry)', () => {
    const account = currentOsAccount({
      userInfo: () => {
        throw new Error('ENOENT');
      },
      readPasswd: () => null,
      env: { USER: 'carol', HOME: '/home/carol' },
    });
    expect(account.username).toBe('carol');
    expect(account.homedir).toBe('/home/carol');
  });
});
