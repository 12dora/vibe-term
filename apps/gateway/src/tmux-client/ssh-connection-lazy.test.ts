import { describe, expect, test } from 'bun:test';
import { loadedSshConnection, preloadSshConnection } from './ssh-connection-lazy';
import { SshExternalTmuxConnection } from './ssh-external-connection';

describe('ssh-connection-lazy', () => {
  test('preload 后返回 SSH 连接类，重复 preload 不换实例', async () => {
    await preloadSshConnection();
    await preloadSshConnection();
    expect(loadedSshConnection()).toBe(SshExternalTmuxConnection);
  });
});
