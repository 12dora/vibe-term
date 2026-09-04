import { describe, expect, test } from 'bun:test';
import {
  collectConfiguredHosts,
  decideDomainAccess,
  isIpLiteral,
  isJsonDeniedPath,
  isLocalClientSource,
  isLocalName,
  isServicePath,
  isViaDomain,
  normalizeHost,
} from './domain-access-policy';
import { MESH_VIA_SELF, setMeshRequestContext } from './mesh-deps';
import { publicRequestUrl } from './session-middleware';

describe('normalizeHost', () => {
  test.each([
    ['Example.COM.', 'example.com'],
    ['example.com:443', 'example.com'],
    ['example.com:80', 'example.com'],
    ['example.com:9443', 'example.com:9443'],
    ['EXAMPLE.COM:8443', 'example.com:8443'],
    ['[::1]', '::1'],
    ['[::1]:443', '::1'],
    ['[2001:db8::1]:8443', '[2001:db8::1]:8443'],
    ['[2001:DB8::1]', '2001:db8::1'],
    ['127.0.0.1:80', '127.0.0.1'],
    ['127.0.0.1:9883', '127.0.0.1:9883'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeHost(input)).toBe(expected);
  });
});

describe('isIpLiteral / isLocalName', () => {
  test('IPv4 and IPv6 literals', () => {
    expect(isIpLiteral('192.168.1.5')).toBe(true);
    expect(isIpLiteral('127.0.0.1')).toBe(true);
    expect(isIpLiteral('[::1]')).toBe(true);
    expect(isIpLiteral('::1')).toBe(true);
    expect(isIpLiteral('2001:db8::1')).toBe(true);
    expect(isIpLiteral('::ffff:127.0.0.1')).toBe(true);
    expect(isIpLiteral('tmex.example.com')).toBe(false);
    expect(isIpLiteral('localhost')).toBe(false);
  });

  test('localhost, *.localhost, *.local, loopback', () => {
    expect(isLocalName('localhost')).toBe(true);
    expect(isLocalName('Foo.Localhost')).toBe(true);
    expect(isLocalName('tmex.local')).toBe(true);
    expect(isLocalName('printer.local:8443')).toBe(true);
    expect(isLocalName('127.0.0.1')).toBe(true);
    expect(isLocalName('127.1.2.3:9883')).toBe(true);
    expect(isLocalName('::1')).toBe(true);
    expect(isLocalName('[::1]:443')).toBe(true);
    expect(isLocalName('::ffff:127.0.0.1')).toBe(true);
    expect(isLocalName('192.168.1.5')).toBe(false);
    expect(isLocalName('tmex.example.com')).toBe(false);
    expect(isLocalName('notlocal.com')).toBe(false);
  });
});

describe('collectConfiguredHosts', () => {
  test('extracts unique sorted hostnames and drops IP / local names', () => {
    expect(
      collectConfiguredHosts([
        'https://B.example.com',
        'https://a.example.com:9443',
        'https://a.example.com:9443/',
        'http://127.0.0.1:8085',
        'http://localhost:19663',
        'tmex.local',
        'https://B.example.com.',
        'named.example.com',
        null,
        '  ',
      ])
    ).toEqual(['a.example.com:9443', 'b.example.com', 'named.example.com']);
  });

  test('strips default ports from URL sources', () => {
    expect(
      collectConfiguredHosts(['https://tmex.example.com:443', 'http://tmex.example.com:80'])
    ).toEqual(['tmex.example.com']);
  });
});

describe('isViaDomain', () => {
  const hosts = ['tmex.example.com', 'alt.example.com:8443'];

  test('domain without port matches any port on that hostname', () => {
    expect(isViaDomain(new URL('https://tmex.example.com/'), hosts)).toBe(true);
    expect(isViaDomain(new URL('https://tmex.example.com:443/'), hosts)).toBe(true);
    expect(isViaDomain(new URL('https://tmex.example.com:9443/x'), hosts)).toBe(true);
  });

  test('configured host with explicit port is exact', () => {
    expect(isViaDomain(new URL('https://alt.example.com:8443/'), hosts)).toBe(true);
    expect(isViaDomain(new URL('https://alt.example.com/'), hosts)).toBe(false);
    expect(isViaDomain(new URL('https://alt.example.com:443/'), hosts)).toBe(false);
  });

  test('IP literals, localhost and .local are never via-domain', () => {
    expect(isViaDomain(new URL('http://192.168.1.5/'), ['192.168.1.5'])).toBe(false);
    expect(isViaDomain(new URL('http://[::1]/'), ['::1'])).toBe(false);
    expect(isViaDomain(new URL('http://localhost/'), ['localhost'])).toBe(false);
    expect(isViaDomain(new URL('http://tmex.local/'), ['tmex.local'])).toBe(false);
  });
});

