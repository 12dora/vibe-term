import { describe, expect, test } from 'bun:test';
import { tlsErrorKey } from './tls-errors';
import {
  type AcmeDraft,
  acmeSavePayload,
  daysUntil,
  defaultSans,
  formatTimestamp,
  isIpv4Address,
  isIpv6Address,
  isValidSan,
  parseSansInput,
  validateAcmeDraft,
  validateBindHost,
  validateDomain,
  validateEmail,
  validatePort,
  validateSans,
} from './tls-form';

describe('isValidSan', () => {
  test('接受主机名与 IP', () => {
    expect(isValidSan('hub.lan')).toBe(true);
    expect(isValidSan('tmex')).toBe(true);
    expect(isValidSan('192.168.1.10')).toBe(true);
    expect(isValidSan('fd00::1')).toBe(true);
    expect(isValidSan('[fd00::1]')).toBe(true);
  });

  test('拒绝空串、非法字符与越界 IPv4', () => {
    expect(isValidSan('')).toBe(false);
    expect(isValidSan('   ')).toBe(false);
    expect(isValidSan('hub_lan')).toBe(false);
    expect(isValidSan('https://hub.lan')).toBe(false);
    expect(isValidSan('999.1.1.1')).toBe(false);
    expect(isValidSan('-hub.lan')).toBe(false);
  });
});

describe('isIpv6Address', () => {
  test('接受压缩、完整、内嵌 IPv4 三种写法', () => {
    expect(isIpv6Address('::1')).toBe(true);
    expect(isIpv6Address('::')).toBe(true);
    expect(isIpv6Address('fe80::1')).toBe(true);
    expect(isIpv6Address('2001:db8::8a2e:370:7334')).toBe(true);
    expect(isIpv6Address('2001:0db8:85a3:0000:0000:8a2e:0370:7334')).toBe(true);
    expect(isIpv6Address('::ffff:192.168.0.1')).toBe(true);
    expect(isIpv6Address('1:2:3:4:5:6:7::')).toBe(true);
  });

  test('拒绝分组数、压缩次数、分组长度不合法的写法', () => {
    expect(isIpv6Address('::::')).toBe(false);
    expect(isIpv6Address('1:2:3:4:5:6:7:8:9')).toBe(false);
    expect(isIpv6Address('12345::1')).toBe(false);
    expect(isIpv6Address('1::2::3')).toBe(false);
    expect(isIpv6Address('1:2:3:4:5:6:7')).toBe(false);
    expect(isIpv6Address('1:2:3:4:5:6:7:8:')).toBe(false);
    expect(isIpv6Address(':1:2:3:4:5:6:7:8')).toBe(false);
    expect(isIpv6Address('::ffff:192.168.0.1.2')).toBe(false);
    expect(isIpv6Address('::ffff:999.1.1.1')).toBe(false);
    expect(isIpv6Address('::gggg')).toBe(false);
    expect(isIpv6Address('192.168.1.10')).toBe(false);
  });

  test('IPv4 单独校验仍然逐段限界', () => {
    expect(isIpv4Address('192.168.1.10')).toBe(true);
    expect(isIpv4Address('999.1.1.1')).toBe(false);
    expect(isIpv4Address('01.1.1.1')).toBe(false);
  });
});

describe('isValidSan 与严格 IPv6', () => {
  test('后端会以 invalid_sans 拒掉的畸形 IPv6 前端就先挡住', () => {
    expect(isValidSan('::::')).toBe(false);
    expect(isValidSan('1:2:3:4:5:6:7:8:9')).toBe(false);
    expect(isValidSan('[12345::1]')).toBe(false);
    expect(isValidSan('[::ffff:192.168.0.1]')).toBe(true);
  });
});

describe('parseSansInput', () => {
  test('逗号 / 分号 / 空白 / 换行都算分隔符并去重', () => {
    expect(parseSansInput('a.lan, b.lan;c.lan\n a.lan  d.lan')).toEqual([
      'a.lan',
      'b.lan',
      'c.lan',
      'd.lan',
    ]);
  });

  test('空输入得到空数组', () => {
    expect(parseSansInput('   \n ')).toEqual([]);
  });
});

describe('validateSans', () => {
  test('空列表要求至少一个', () => {
    expect(validateSans([])).toBe('nodes.https.validation.sansRequired');
  });

  test('超过 20 个报 sansTooMany', () => {
    const many = Array.from({ length: 21 }, (_, i) => `h${i}.lan`);
    expect(validateSans(many)).toBe('nodes.https.validation.sansTooMany');
  });

  test('含非法条目报 sansInvalid，合法则通过', () => {
    expect(validateSans(['hub.lan', 'not valid'])).toBe('nodes.https.validation.sansInvalid');
    expect(validateSans(['hub.lan', '10.0.0.2'])).toBeNull();
  });
});

describe('validatePort / validateBindHost', () => {
  test('端口必须是 1..65535 的整数', () => {
    expect(validatePort('9443')).toBeNull();
    expect(validatePort(' 443 ')).toBeNull();
    expect(validatePort('0')).toBe('nodes.https.validation.portInvalid');
    expect(validatePort('65536')).toBe('nodes.https.validation.portInvalid');
    expect(validatePort('9443.5')).toBe('nodes.https.validation.portInvalid');
    expect(validatePort('')).toBe('nodes.https.validation.portInvalid');
  });

  test('绑定地址不得为空', () => {
    expect(validateBindHost('0.0.0.0')).toBeNull();
    expect(validateBindHost('  ')).toBe('nodes.https.validation.hostRequired');
  });
});

