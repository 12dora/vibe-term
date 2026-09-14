import { describe, expect, test } from 'bun:test';
import { ApiClient } from '@vibeterm/api-client';
import { createAddressProbeCore, precheckProbe } from './address-probe';
import { submitBecomeRelay, submitJoinRelay, submitJoinRelayDiscovered } from './submit';
import type { JoinRelayValues } from './validation';

function joinRelayValues(overrides: Partial<JoinRelayValues>): JoinRelayValues {
  return {
    relayUrl: '',
    tenantId: 'a'.repeat(32),
    password: 'hunter2hunter2',
    name: 'studio',
    caFingerprint: '',
    directEnable: false,
    ...overrides,
  };
}

type Call = { url: string; body: unknown };

function scripted(responses: Record<string, Response | (() => Response)>): {
  client: ApiClient;
  calls: Call[];
} {
  const calls: Call[] = [];
  const client = new ApiClient('', (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const entry = responses[url];
    if (!entry) return Promise.resolve(new Response('{}', { status: 404 }));
    return Promise.resolve(typeof entry === 'function' ? entry() : entry.clone());
  });
  return { client, calls };
}

describe('submitBecomeRelay', () => {
  const relayResponse = Response.json({
    ok: true,
    role: 'relay,node',
    relayPublicUrl: 'https://relay.example.com',
    hasPassword: true,
    restarting: true,
    fingerprint: 'fp',
  });

  test('中继兼节点：账号三件一起发，地址与口令做 trim', async () => {
    const { client, calls } = scripted({
      '/healthz': Response.json({ startedAt: 77 }),
      '/api/setup/relay': relayResponse,
    });

    const outcome = await submitBecomeRelay(
      {
        relayPublicUrl: '  https://relay.example.com  ',
        relayPassword: '  s3cret-token  ',
        alsoNode: true,
        username: ' alice ',
        password: 'hunter2hunter2',
        confirmPassword: 'hunter2hunter2',
        directEnable: true,
      },
      client
    );

    expect(outcome.previousStartedAt).toBe(77);
    expect(calls.map((c) => c.url)).toEqual(['/healthz', '/api/setup/relay']);
    expect(calls[1].body).toEqual({
      role: 'relay,node',
      relayPublicUrl: 'https://relay.example.com',
      relayPassword: 's3cret-token',
      username: 'alice',
      password: 'hunter2hunter2',
      directEnable: true,
    });
  });

  test('纯中继：不发账号字段；空口令发 null', async () => {
    const { client, calls } = scripted({
      '/healthz': Response.json({ startedAt: 1 }),
      '/api/setup/relay': Response.json({
        ok: true,
        role: 'relay',
        relayPublicUrl: 'https://relay.example.com',
        hasPassword: false,
        restarting: true,
      }),
    });

    await submitBecomeRelay(
      {
        relayPublicUrl: 'https://relay.example.com',
        relayPassword: '   ',
        alsoNode: false,
        username: 'ignored',
        password: 'ignored-password',
        confirmPassword: 'ignored-password',
        directEnable: true,
      },
      client
    );

    expect(calls[1].body).toEqual({
      role: 'relay',
      relayPublicUrl: 'https://relay.example.com',
      relayPassword: null,
    });
  });
});

describe('submitJoinRelay', () => {
  const values: JoinRelayValues = {
    relayUrl: ' https://relay.example.com ',
    tenantId: ' AABBCCDDEEFF00112233445566778899 ',
    password: 'hunter2hunter2',
    name: ' 书房 ',
    caFingerprint: '',
    directEnable: true,
  };

  const relayJoinResponse = () =>
    Response.json({
      ok: true,
      relayUrl: 'https://relay.example.com',
      tenantId: 'aabbccddeeff00112233445566778899',
      username: 'alice',
      direct: 'enabled',
      directError: null,
      restarting: true,
    });

  test('地址与租户编号归一化，指纹为空时不发该字段', async () => {
    const { client, calls } = scripted({
      '/healthz': Response.json({ startedAt: 11 }),
      '/api/setup/relay-join': relayJoinResponse(),
    });
    const outcome = await submitJoinRelay(values, client);
    expect(outcome.previousStartedAt).toBe(11);
    expect(calls.map((c) => c.url)).toEqual(['/healthz', '/api/setup/relay-join']);
    expect(calls[1].body).toEqual({
      relayUrl: 'https://relay.example.com',
      tenantId: 'aabbccddeeff00112233445566778899',
      password: 'hunter2hunter2',
      name: '书房',
      directEnable: true,
    });
  });

  test('填了 CA 指纹就带上，并转成小写', async () => {
    const { client, calls } = scripted({
      '/healthz': Response.json({ startedAt: 11 }),
      '/api/setup/relay-join': relayJoinResponse(),
    });
    await submitJoinRelay({ ...values, caFingerprint: ` ${'A'.repeat(64)} ` }, client);
    expect((calls[1].body as { caFingerprint: string }).caFingerprint).toBe('a'.repeat(64));
  });
});

describe('提交前定端口', () => {
  function harness(resolvedUrl: string | null) {
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    const client = new ApiClient('', async (url, init) => {
      const path = url;
      if (path === '/healthz') return Response.json({ startedAt: 1 });
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ path, body });
      if (path === '/api/setup/precheck') {
        return Response.json({
          reachable: resolvedUrl !== null,
          isSelf: false,
          status: 200,
          error: null,
          resolvedUrl,
          triedPorts: [443, 13443],
          probed: true,
        });
      }
      return Response.json({ ok: true, hubUrl: 'x', username: 'u', direct: 'skipped' });
    });
    return { client, calls };
  }

  function discoverer(client: ApiClient) {
    const core = createAddressProbeCore();
    return async (url: string) => (await core.run(url, precheckProbe(client, 'relay'))) ?? url;
  }

  test('中继侧按中继判据探测，探到的端口进 relay-join', async () => {
    const { client, calls } = harness('https://relay.example.com:13443');
    const values = joinRelayValues({ relayUrl: 'https://relay.example.com' });
    await submitJoinRelayDiscovered(values, discoverer(client), client);

    expect(calls[0]?.body).toEqual({ url: 'https://relay.example.com', kind: 'relay' });
    expect(calls[1]?.body.relayUrl).toBe('https://relay.example.com:13443');
  });
});
