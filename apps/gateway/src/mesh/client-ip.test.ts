import { describe, expect, spyOn, test } from 'bun:test';
import {
  type ClientIpInput,
  UNKNOWN_CLIENT_KEY,
  clientIpFromRequest,
  clientLimiterKey,
  directLocalClass,
  limiterIpKey,
  localClientClass,
  observedIpv4FromClientIp,
  requestIsLoopback,
  resolveClientIp,
  trustedSourceIp,
} from './client-ip';
import { ownMdnsName } from './domain-access-policy';
import { MESH_VIA_SELF, type MeshRequestContext, setMeshRequestContext } from './mesh-deps';

const PROXY = '127.0.0.1';
const LAN_PROXY = '10.0.0.9';
const PUBLIC_SOCKET = '203.0.113.5';
const REAL = '198.51.100.7';

function resolve(
  socketIp: string | undefined,
  init: Record<string, string>,
  extra: Partial<ClientIpInput> = {}
): string | undefined {
  return resolveClientIp({ socketIp, headers: new Headers(init), trustProxy: true, ...extra });
}

function req(
  headers: Record<string, string>,
  ctx: Partial<MeshRequestContext>,
  url = 'http://localhost/api/x'
): Request {
  const request = new Request(url, { headers });
  setMeshRequestContext(request, { via: MESH_VIA_SELF, ...ctx });
  return request;
}