describe('validateDomain / validateEmail', () => {
  test('域名必须有点、不得带通配符', () => {
    expect(validateDomain('hub.example.com')).toBeNull();
    expect(validateDomain('*.example.com')).toBe('nodes.https.validation.domainInvalid');
    expect(validateDomain('localhost')).toBe('nodes.https.validation.domainInvalid');
    expect(validateDomain('')).toBe('nodes.https.validation.domainInvalid');
  });

  test('邮箱粗校验', () => {
    expect(validateEmail('ops@example.com')).toBeNull();
    expect(validateEmail('ops@example')).toBe('nodes.https.validation.emailInvalid');
    expect(validateEmail('ops example.com')).toBe('nodes.https.validation.emailInvalid');
  });
});

describe('defaultSans', () => {
  test('回环与缺省不预填', () => {
    expect(defaultSans(null)).toEqual([]);
    expect(defaultSans('localhost')).toEqual([]);
    expect(defaultSans('127.0.0.1')).toEqual([]);
    expect(defaultSans('::1')).toEqual([]);
  });

  test('普通主机名预填', () => {
    expect(defaultSans('hub.lan')).toEqual(['hub.lan']);
    expect(defaultSans('192.168.1.10')).toEqual(['192.168.1.10']);
  });
});

describe('daysUntil / formatTimestamp', () => {
  const now = Date.UTC(2026, 0, 1);

  test('剩余天数向下取整，过期为负', () => {
    expect(daysUntil(now + 86_400_000 * 30 + 1000, now)).toBe(30);
    expect(daysUntil(now - 86_400_000, now)).toBe(-1);
  });

  test('空时间戳显示破折号', () => {
    expect(formatTimestamp(null)).toBe('—');
    expect(formatTimestamp(0)).toBe('—');
    expect(formatTimestamp(now)).not.toBe('—');
  });
});

describe('tlsErrorKey', () => {
  test('契约列举的码有本地化 key', () => {
    expect(tlsErrorKey('port_in_use')).toBe('nodes.https.errors.port_in_use');
    expect(tlsErrorKey('not_applicable')).toBe('nodes.https.errors.not_applicable');
  });

  test('未列举的码返回 null', () => {
    expect(tlsErrorKey('teapot')).toBeNull();
  });
});

describe('ACME 表单草稿', () => {
  const draft = (overrides: Partial<AcmeDraft> = {}): AcmeDraft => ({
    domain: 'hub.example.com',
    email: 'ops@example.com',
    challenge: 'dns-01',
    dnsProvider: 'cloudflare',
    cloudflareToken: '',
    dnspodId: '',
    dnspodToken: '',
    staging: false,
    tlsPort: '9443',
    bindHost: '0.0.0.0',
    ...overrides,
  });

  test('http-01 不校验也不下发任何 DNS 字段', () => {
    const http = draft({ challenge: 'http-01' });
    expect(validateAcmeDraft(http, false)).toEqual({});
    expect(acmeSavePayload(http)).toEqual({
      domain: 'hub.example.com',
      email: 'ops@example.com',
      challenge: 'http-01',
      staging: false,
      tlsPort: 9443,
      bindHost: '0.0.0.0',
    });
  });

  test('Cloudflare：缺令牌且没存过时报错，填了就随 dnsCredentials 下发', () => {
    expect(validateAcmeDraft(draft(), false).token).toBe(
      'nodes.https.validation.cloudflareTokenRequired'
    );
    expect(validateAcmeDraft(draft(), true)).toEqual({});
    const filled = draft({ cloudflareToken: '  cf-token  ' });
    expect(validateAcmeDraft(filled, false)).toEqual({});
    expect(acmeSavePayload(filled)).toMatchObject({
      dnsProvider: 'cloudflare',
      dnsCredentials: { token: 'cf-token' },
    });
  });

  test('DNSPod：两截都要，缺哪截报哪截', () => {
    const errors = validateAcmeDraft(draft({ dnsProvider: 'dnspod' }), false);
    expect(errors.tokenId).toBe('nodes.https.validation.dnspodIdRequired');
    expect(errors.token).toBe('nodes.https.validation.dnspodTokenRequired');
    expect(validateAcmeDraft(draft({ dnsProvider: 'dnspod', dnspodId: '1234' }), false)).toEqual({
      token: 'nodes.https.validation.dnspodTokenRequired',
    });
    const filled = draft({ dnsProvider: 'dnspod', dnspodId: ' 1234 ', dnspodToken: ' secret ' });
    expect(validateAcmeDraft(filled, false)).toEqual({});
    expect(acmeSavePayload(filled)).toMatchObject({
      dnsProvider: 'dnspod',
      dnsCredentials: { id: '1234', token: 'secret' },
    });
  });

  test('已存凭证时整体留空表示沿用：只带服务商，不带凭证', () => {
    const empty = draft({ dnsProvider: 'dnspod' });
    expect(validateAcmeDraft(empty, true)).toEqual({});
    const payload = acmeSavePayload(empty);
    expect(payload.dnsProvider).toBe('dnspod');
    expect(payload.dnsCredentials).toBeUndefined();
  });

  test('域名 / 邮箱 / 端口的错误照旧一次性给全', () => {
    const bad = draft({ domain: '*.example.com', email: 'nope', tlsPort: '0', bindHost: ' ' });
    expect(validateAcmeDraft(bad, true)).toEqual({
      domain: 'nodes.https.validation.domainInvalid',
      email: 'nodes.https.validation.emailInvalid',
      port: 'nodes.https.validation.portInvalid',
      host: 'nodes.https.validation.hostRequired',
    });
  });
});
