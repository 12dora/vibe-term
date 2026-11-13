import { afterEach, describe, expect, test } from 'bun:test';
import { setMeshRequestContext } from '../mesh/mesh-deps';
import {
  accessEnforcementActive,
  guardEntryAccess,
  resetAccessGuardForTests,
  setAccessGuardFetch,
  setAccessGuardSnapshot,
} from './access-guard';
import { generateAccessTestKey, signAccessJwt } from './access-jwt';
import { isAccessGuardExemptPath } from './access-paths';
import { guardedGatewayFetch } from './gateway-fetch';

const TEAM = 'team.cloudflareaccess.com';
const AUD = 'aud-1';
const ENFORCED = {
  enforceJwt: true,
  configured: true,
  effective: true,
  teamDomain: TEAM,
  aud: AUD,
};

const dummyServer = {} as Bun.Server<unknown>;

afterEach(() => {
  resetAccessGuardForTests();
});

describe('isAccessGuardExemptPath', () => {
  test('exempts healthz and does not treat retired hub paths as machine prefixes', () => {
    expect(isAccessGuardExemptPath('/healthz')).toBe(true);
    expect(isAccessGuardExemptPath('/hub/uplink')).toBe(false);
    expect(isAccessGuardExemptPath('/hub/')).toBe(false);
    expect(isAccessGuardExemptPath('/api/hub/enrollments/redeem')).toBe(false);
    expect(isAccessGuardExemptPath('/api/hub/enrollments')).toBe(false);
    expect(isAccessGuardExemptPath('/api/hub/nodes')).toBe(false);
    expect(isAccessGuardExemptPath('/api/devices')).toBe(false);
    expect(isAccessGuardExemptPath('/ws')).toBe(false);
    expect(isAccessGuardExemptPath('/api/auth/login')).toBe(false);
  });

  test('exempts the relay machine paths but not the relay admin API', () => {
    expect(isAccessGuardExemptPath('/relay/uplink')).toBe(true);
    expect(isAccessGuardExemptPath('/api/relay/health')).toBe(true);
    expect(isAccessGuardExemptPath('/api/relay/enroll')).toBe(true);
    expect(isAccessGuardExemptPath('/api/relay/password/rotate')).toBe(true);
    expect(
      isAccessGuardExemptPath(`/api/relay/tenants/${'ab'.repeat(16)}/enrollments/redeem`)
    ).toBe(true);
    expect(isAccessGuardExemptPath('/api/relay/status')).toBe(false);
    expect(isAccessGuardExemptPath('/api/relay/password')).toBe(false);
  });
});

describe('guardEntryAccess', () => {
  test('header without JWT is 403; valid JWT passes; relay uplink is not blocked', async () => {
    setAccessGuardSnapshot(() => ENFORCED);
    const denied = await guardEntryAccess(
      new Request('http://127.0.0.1/api/devices', { headers: { 'cf-connecting-ip': '1.2.3.4' } })
    );
    expect(denied?.status).toBe(403);

    const { privateKey, jwk } = await generateAccessTestKey('k1');
    setAccessGuardFetch(async () => Response.json({ keys: [jwk] }));
    const token = await signAccessJwt(
      privateKey,
      { alg: 'RS256', kid: 'k1', typ: 'JWT' },
      {
        aud: [AUD],
        iss: `https://${TEAM}`,
        exp: Math.floor(Date.now() / 1000) + 120,
      }
    );
    const ok = await guardEntryAccess(
      new Request('http://127.0.0.1/api/devices', {
        headers: { 'cf-connecting-ip': '1.2.3.4', 'Cf-Access-Jwt-Assertion': token },
      })
    );
    expect(ok).toBeNull();

    const uplink = await guardEntryAccess(
      new Request('http://127.0.0.1/relay/uplink', { headers: { 'cf-connecting-ip': '1.2.3.4' } })
    );
    expect(uplink).toBeNull();
  });

  test('skips peer-inbound even with cf-connecting-ip and no JWT', async () => {
    setAccessGuardSnapshot(() => ENFORCED);
    const req = new Request('http://127.0.0.1/api/devices', {
      headers: { 'cf-connecting-ip': '1.2.3.4' },
    });
    setMeshRequestContext(req, { via: 'peer-a', clientIp: 'peer:peer-a' });
    expect(await guardEntryAccess(req)).toBeNull();
  });

  test('effective=false does not enforce', async () => {
    setAccessGuardSnapshot(() => ({ ...ENFORCED, effective: false }));
    const res = await guardEntryAccess(
      new Request('http://127.0.0.1/api/devices', { headers: { 'cf-connecting-ip': '1.2.3.4' } })
    );
    expect(res).toBeNull();
  });
});

