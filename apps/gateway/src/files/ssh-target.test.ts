import { describe, expect, test } from 'bun:test';
import { sshRemoteArgv, validateSshIdentityFields } from './ssh-target';

describe('validateSshIdentityFields', () => {
  test('合法 host / username / sshConfigRef 放行', () => {
    expect(
      validateSshIdentityFields({
        host: 'example.test',
        username: 'ubuntu',
        sshConfigRef: 'work',
      })
    ).toEqual({ ok: true });
    expect(validateSshIdentityFields({ host: '[2001:db8::1]' })).toEqual({ ok: true });
    expect(validateSshIdentityFields({ host: '', username: null })).toEqual({ ok: true });
  });

  test('拒绝前导短横线、空白与控制字符', () => {
    expect(validateSshIdentityFields({ host: '-oProxyCommand=true' }).ok).toBe(false);
    expect(validateSshIdentityFields({ username: '-oBatchMode=no' }).ok).toBe(false);
    expect(validateSshIdentityFields({ sshConfigRef: '-F/tmp/evil' }).ok).toBe(false);
    expect(validateSshIdentityFields({ host: 'host name' }).ok).toBe(false);
    expect(validateSshIdentityFields({ host: 'host\ninject' }).ok).toBe(false);
  });

  test('接受下划线主机、ssh_config 别名与 IPv6 字面量', () => {
    expect(validateSshIdentityFields({ host: 'build_box' })).toEqual({ ok: true });
    expect(validateSshIdentityFields({ host: 'my-alias' })).toEqual({ ok: true });
    expect(validateSshIdentityFields({ sshConfigRef: 'build_box' })).toEqual({ ok: true });
    expect(validateSshIdentityFields({ host: '[2001:db8::1]' })).toEqual({ ok: true });
  });
});

describe('sshRemoteArgv', () => {
  test('在 dest 前插入 --，避免 dest 被当成 ssh 选项', () => {
    expect(sshRemoteArgv('ssh -p 22', 'user@host', 'sh -s')).toEqual([
      'ssh',
      '-p',
      '22',
      '--',
      'user@host',
      'sh -s',
    ]);
    expect(sshRemoteArgv('ssh', '-oProxyCommand=true', 'id')).toEqual([
      'ssh',
      '--',
      '-oProxyCommand=true',
      'id',
    ]);
  });
});
