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
        uid: 1000,
        gid: 1000,
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