describe('x-forwarded-host via publicRequestUrl', () => {
  test('untrusted x-forwarded-host is ignored', () => {
    const req = new Request('http://192.168.1.5/', {
      headers: { 'x-forwarded-host': 'evil.example' },
    });
    setMeshRequestContext(req, { via: MESH_VIA_SELF, trustProxy: false });
    expect(isViaDomain(publicRequestUrl(req), ['evil.example'])).toBe(false);
  });

  test('trusted x-forwarded-host is used (first value only)', () => {
    const req = new Request('http://192.168.1.5/', {
      headers: { 'x-forwarded-host': 'tmex.example.com, other.example' },
    });
    setMeshRequestContext(req, { via: MESH_VIA_SELF, trustProxy: true });
    expect(isViaDomain(publicRequestUrl(req), ['tmex.example.com'])).toBe(true);
  });

  test('trusted x-forwarded-host is ignored when via is not self', () => {
    const req = new Request('http://192.168.1.5/', {
      headers: { 'x-forwarded-host': 'tmex.example.com' },
    });
    setMeshRequestContext(req, { via: 'ab'.repeat(16), trustProxy: true });
    expect(isViaDomain(publicRequestUrl(req), ['tmex.example.com'])).toBe(false);
  });
});

describe('isServicePath / isJsonDeniedPath', () => {
  test('service allowlist', () => {
    expect(isServicePath('GET', '/hub/uplink')).toBe(true);
    expect(isServicePath('POST', '/hub/uplink')).toBe(true);
    expect(isServicePath('GET', '/healthz')).toBe(true);
    expect(isServicePath('GET', '/.well-known/acme-challenge/tok')).toBe(true);
    expect(isServicePath('POST', '/api/hub/enrollments/redeem')).toBe(true);
    expect(isServicePath('GET', '/api/hub/status')).toBe(true);
    expect(isServicePath('GET', '/api/hub/enrollments/abc')).toBe(true);
    expect(isServicePath('GET', '/api/hub/enrollments/redeem')).toBe(true);
    expect(isServicePath('POST', '/api/hub/status')).toBe(false);
    expect(isServicePath('GET', '/api/hub/enrollments/abc/extra')).toBe(false);
    expect(isServicePath('GET', '/')).toBe(false);
    expect(isServicePath('GET', '/api/devices')).toBe(false);
  });

  test('中继的机器路径同样放行，管理面不放行', () => {
    const tenant = 'ab'.repeat(16);
    expect(isServicePath('GET', '/relay/uplink')).toBe(true);
    expect(isServicePath('GET', '/api/relay/health')).toBe(true);
    expect(isServicePath('POST', '/api/relay/enroll')).toBe(true);
    expect(isServicePath('POST', `/api/relay/tenants/${tenant}/enrollments`)).toBe(true);
    expect(isServicePath('POST', `/api/relay/tenants/${tenant}/enrollments/redeem`)).toBe(true);
    expect(isServicePath('GET', `/api/relay/tenants/${tenant}/enrollments/abc`)).toBe(true);
    expect(isServicePath('GET', '/api/relay/status')).toBe(false);
    expect(isServicePath('POST', '/api/relay/password')).toBe(false);
    expect(isServicePath('PATCH', `/api/relay/tenants/${tenant}`)).toBe(false);
  });

  test('json denied paths', () => {
    expect(isJsonDeniedPath('/api/x')).toBe(true);
    expect(isJsonDeniedPath('/api/local/status')).toBe(true);
    expect(isJsonDeniedPath('/ws')).toBe(true);
    expect(isJsonDeniedPath('/mesh/ws')).toBe(true);
    expect(isJsonDeniedPath('/n/abc/api/x')).toBe(true);
    expect(isJsonDeniedPath('/n/abc/ws')).toBe(true);
    expect(isJsonDeniedPath('/')).toBe(false);
    expect(isJsonDeniedPath('/n/abc/foo')).toBe(false);
  });
});

describe('isLocalClientSource', () => {
  test('loopback, RFC1918, link-local, ULA, CGNAT and mapped forms', () => {
    expect(isLocalClientSource('127.0.0.1')).toBe(true);
    expect(isLocalClientSource('::1')).toBe(true);
    expect(isLocalClientSource('10.0.0.8')).toBe(true);
    expect(isLocalClientSource('192.168.1.5')).toBe(true);
    expect(isLocalClientSource('172.16.0.1')).toBe(true);
    expect(isLocalClientSource('169.254.1.1')).toBe(true);
    expect(isLocalClientSource('fe80::1')).toBe(true);
    expect(isLocalClientSource('fd12:3456:789a::1')).toBe(true);
    expect(isLocalClientSource('100.64.1.2')).toBe(true);
    expect(isLocalClientSource('::ffff:127.0.0.1')).toBe(true);
    expect(isLocalClientSource('::ffff:100.64.1.2')).toBe(true);
    expect(isLocalClientSource('::ffff:c0a8:0101')).toBe(true);
    expect(isLocalClientSource('::ffff:7f00:1')).toBe(true);
    expect(isLocalClientSource('[::1]')).toBe(true);
    expect(isLocalClientSource('fe80::1%en0')).toBe(true);
  });

  test('public, missing and unparsable addresses are not local', () => {
    expect(isLocalClientSource(undefined)).toBe(false);
    expect(isLocalClientSource(null)).toBe(false);
    expect(isLocalClientSource('')).toBe(false);
    expect(isLocalClientSource('203.0.113.10')).toBe(false);
    expect(isLocalClientSource('8.8.8.8')).toBe(false);
    expect(isLocalClientSource('2001:db8::1')).toBe(false);
    expect(isLocalClientSource('127.0.0.1:8080')).toBe(false);
    expect(isLocalClientSource('not-an-ip')).toBe(false);
    expect(isLocalClientSource('::ffff:127.999.1.1')).toBe(false);
  });
});