describe('guardedGatewayFetch', () => {
  test('direct/managed entry: header+no JWT → 403 before inner handler', async () => {
    setAccessGuardSnapshot(() => ENFORCED);
    let inner = 0;
    const res = await guardedGatewayFetch(
      new Request('http://127.0.0.1/api/devices', { headers: { 'cf-connecting-ip': '1.2.3.4' } }),
      async () => {
        inner += 1;
        return new Response('ok');
      },
      dummyServer
    );
    expect(res.status).toBe(403);
    expect(inner).toBe(0);
  });

  test('direct/managed entry: valid JWT reaches inner handler', async () => {
    setAccessGuardSnapshot(() => ENFORCED);
    const { privateKey, jwk } = await generateAccessTestKey('k-ok');
    setAccessGuardFetch(async () => Response.json({ keys: [jwk] }));
    const token = await signAccessJwt(
      privateKey,
      { alg: 'RS256', kid: 'k-ok', typ: 'JWT' },
      {
        aud: [AUD],
        iss: `https://${TEAM}`,
        exp: Math.floor(Date.now() / 1000) + 120,
      }
    );
    const res = await guardedGatewayFetch(
      new Request('http://127.0.0.1/api/devices', {
        headers: { 'cf-connecting-ip': '1.2.3.4', 'Cf-Access-Jwt-Assertion': token },
      }),
      async () => new Response('from-inner'),
      dummyServer
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('from-inner');
  });

  test('direct/managed entry: /relay/uplink without JWT is not blocked', async () => {
    setAccessGuardSnapshot(() => ENFORCED);
    const res = await guardedGatewayFetch(
      new Request('http://127.0.0.1/relay/uplink', { headers: { 'cf-connecting-ip': '1.2.3.4' } }),
      async () => new Response('uplink'),
      dummyServer
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('uplink');
  });
});

describe('guardedGatewayFetch: browser request guard', () => {
  const upgrade = (origin: string) => ({
    upgrade: 'websocket',
    connection: 'upgrade',
    origin,
  });

  test('foreign Origin on WebSocket upgrades is 403 before the inner handler', async () => {
    for (const path of ['/api/exec/ws', '/ws']) {
      let inner = 0;
      const res = await guardedGatewayFetch(
        new Request(`http://127.0.0.1:9883${path}`, { headers: upgrade('https://evil.example') }),
        async () => {
          inner += 1;
          return new Response('ok');
        },
        dummyServer
      );
      expect(res.status).toBe(403);
      expect(inner).toBe(0);
    }
  });

  test('same-origin upgrade and Origin-less clients reach the inner handler', async () => {
    const same = await guardedGatewayFetch(
      new Request('http://127.0.0.1:9883/api/exec/ws', {
        headers: upgrade('http://127.0.0.1:9883'),
      }),
      async () => new Response('inner'),
      dummyServer
    );
    expect(same.status).toBe(200);
    const cli = await guardedGatewayFetch(
      new Request('http://127.0.0.1:9883/api/exec', { method: 'POST' }),
      async () => new Response('inner'),
      dummyServer
    );
    expect(cli.status).toBe(200);
  });

  test('an unrecognised Host is 421 (the runtime has no login gate)', async () => {
    const res = await guardedGatewayFetch(
      new Request('http://rebind.example.com:9883/api/devices'),
      async () => new Response('inner'),
      dummyServer
    );
    expect(res.status).toBe(421);
  });
});

describe('accessEnforcementActive', () => {
  test('requires effective when provided', () => {
    expect(accessEnforcementActive({ ...ENFORCED, effective: false })).toBe(false);
    expect(accessEnforcementActive(ENFORCED)).toBe(true);
    expect(
      accessEnforcementActive({
        enforceJwt: true,
        configured: true,
        aud: AUD,
        teamDomain: TEAM,
      })
    ).toBe(true);
  });
});
