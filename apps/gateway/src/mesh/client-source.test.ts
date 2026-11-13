import { describe, expect, test } from 'bun:test';
import { CLIENT_SOURCE_HEADER } from '@vibeterm/shared/http/mesh-headers';
import { isPeerRequest, isTrustedLocalClient, waivesPasskeySecondFactor } from './client-source';
import { MESH_VIA_SELF, setMeshRequestContext } from './mesh-deps';

const ENTRY = 'ab'.repeat(16);

function makeReq(opts: {
  ip?: string;
  via?: string;
  trustProxy?: boolean;
  clientIpHeader?: 'x-forwarded-for' | 'x-real-ip' | 'cf-connecting-ip';
  headers?: Record<string, string>;
}): Request {
  const req = new Request('http://localhost/api/auth/login', { headers: opts.headers });
  setMeshRequestContext(req, {
    via: opts.via ?? MESH_VIA_SELF,
    clientIp: opts.ip,
    trustProxy: opts.trustProxy,
    clientIpHeader: opts.clientIpHeader,
  });
  return req;
}

describe('isTrustedLocalClient', () => {
  test('loopback v4/v6/mapped', () => {
    expect(isTrustedLocalClient(makeReq({ ip: '127.0.0.1' }))).toBe(true);
    expect(isTrustedLocalClient(makeReq({ ip: '127.0.0.2' }))).toBe(true);
    expect(isTrustedLocalClient(makeReq({ ip: '::1' }))).toBe(true);
    expect(isTrustedLocalClient(makeReq({ ip: '::ffff:127.0.0.1' }))).toBe(true);
  });

  test('RFC1918, CGNAT, link-local, ULA', () => {
    expect(isTrustedLocalClient(makeReq({ ip: '10.0.0.8' }))).toBe(true);
    expect(isTrustedLocalClient(makeReq({ ip: '172.16.0.1' }))).toBe(true);
    expect(isTrustedLocalClient(makeReq({ ip: '192.168.1.5' }))).toBe(true);
    expect(isTrustedLocalClient(makeReq({ ip: '100.64.1.2' }))).toBe(true);
    expect(isTrustedLocalClient(makeReq({ ip: '169.254.1.1' }))).toBe(true);
    expect(isTrustedLocalClient(makeReq({ ip: 'fe80::1' }))).toBe(true);
    expect(isTrustedLocalClient(makeReq({ ip: 'fd12:3456:789a::1' }))).toBe(true);
    expect(isTrustedLocalClient(makeReq({ ip: '::ffff:100.64.1.2' }))).toBe(true);
  });

  test('public IPv4/IPv6 are not trusted', () => {
    expect(isTrustedLocalClient(makeReq({ ip: '203.0.113.10' }))).toBe(false);
    expect(isTrustedLocalClient(makeReq({ ip: '8.8.8.8' }))).toBe(false);
    expect(isTrustedLocalClient(makeReq({ ip: '2001:db8::1' }))).toBe(false);
    expect(isTrustedLocalClient(makeReq({ ip: '::ffff:8.8.8.8' }))).toBe(false);
  });

  test('cf-connecting-ip is never trusted', () => {
    expect(
      isTrustedLocalClient(
        makeReq({
          ip: '127.0.0.1',
          headers: { 'cf-connecting-ip': '203.0.113.5' },
        })
      )
    ).toBe(false);
    expect(
      isTrustedLocalClient(
        makeReq({
          ip: '127.0.0.1',
          trustProxy: true,
          headers: { 'cf-connecting-ip': '10.0.0.8' },
        })
      )
    ).toBe(false);
  });

  test('XFF without trustProxy is fail-closed', () => {
    expect(
      isTrustedLocalClient(
        makeReq({
          ip: '127.0.0.1',
          trustProxy: false,
          headers: { 'x-forwarded-for': '10.0.0.8' },
        })
      )
    ).toBe(false);
    expect(
      isTrustedLocalClient(
        makeReq({
          ip: '127.0.0.1',
          trustProxy: false,
          headers: { 'x-real-ip': '192.168.1.5' },
        })
      )
    ).toBe(false);
  });

  test('XFF public with trustProxy is not trusted', () => {
    expect(
      isTrustedLocalClient(
        makeReq({
          ip: '127.0.0.1',
          trustProxy: true,
          headers: { 'x-forwarded-for': '203.0.113.10' },
        })
      )
    ).toBe(false);
  });

  test('public socket cannot spoof local via x-real-ip even with trustProxy', () => {
    expect(
      isTrustedLocalClient(
        makeReq({
          ip: '203.0.113.10',
          trustProxy: true,
          headers: { 'x-real-ip': '10.0.0.8' },
        })
      )
    ).toBe(false);
  });

  test('public socket cannot spoof local via XFF ending in private', () => {
    expect(
      isTrustedLocalClient(
        makeReq({
          ip: '203.0.113.10',
          trustProxy: true,
          headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.8' },
        })
      )
    ).toBe(false);
  });

  test('forwarded headers never make a request local, even when they claim loopback / LAN', () => {
    for (const clientIpHeader of ['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip'] as const) {
      for (const claim of ['127.0.0.1', '192.168.1.5', '::1']) {
        const req = makeReq({
          ip: '127.0.0.1',
          trustProxy: true,
          clientIpHeader,
          headers: { [clientIpHeader]: claim },
        });
        expect(isTrustedLocalClient(req)).toBe(false);
        expect(waivesPasskeySecondFactor(req)).toBe(false);
      }
    }
    expect(
      isTrustedLocalClient(makeReq({ ip: '127.0.0.1', headers: { forwarded: 'for=127.0.0.1' } }))
    ).toBe(false);
  });

  test('X-Real-IP: 127.0.0.1 behind a proxy that rewrote XFF is not local', () => {
    const req = makeReq({
      ip: '127.0.0.1',
      trustProxy: true,
      headers: { 'x-real-ip': '127.0.0.1', 'x-forwarded-for': '198.51.100.7' },
    });
    expect(isTrustedLocalClient(req)).toBe(false);
    expect(waivesPasskeySecondFactor(req)).toBe(false);
  });

  test('loopback socket + XFF public with trustProxy is not trusted', () => {
    expect(
      isTrustedLocalClient(
        makeReq({
          ip: '127.0.0.1',
          trustProxy: true,
          headers: { 'x-forwarded-for': '203.0.113.10' },
        })
      )
    ).toBe(false);
  });

  test('blank XFF header with trustProxy off is fail-closed', () => {
    expect(
      isTrustedLocalClient(
        makeReq({
          ip: '127.0.0.1',
          trustProxy: false,
          headers: { 'x-forwarded-for': '' },
        })
      )
    ).toBe(false);
    expect(
      isTrustedLocalClient(
        makeReq({
          ip: '127.0.0.1',
          trustProxy: false,
          headers: { 'x-forwarded-for': '   ' },
        })
      )
    ).toBe(false);
  });

  test('missing clientIp is not trusted', () => {
    expect(isTrustedLocalClient(makeReq({}))).toBe(false);
    expect(isTrustedLocalClient(makeReq({ ip: '' }))).toBe(false);
  });

  test('peer context is never a trusted local client', () => {
    expect(isTrustedLocalClient(makeReq({ via: ENTRY, ip: 'peer:entry' }))).toBe(false);
    expect(isTrustedLocalClient(makeReq({ via: MESH_VIA_SELF, ip: 'peer:entry' }))).toBe(false);
  });
});

