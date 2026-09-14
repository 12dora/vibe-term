import { describe, expect, test } from 'bun:test';
import {
  type BecomeRelayValues,
  type JoinRelayValues,
  classifyRelayUrl,
  defaultNodeName,
  defaultRelayPublicUrl,
  hasErrors,
  normalizeTenantId,
  setupErrorKey,
  validateBecomeRelay,
  validateJoinRelay,
} from './validation';

function relayValues(overrides: Partial<BecomeRelayValues> = {}): BecomeRelayValues {
  return {
    relayPublicUrl: 'https://relay.example.com',
    relayPassword: 'generated-password',
    alsoNode: true,
    username: 'alice',
    password: 'hunter2hunter2',
    confirmPassword: 'hunter2hunter2',
    directEnable: true,
    ...overrides,
  };
}

function joinRelayValues(overrides: Partial<JoinRelayValues> = {}): JoinRelayValues {
  return {
    relayUrl: 'https://relay.example.com',
    tenantId: 'aabbccddeeff00112233445566778899',
    password: 'hunter2hunter2',
    name: 'studio',
    caFingerprint: '',
    directEnable: true,
    ...overrides,
  };
}

describe('classifyRelayUrl', () => {
  test('https 永远可用，非法串一律 invalid', () => {
    expect(classifyRelayUrl('https://relay.example.com', 'production')).toBe('ok');
    expect(classifyRelayUrl('  https://relay.example.com/base/  ', 'production')).toBe('ok');
    expect(classifyRelayUrl('', 'production')).toBe('invalid');
    expect(classifyRelayUrl('relay.example.com', 'production')).toBe('invalid');
    expect(classifyRelayUrl('ftp://relay.example.com', 'production')).toBe('invalid');
  });

  test('回环 http 只在非 production 下放行', () => {
    expect(classifyRelayUrl('http://127.0.0.1:9663', 'development')).toBe('insecure');
    expect(classifyRelayUrl('http://localhost:9663', 'test')).toBe('insecure');
    expect(classifyRelayUrl('http://127.0.0.1:9663', 'production')).toBe('invalid');
  });

  test('非回环 http 任何环境都不行', () => {
    expect(classifyRelayUrl('http://relay.example.com', 'development')).toBe('invalid');
  });
});

describe('validateBecomeRelay', () => {
  test('合法输入无错', () => {
    expect(validateBecomeRelay(relayValues(), 'production')).toEqual({});
  });

  test('地址非法时报 invalid_url', () => {
    expect(validateBecomeRelay(relayValues({ relayPublicUrl: 'nope' }), 'production')).toEqual({
      relayPublicUrl: 'nodes.setup.errors.invalid_url',
    });
  });

  test('接入口令留空不是错误：等于任何人都能接入', () => {
    expect(validateBecomeRelay(relayValues({ relayPassword: '' }), 'production')).toEqual({});
  });

  test('中继兼节点：账号三件校验', () => {
    expect(
      validateBecomeRelay(
        relayValues({ username: 'bad name', password: 'short', confirmPassword: 'other' }),
        'production'
      )
    ).toEqual({
      username: 'nodes.setup.errors.invalid_username',
      password: 'nodes.setup.errors.weak_password',
      confirmPassword: 'nodes.setup.errors.password_mismatch',
    });
  });

  test('纯中继不建账号：账号字段全空也不报错', () => {
    expect(
      validateBecomeRelay(
        relayValues({ alsoNode: false, username: '', password: '', confirmPassword: '' }),
        'production'
      )
    ).toEqual({});
  });
});

describe('defaultRelayPublicUrl', () => {
  test('只有当前地址本身合法时才预填', () => {
    expect(defaultRelayPublicUrl('https://relay.example.com', 'production')).toBe(
      'https://relay.example.com'
    );
    expect(defaultRelayPublicUrl('http://localhost:19663', 'production')).toBe('');
    expect(defaultRelayPublicUrl('http://localhost:19663', 'development')).toBe(
      'http://localhost:19663'
    );
    expect(defaultRelayPublicUrl(null, 'production')).toBe('');
  });
});

describe('defaultNodeName', () => {
  test('取主机名，缺失时退化成 node', () => {
    expect(defaultNodeName('studio.local')).toBe('studio.local');
    expect(defaultNodeName('')).toBe('node');
    expect(defaultNodeName(null)).toBe('node');
  });
});

describe('setupErrorKey', () => {
  test('契约里的错误码都有对应 key', () => {
    for (const code of [
      'not_standalone',
      'invalid_url',
      'invalid_username',
      'weak_password',
      'user_exists',
      'invalid_token',
      'node_revoked',
      'node_exists',
      'join_failed',
      'env_write_failed',
      'direct_unsupported',
      'direct_download_failed',
      'direct_failed',
      'invalid_role',
      'invalid_password',
      'invalid_body',
      'relay_unreachable',
    ]) {
      expect(setupErrorKey(code)).toBe(`nodes.setup.errors.${code}`);
    }
  });

  test('未知码返回 null 交给通用文案', () => {
    expect(setupErrorKey('kaboom')).toBeNull();
  });

  test('hub_unreachable 不再作为已知码', () => {
    expect(setupErrorKey('hub_unreachable')).toBeNull();
  });
});

describe('validateJoinRelay', () => {
  test('合法输入没有错误', () => {
    expect(hasErrors(validateJoinRelay(joinRelayValues(), 'production'))).toBe(false);
  });

  test('租户编号必须是 32 位十六进制（大小写与空白都容忍）', () => {
    expect(
      validateJoinRelay(
        joinRelayValues({ tenantId: ' AABBCCDDEEFF00112233445566778899 ' }),
        'production'
      ).tenantId
    ).toBeUndefined();
    expect(validateJoinRelay(joinRelayValues({ tenantId: 'abc' }), 'production').tenantId).toBe(
      'nodes.setup.errors.invalid_tenant_id'
    );
  });

  test('密码与名称必填，地址按中继规则判定', () => {
    const errors = validateJoinRelay(
      joinRelayValues({ password: '', name: '   ', relayUrl: 'ftp://relay' }),
      'production'
    );
    expect(errors.password).toBe('nodes.setup.errors.invalid_password');
    expect(errors.name).toBe('nodes.setup.errors.invalid_name');
    expect(errors.relayUrl).toBe('nodes.setup.errors.invalid_url');
  });

  test('CA 指纹留空合法，填了就必须是 64 位十六进制', () => {
    expect(
      validateJoinRelay(joinRelayValues({ caFingerprint: 'f'.repeat(64) }), 'production')
        .caFingerprint
    ).toBeUndefined();
    expect(
      validateJoinRelay(joinRelayValues({ caFingerprint: 'f'.repeat(63) }), 'production')
        .caFingerprint
    ).toBe('nodes.setup.errors.invalid_ca_fingerprint');
  });

  test('normalizeTenantId 去空白并转小写', () => {
    expect(normalizeTenantId(' AB CD ')).toBe('abcd');
  });
});
