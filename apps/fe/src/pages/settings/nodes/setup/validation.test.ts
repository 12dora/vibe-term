import { describe, expect, test } from 'bun:test';
import {
  type BecomeHubValues,
  type BecomeRelayValues,
  type JoinHubValues,
  classifyHubUrl,
  classifyRelayUrl,
  defaultHubPublicUrl,
  defaultNodeName,
  defaultRelayPublicUrl,
  hasErrors,
  isValidJoinToken,
  normalizeToken,
  setupErrorKey,
  validateBecomeHub,
  validateBecomeRelay,
  validateJoinHub,
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

function becomeValues(overrides: Partial<BecomeHubValues> = {}): BecomeHubValues {
  return {
    hubPublicUrl: 'https://tmex.example.com',
    username: 'alice',
    password: 'hunter2hunter2',
    confirmPassword: 'hunter2hunter2',
    directEnable: true,
    ...overrides,
  };
}

function joinValues(overrides: Partial<JoinHubValues> = {}): JoinHubValues {
  return {
    hubUrl: 'https://tmex.example.com',
    token: 'a'.repeat(128),
    name: 'studio',
    directEnable: true,
    insecureLocal: false,
    ...overrides,
  };
}

describe('classifyHubUrl', () => {
  test('https 永远可用', () => {
    expect(classifyHubUrl('https://tmex.example.com', 'production')).toBe('ok');
  });

  test('http 本地地址在非 production 下是 insecure，production 下直接非法', () => {
    expect(classifyHubUrl('http://127.0.0.1:19883', 'development')).toBe('insecure');
    expect(classifyHubUrl('http://localhost:19883', 'test')).toBe('insecure');
    expect(classifyHubUrl('http://127.0.0.1:19883', 'production')).toBe('invalid');
  });

  test('http 非本地地址一律非法', () => {
    expect(classifyHubUrl('http://tmex.example.com', 'development')).toBe('invalid');
  });

  test('非 http(s) 协议与不可解析的串非法', () => {
    expect(classifyHubUrl('ws://tmex.example.com', 'development')).toBe('invalid');
    expect(classifyHubUrl('tmex.example.com', 'development')).toBe('invalid');
    expect(classifyHubUrl('   ', 'development')).toBe('invalid');
  });
});

describe('validateBecomeHub', () => {
  test('合法输入无错误', () => {
    expect(validateBecomeHub(becomeValues(), 'production')).toEqual({});
    expect(hasErrors(validateBecomeHub(becomeValues(), 'production'))).toBe(false);
  });

  test('production 下 http 地址报 invalid_url', () => {
    const errors = validateBecomeHub(
      becomeValues({ hubPublicUrl: 'http://127.0.0.1:9883' }),
      'production'
    );
    expect(errors.hubPublicUrl).toBe('nodes.setup.errors.invalid_url');
  });

  test('用户名字符集与长度：非法字符、超长、空都报 invalid_username', () => {
    for (const username of ['', 'a b', 'アリス', 'a'.repeat(65)]) {
      expect(validateBecomeHub(becomeValues({ username }), 'production').username).toBe(
        'nodes.setup.errors.invalid_username'
      );
    }
    expect(validateBecomeHub(becomeValues({ username: 'a.b_c-1' }), 'production').username).toBe(
      undefined
    );
  });

  test('密码短于 8 位报 weak_password', () => {
    const errors = validateBecomeHub(
      becomeValues({ password: '1234567', confirmPassword: '1234567' }),
      'production'
    );
    expect(errors.password).toBe('nodes.setup.errors.weak_password');
  });

  test('两次密码不一致报 password_mismatch', () => {
    const errors = validateBecomeHub(
      becomeValues({ confirmPassword: 'hunter2hunter3' }),
      'production'
    );
    expect(errors.confirmPassword).toBe('nodes.setup.errors.password_mismatch');
  });
});

describe('validateJoinHub', () => {
  test('合法输入无错误', () => {
    expect(validateJoinHub(joinValues(), 'production')).toEqual({});
  });

  test('非 production 的 http 本地 hub 必须勾上 insecureLocal', () => {
    const url = 'http://127.0.0.1:19883';
    expect(validateJoinHub(joinValues({ hubUrl: url }), 'development').hubUrl).toBe(
      'nodes.setup.errors.insecure_local_required'
    );
    expect(
      validateJoinHub(joinValues({ hubUrl: url, insecureLocal: true }), 'development').hubUrl
    ).toBe(undefined);
    // production 下即使勾了也没用：地址本身就非法。
    expect(
      validateJoinHub(joinValues({ hubUrl: url, insecureLocal: true }), 'production').hubUrl
    ).toBe('nodes.setup.errors.invalid_url');
  });

  test('token 允许粘贴时带换行，长度或字符不对报 invalid_token', () => {
    const v1 = `${'a'.repeat(64)}\n  ${'B-_9'.repeat(16)}`;
    expect(validateJoinHub(joinValues({ token: v1 }), 'production').token).toBe(undefined);
    expect(validateJoinHub(joinValues({ token: '' }), 'production').token).toBe(
      'nodes.setup.errors.invalid_token'
    );
    expect(validateJoinHub(joinValues({ token: 'abc$def' }), 'production').token).toBe(
      'nodes.setup.errors.invalid_token'
    );
    expect(validateJoinHub(joinValues({ token: 'a'.repeat(127) }), 'production').token).toBe(
      'nodes.setup.errors.invalid_token'
    );
  });

  test('带 CA 指纹的 v2 join 串被接受', () => {
    const v2 = `${'a'.repeat(128)}.${'0123456789abcdef'.repeat(4)}`;
    expect(validateJoinHub(joinValues({ token: v2 }), 'production').token).toBe(undefined);
    expect(validateJoinHub(joinValues({ token: `  ${v2}\n` }), 'production').token).toBe(undefined);
  });

  test('节点名不能为空且不超过 64 字符，允许中文', () => {
    expect(validateJoinHub(joinValues({ name: '书房' }), 'production').name).toBe(undefined);
    expect(validateJoinHub(joinValues({ name: '  ' }), 'production').name).toBe(
      'nodes.setup.errors.invalid_name'
    );
    expect(validateJoinHub(joinValues({ name: 'n'.repeat(65) }), 'production').name).toBe(
      'nodes.setup.errors.invalid_name'
    );
  });
});

describe('normalizeToken', () => {
  test('去掉所有空白', () => {
    expect(normalizeToken(' ab\n cd\t')).toBe('abcd');
  });
});

describe('defaultHubPublicUrl', () => {
  test('https origin 预填；production 下 http origin 留空；非 production 下本地 http 预填', () => {
    expect(defaultHubPublicUrl('https://tmex.example.com', 'production')).toBe(
      'https://tmex.example.com'
    );
    expect(defaultHubPublicUrl('http://localhost:19663', 'production')).toBe('');
    expect(defaultHubPublicUrl('http://localhost:19663', 'development')).toBe(
      'http://localhost:19663'
    );
    expect(defaultHubPublicUrl(null, 'development')).toBe('');
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
      'hub_unreachable',
      'join_failed',
      'env_write_failed',
      'direct_unsupported',
      'direct_download_failed',
      'direct_failed',
    ]) {
      expect(setupErrorKey(code)).toBe(`nodes.setup.errors.${code}`);
    }
  });

  test('未知码返回 null 交给通用文案', () => {
    expect(setupErrorKey('kaboom')).toBeNull();
  });
});