describe('waivesPasskeySecondFactor', () => {
  test('peer request asserting client-source local is not waived', () => {
    for (const name of [CLIENT_SOURCE_HEADER.name, CLIENT_SOURCE_HEADER.legacy]) {
      const req = makeReq({ via: ENTRY, ip: `peer:${ENTRY}`, headers: { [name]: 'local' } });
      expect(isPeerRequest(req)).toBe(true);
      expect(waivesPasskeySecondFactor(req)).toBe(false);
    }
  });

  test('peer request without header is not waived', () => {
    const req = makeReq({ via: ENTRY, ip: `peer:${ENTRY}` });
    expect(waivesPasskeySecondFactor(req)).toBe(false);
  });

  test('direct request with header and public ip is not waived', () => {
    const req = makeReq({
      ip: '203.0.113.10',
      headers: { [CLIENT_SOURCE_HEADER.name]: 'local' },
    });
    expect(isPeerRequest(req)).toBe(false);
    expect(waivesPasskeySecondFactor(req)).toBe(false);
  });

  test('trusted local client is waived without the header', () => {
    expect(waivesPasskeySecondFactor(makeReq({ ip: '127.0.0.1' }))).toBe(true);
    expect(waivesPasskeySecondFactor(makeReq({ ip: '10.1.2.3' }))).toBe(true);
  });
});
