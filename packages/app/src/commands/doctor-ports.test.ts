import { afterEach, describe, expect, test } from 'bun:test';
import { setLang, t } from '../i18n';
import type { FetchLike } from '../lib/fetch-like';
import {
  isTcpListening,
  meshSelfBlockedPortChecks,
  peerPortDoctorCheck,
  portPlanDoctorChecks,
} from './doctor-ports';

const servers: Array<{ stop: () => void }> = [];

afterEach(() => {
  setLang('en');
  for (const server of servers.splice(0)) server.stop();
});

describe('portPlanDoctorChecks', () => {
  test('prints the live plan for the role', () => {
    const checks = portPlanDoctorChecks({
      VIBETERM_ROLES: 'hub,node',
      VIBETERM_HUB_PUBLIC_URL: 'https://hub.example.com',
      VIBETERM_PEER_PORT: '39001',
    });
    expect(checks).toEqual([
      {
        id: 'ports.plan',
        level: 'pass',
        message: t('doctor.ports.plan', { list: '443/tcp, 39001/tcp, 40000-40099/udp' }),
      },
    ]);
  });
});

describe('peerPortDoctorCheck', () => {
  test('skips pure relay (no peer in the plan)', async () => {
    expect(await peerPortDoctorCheck({ VIBETERM_ROLES: 'relay' })).toBeNull();
  });

  test('pass when the probe connects; warn when it does not', async () => {
    const listening = await peerPortDoctorCheck(
      { VIBETERM_ROLES: 'node', VIBETERM_PEER_PORT: '39007' },
      async () => true
    );
    expect(listening).toEqual({
      id: 'ports.peer',
      level: 'pass',
      message: t('doctor.ports.peerListening', { port: 39007 }),
    });
    const down = await peerPortDoctorCheck(
      { VIBETERM_ROLES: 'node', VIBETERM_PEER_PORT: '39007' },
      async () => false
    );
    expect(down?.level).toBe('warn');
    expect(down?.message).toBe(t('doctor.ports.peerNotListening', { port: 39007 }));
  });

  test('TCP connect sees a local listener', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response('ok'),
    });
    servers.push(server);
    const port = server.port ?? 0;
    expect(port).toBeGreaterThan(0);
    expect(await isTcpListening('127.0.0.1', port)).toBe(true);
    const check = await peerPortDoctorCheck({
      VIBETERM_ROLES: 'node',
      VIBETERM_PEER_PORT: String(port),
      VIBETERM_PEER_BIND_HOST: '127.0.0.1',
    });
    expect(check?.level).toBe('pass');
    expect(await isTcpListening('127.0.0.1', 1)).toBe(false);
  });
});

describe('meshSelfBlockedPortChecks', () => {
  test('skips when nodes is unreachable or unauthorized', async () => {
    const denied: FetchLike = async () => new Response('no', { status: 401 });
    expect(
      await meshSelfBlockedPortChecks({ host: '127.0.0.1', port: '9', fetchImpl: denied })
    ).toEqual([]);
    const down: FetchLike = async () => {
      throw new Error('offline');
    };
    expect(
      await meshSelfBlockedPortChecks({ host: '127.0.0.1', port: '9', fetchImpl: down })
    ).toEqual([]);
  });

  test('prints blocked self-row ports and ignores open ones', async () => {
    const fetchImpl: FetchLike = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/auth/mode') return Response.json({ nodeId: 'aa'.repeat(16) });
      if (path === '/api/mesh/nodes') {
        return Response.json({
          nodes: [
            {
              id: 'aa'.repeat(16),
              ports: [
                { purpose: 'peer-signaling', proto: 'tcp', port: 39001, status: 'blocked' },
                {
                  purpose: 'rtc-ice',
                  proto: 'udp',
                  range: { begin: 40000, end: 40099 },
                  status: 'open',
                },
              ],
            },
            {
              id: 'bb'.repeat(16),
              ports: [{ purpose: 'peer-signaling', proto: 'tcp', port: 39001, status: 'blocked' }],
            },
          ],
        });
      }
      return new Response('no', { status: 404 });
    };
    const checks = await meshSelfBlockedPortChecks({
      host: '127.0.0.1',
      port: '9883',
      fetchImpl,
      cookieHeader: 'vibeterm_s_self=sid',
    });
    expect(checks).toEqual([
      {
        id: 'ports.blocked',
        level: 'warn',
        message: t('doctor.ports.blocked', { list: '39001/tcp' }),
      },
    ]);
  });

  test('skips when the self row has no blocked ports', async () => {
    const fetchImpl: FetchLike = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/auth/mode') return Response.json({ nodeId: 'aa'.repeat(16) });
      return Response.json({
        nodes: [{ id: 'aa'.repeat(16), ports: [{ status: 'unknown', port: 39001, proto: 'tcp' }] }],
      });
    };
    expect(await meshSelfBlockedPortChecks({ host: '127.0.0.1', port: '9', fetchImpl })).toEqual(
      []
    );
  });
});