describe('decideDomainAccess', () => {
  const publicIp = '203.0.113.10';
  const base = { viaSelf: true, allowed: false as const };

  test('fast-path allow when policy is enabled or not via self', () => {
    expect(
      decideDomainAccess({
        viaSelf: true,
        allowed: true,
        clientIp: publicIp,
        method: 'GET',
        pathname: '/',
      })
    ).toBe('allow');
    expect(
      decideDomainAccess({
        viaSelf: false,
        allowed: false,
        clientIp: publicIp,
        method: 'GET',
        pathname: '/api/x',
      })
    ).toBe('allow');
  });

  test('deny-text vs deny-json vs service path for a public client', () => {
    expect(decideDomainAccess({ ...base, clientIp: publicIp, method: 'GET', pathname: '/' })).toBe(
      'deny-text'
    );
    expect(
      decideDomainAccess({ ...base, clientIp: publicIp, method: 'GET', pathname: '/api/x' })
    ).toBe('deny-json');
    expect(
      decideDomainAccess({ ...base, clientIp: publicIp, method: 'GET', pathname: '/ws' })
    ).toBe('deny-json');
    expect(
      decideDomainAccess({
        ...base,
        clientIp: publicIp,
        method: 'GET',
        pathname: '/n/abc/api/x',
      })
    ).toBe('deny-json');
    expect(
      decideDomainAccess({ ...base, clientIp: publicIp, method: 'GET', pathname: '/healthz' })
    ).toBe('allow');
    expect(
      decideDomainAccess({ ...base, clientIp: publicIp, method: 'POST', pathname: '/hub/uplink' })
    ).toBe('allow');
  });

  test('Host is ignored: public client with localhost or IP-literal Host is denied', () => {
    expect(decideDomainAccess({ ...base, clientIp: publicIp, method: 'GET', pathname: '/' })).toBe(
      'deny-text'
    );
    expect(
      decideDomainAccess({
        ...base,
        clientIp: publicIp,
        method: 'GET',
        pathname: '/',
        headers: new Headers({ host: 'localhost' }),
      })
    ).toBe('deny-text');
    expect(
      decideDomainAccess({
        ...base,
        clientIp: publicIp,
        method: 'GET',
        pathname: '/',
        headers: new Headers({ host: '203.0.113.10' }),
      })
    ).toBe('deny-text');
  });

  test('LAN, loopback and CGNAT clients are allowed regardless of Host', () => {
    expect(
      decideDomainAccess({ ...base, clientIp: '192.168.1.5', method: 'GET', pathname: '/api/x' })
    ).toBe('allow');
    expect(
      decideDomainAccess({ ...base, clientIp: '127.0.0.1', method: 'GET', pathname: '/' })
    ).toBe('allow');
    expect(
      decideDomainAccess({ ...base, clientIp: '100.64.1.2', method: 'GET', pathname: '/ws' })
    ).toBe('allow');
  });

  test('unknown source fails closed', () => {
    expect(decideDomainAccess({ ...base, method: 'GET', pathname: '/' })).toBe('deny-text');
    expect(decideDomainAccess({ ...base, clientIp: null, method: 'GET', pathname: '/api/x' })).toBe(
      'deny-json'
    );
  });

  test('TMEX_TRUST_PROXY=false uses socket IP and ignores spoofed XFF', () => {
    const spoofed = new Headers({ 'x-forwarded-for': '203.0.113.9' });
    expect(
      decideDomainAccess({
        ...base,
        clientIp: '10.0.0.8',
        trustProxy: false,
        headers: spoofed,
        method: 'GET',
        pathname: '/',
      })
    ).toBe('allow');
    expect(
      decideDomainAccess({
        ...base,
        clientIp: '203.0.113.9',
        trustProxy: false,
        headers: new Headers({ 'x-forwarded-for': '10.0.0.8' }),
        method: 'GET',
        pathname: '/',
      })
    ).toBe('deny-text');
  });

  test('TMEX_TRUST_PROXY=true judges XFF last segment', () => {
    expect(
      decideDomainAccess({
        ...base,
        clientIp: '10.0.0.8',
        trustProxy: true,
        headers: new Headers({ 'x-forwarded-for': '1.2.3.4, 203.0.113.9' }),
        method: 'GET',
        pathname: '/',
      })
    ).toBe('deny-text');
    expect(
      decideDomainAccess({
        ...base,
        clientIp: '203.0.113.9',
        trustProxy: true,
        headers: new Headers({ 'x-forwarded-for': '1.2.3.4, 10.0.0.8' }),
        method: 'GET',
        pathname: '/',
      })
    ).toBe('allow');
  });
});