describe('resolveClientIp', () => {
  test('trustProxy off: the socket is the client whatever the headers say', () => {
    const h = { 'cf-connecting-ip': '10.0.0.1', 'x-forwarded-for': REAL, 'x-real-ip': PROXY };
    expect(resolve(PROXY, h, { trustProxy: false })).toBe(PROXY);
    expect(resolve(undefined, h, { trustProxy: false })).toBeUndefined();
  });

  test('default header x-forwarded-for: rightmost entry wins, X-Real-IP / CF are ignored', () => {
    const h = { 'x-real-ip': '127.0.0.1', 'x-forwarded-for': REAL };
    expect(resolve(PROXY, h)).toBe(REAL);
    expect(resolve(PROXY, { 'x-forwarded-for': `127.0.0.1, 10.0.0.1, ${REAL}` })).toBe(REAL);
    expect(resolve(PROXY, { 'cf-connecting-ip': '10.0.0.1', 'x-forwarded-for': REAL })).toBe(REAL);
  });

  test('configured header absent on a forwarded request → unknown, never the proxy socket', () => {
    expect(resolve(PROXY, { 'cf-connecting-ip': '10.0.0.1' })).toBeUndefined();
    expect(resolve(PROXY, { 'x-real-ip': '127.0.0.1' })).toBeUndefined();
    expect(resolve(PROXY, {})).toBe(PROXY);
  });

  test('malformed or empty rightmost entry does not fall back to earlier entries', () => {
    expect(resolve(PROXY, { 'x-forwarded-for': `${REAL}, not-an-ip` })).toBeUndefined();
    expect(resolve(PROXY, { 'x-forwarded-for': `${REAL},  ` })).toBeUndefined();
    expect(resolve(PROXY, { 'x-forwarded-for': '127.0.0.1:8080' })).toBeUndefined();
    expect(resolve(PROXY, { 'x-forwarded-for': '127.000.000.001' })).toBeUndefined();
  });

  test('cf-connecting-ip: used from a loopback / LAN proxy hop, ignored from a public socket', () => {
    const h = { 'cf-connecting-ip': REAL, 'x-forwarded-for': '10.0.0.1' };
    expect(resolve(PROXY, h, { clientIpHeader: 'cf-connecting-ip' })).toBe(REAL);
    expect(resolve(LAN_PROXY, h, { clientIpHeader: 'cf-connecting-ip' })).toBe(REAL);
    expect(resolve(PUBLIC_SOCKET, h, { clientIpHeader: 'cf-connecting-ip' })).toBe(PUBLIC_SOCKET);
  });

  test('x-real-ip only when configured', () => {
    const h = { 'x-real-ip': REAL, 'x-forwarded-for': '10.0.0.1' };
    expect(resolve(PROXY, h, { clientIpHeader: 'x-real-ip' })).toBe(REAL);
  });

  test('public socket with trustProxy and spoofed headers resolves to the socket', () => {
    const h = { 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1' };
    expect(resolve(PUBLIC_SOCKET, h)).toBe(PUBLIC_SOCKET);
    expect(resolve('peer:ab', h)).toBe('peer:ab');
  });

  test('IPv6 literals in the configured header', () => {
    expect(resolve(PROXY, { 'x-forwarded-for': '[2001:db8::2]' })).toBe('2001:db8::2');
    expect(resolve('::1', { 'x-forwarded-for': '2001:DB8::1' })).toBe('2001:db8::1');
    expect(
      resolve(PROXY, { 'cf-connecting-ip': 'fe80::1%en0' }, { clientIpHeader: 'cf-connecting-ip' })
    ).toBe('fe80::1');
  });

  test('clientIpFromRequest reads trustProxy and clientIpHeader from the request context', () => {
    const h = { 'x-forwarded-for': '10.0.0.1', 'cf-connecting-ip': REAL };
    expect(
      clientIpFromRequest(
        req(h, { clientIp: PROXY, trustProxy: true, clientIpHeader: 'cf-connecting-ip' })
      )
    ).toBe(REAL);
    expect(clientIpFromRequest(req(h, { clientIp: PROXY, trustProxy: true }))).toBe('10.0.0.1');
  });
});

describe('localClientClass / requestIsLoopback', () => {
  test('direct loopback / LAN socket without forwarding headers', () => {
    expect(localClientClass(req({}, { clientIp: '127.0.0.1' }))).toBe('loopback');
    expect(localClientClass(req({}, { clientIp: '::1' }))).toBe('loopback');
    expect(localClientClass(req({}, { clientIp: '192.168.1.5' }))).toBe('lan');
    expect(localClientClass(req({}, { clientIp: PUBLIC_SOCKET }))).toBeNull();
    expect(requestIsLoopback(req({}, { clientIp: '127.0.0.1' }))).toBe(true);
    expect(requestIsLoopback(req({}, { clientIp: '192.168.1.5' }))).toBe(false);
  });

  test('any forwarding header (even empty, even claiming loopback) is never local', () => {
    for (const name of ['forwarded', 'x-forwarded-for', 'x-real-ip', 'cf-connecting-ip']) {
      for (const value of ['', '127.0.0.1', 'for=127.0.0.1']) {
        for (const trustProxy of [true, false]) {
          const request = req({ [name]: value }, { clientIp: '127.0.0.1', trustProxy });
          expect(localClientClass(request)).toBeNull();
          expect(requestIsLoopback(request)).toBe(false);
        }
      }
    }
  });

  test('peer inbound, missing socket and unknown sockets are never local', () => {
    expect(localClientClass(req({}, { clientIp: 'peer:ab' }))).toBeNull();
    expect(localClientClass(req({}, { via: 'ab'.repeat(16), clientIp: '127.0.0.1' }))).toBeNull();
    expect(localClientClass(req({}, {}))).toBeNull();
    expect(localClientClass(req({}, { clientIp: 'local' }))).toBeNull();
  });
});

describe('localClientClass: request authority', () => {
  test('a loopback socket is local only when Host is a name this machine answers to', () => {
    for (const host of ['127.0.0.1:9883', '[::1]:9883', 'localhost:9883', ownMdnsName()]) {
      const request = req({}, { clientIp: '127.0.0.1' }, `http://${host}/api/x`);
      expect(localClientClass(request)).toBe('loopback');
    }
    for (const host of ['attacker.example:9883', 'other-box.local:9883']) {
      const request = req({}, { clientIp: '127.0.0.1' }, `http://${host}/api/x`);
      expect(localClientClass(request)).toBeNull();
      expect(requestIsLoopback(request)).toBe(false);
      expect(directLocalClass(request)).toBe('loopback');
    }
  });

  test('the raw Host header decides, not only the URL', () => {
    const request = req({ host: 'attacker.example:9883' }, { clientIp: '127.0.0.1' });
    expect(localClientClass(request)).toBeNull();
  });

  test('proxy-only headers without a client address still mark the request as forwarded', () => {
    for (const name of [
      'x-forwarded-proto',
      'x-forwarded-host',
      'via',
      'true-client-ip',
      'x-client-ip',
    ]) {
      expect(localClientClass(req({ [name]: 'x' }, { clientIp: '127.0.0.1' }))).toBeNull();
    }
  });
});

describe('trustedSourceIp', () => {
  test('direct local socket, trusted proxy hop, otherwise null', () => {
    expect(trustedSourceIp(req({}, { clientIp: '192.168.1.5' }))).toBe('192.168.1.5');
    expect(
      trustedSourceIp(req({ 'x-forwarded-for': REAL }, { clientIp: PROXY, trustProxy: false }))
    ).toBeNull();
    expect(
      trustedSourceIp(req({ 'x-forwarded-for': REAL }, { clientIp: PROXY, trustProxy: true }))
    ).toBe(REAL);
    expect(trustedSourceIp(req({}, { clientIp: PUBLIC_SOCKET }))).toBeNull();
  });
});

describe('clientLimiterKey', () => {
  test('a proxy socket without trust and an unresolved client have no per-client key', () => {
    expect(
      clientLimiterKey(req({ 'x-forwarded-for': REAL }, { clientIp: PROXY, trustProxy: false }))
    ).toBeNull();
    expect(
      clientLimiterKey(req({ 'x-real-ip': REAL }, { clientIp: PROXY, trustProxy: true }))
    ).toBeNull();
    expect(clientLimiterKey(req({}, {}))).toBeNull();
  });

  test('direct clients and trusted proxy resolution keep their own key', () => {
    expect(clientLimiterKey(req({}, { clientIp: PROXY }))).toBe(PROXY);
    expect(
      clientLimiterKey(req({ 'x-forwarded-for': REAL }, { clientIp: PROXY, trustProxy: true }))
    ).toBe(REAL);
    expect(clientLimiterKey(req({ 'x-forwarded-for': REAL }, { clientIp: PUBLIC_SOCKET }))).toBe(
      PUBLIC_SOCKET
    );
    expect(clientLimiterKey(req({}, { clientIp: '2001:db8:1:2::9' }))).toBe('2001:db8:1:2::/64');
  });
});

describe('missing configured client-IP header', () => {
  test('warns once per header combination', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      resolve(PROXY, { 'x-real-ip': REAL, via: '1.1 a' }, { clientIpHeader: 'cf-connecting-ip' });
      resolve(PROXY, { 'x-real-ip': REAL }, { clientIpHeader: 'cf-connecting-ip' });
      expect(warn).toHaveBeenCalledTimes(1);
      resolve(PROXY, { forwarded: 'for=1.2.3.4' }, { clientIpHeader: 'cf-connecting-ip' });
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('limiterIpKey', () => {
  test('IPv6 clients share one bucket per /64', () => {
    expect(limiterIpKey('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(limiterIpKey('2001:db8:1:2:bbbb:cccc:dddd:eeee')).toBe('2001:db8:1:2::/64');
    expect(limiterIpKey('[2001:DB8:1:3::9]')).toBe('2001:db8:1:3::/64');
    expect(limiterIpKey('2001:db8:1:2::1')).not.toBe(limiterIpKey('2001:db8:1:3::1'));
  });

  test('IPv4 and v4-mapped keep the full address; missing is unknown', () => {
    expect(limiterIpKey(REAL)).toBe(REAL);
    expect(limiterIpKey('::ffff:198.51.100.7')).toBe(REAL);
    expect(limiterIpKey(undefined)).toBe(UNKNOWN_CLIENT_KEY);
    expect(limiterIpKey('')).toBe(UNKNOWN_CLIENT_KEY);
    expect(limiterIpKey('peer:ab')).toBe('peer:ab');
  });
});

describe('observedIpv4FromClientIp', () => {
  test('keeps dotted IPv4 including loopback and LAN', () => {
    expect(observedIpv4FromClientIp('203.0.113.10')).toBe('203.0.113.10');
    expect(observedIpv4FromClientIp('127.0.0.1')).toBe('127.0.0.1');
    expect(observedIpv4FromClientIp('10.0.0.3')).toBe('10.0.0.3');
  });

  test('unwraps IPv4-mapped and rejects pure IPv6 / garbage', () => {
    expect(observedIpv4FromClientIp('::ffff:203.0.113.10')).toBe('203.0.113.10');
    expect(observedIpv4FromClientIp('[::ffff:203.0.113.9]')).toBe('203.0.113.9');
    expect(observedIpv4FromClientIp('2001:db8::1')).toBeUndefined();
    expect(observedIpv4FromClientIp('::1')).toBeUndefined();
    expect(observedIpv4FromClientIp('not-an-ip')).toBeUndefined();
    expect(observedIpv4FromClientIp('')).toBeUndefined();
    expect(observedIpv4FromClientIp(undefined)).toBeUndefined();
  });
});