describe('isValidJoinToken', () => {
  const base64url = 'a'.repeat(128);
  const fingerprint = '0123456789abcdef'.repeat(4);

  test('v1：正好 128 位 base64url', () => {
    expect(isValidJoinToken(base64url)).toBe(true);
    expect(isValidJoinToken(`${'A-_9'.repeat(32)}`)).toBe(true);
    expect(isValidJoinToken('a'.repeat(127))).toBe(false);
    expect(isValidJoinToken('a'.repeat(129))).toBe(false);
    expect(isValidJoinToken('')).toBe(false);
  });

  test('v2：128 位 base64url + 点号 + 64 位小写十六进制 CA 指纹', () => {
    expect(isValidJoinToken(`${base64url}.${fingerprint}`)).toBe(true);
    // 大写十六进制、长度不对、多一个点号、只有指纹段都不算合法。
    expect(isValidJoinToken(`${base64url}.${fingerprint.toUpperCase()}`)).toBe(false);
    expect(isValidJoinToken(`${base64url}.${fingerprint.slice(0, 63)}`)).toBe(false);
    expect(isValidJoinToken(`${base64url}.${fingerprint}.${fingerprint}`)).toBe(false);
    expect(isValidJoinToken(`.${fingerprint}`)).toBe(false);
    expect(isValidJoinToken(`${base64url}.`)).toBe(false);
    expect(isValidJoinToken(`${base64url}.${'g'.repeat(64)}`)).toBe(false);
  });
});

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

  test('中继兼节点：账号三件与 become-hub 同规则', () => {
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

describe('setupErrorKey 认识中继角色错误码', () => {
  test('invalid_role', () => {
    expect(setupErrorKey('invalid_role')).toBe('nodes.setup.errors.invalid_role');
  });
});
