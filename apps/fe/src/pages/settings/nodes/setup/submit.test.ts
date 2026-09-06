import { describe, expect, test } from 'bun:test';
import { ApiClient } from '@vibeterm/api-client';
import { SetupApiError } from '@vibeterm/api-client/local/setup-api';
import { createAddressProbeCore, precheckProbe } from './address-probe';
import {
  submitBecomeHub,
  submitBecomeRelay,
  submitJoinHub,
  submitJoinHubDiscovered,
  submitJoinRelay,
  submitJoinRelayDiscovered,
} from './submit';
import type { JoinHubValues, JoinRelayValues } from './validation';

function joinHubValues(overrides: Partial<JoinHubValues>): JoinHubValues {
  return {
    method: 'password',
    hubUrl: '',
    token: '',
    password: 'hunter2hunter2',
    name: 'studio',
    directEnable: false,
    insecureLocal: false,
    ...overrides,
  };
}

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

describe('submitBecomeHub', () => {
  test('先读 startedAt 再提交，并对输入做 trim', async () => {
    const { client, calls } = scripted({
      '/healthz': Response.json({ startedAt: 1234 }),
      '/api/setup/hub': Response.json({
        ok: true,
        fingerprint: 'fp',
        direct: 'enabled',
        directError: null,
        restarting: true,
      }),
    });

    const outcome = await submitBecomeHub(
      {
        hubPublicUrl: '  https://vibeterm.example.com  ',
        username: ' alice ',
        password: 'hunter2hunter2',
        confirmPassword: 'hunter2hunter2',
        directEnable: true,
      },
      client
    );

    expect(outcome.previousStartedAt).toBe(1234);
    expect(outcome.result.fingerprint).toBe('fp');
    expect(calls.map((c) => c.url)).toEqual(['/healthz', '/api/setup/hub']);
    expect(calls[1].body).toEqual({
      hubPublicUrl: 'https://vibeterm.example.com',
      username: 'alice',
      password: 'hunter2hunter2',
      directEnable: true,
    });
  });

  test('healthz 读不到也照样提交，previousStartedAt 为 null', async () => {
    const { client } = scripted({
      '/healthz': new Response('', { status: 503 }),
      '/api/setup/hub': Response.json({
        ok: true,
        fingerprint: 'fp',
        direct: 'skipped',
        directError: null,
        restarting: true,
      }),
    });
    const outcome = await submitBecomeHub(
      {
        hubPublicUrl: 'https://vibeterm.example.com',
        username: 'alice',
        password: 'hunter2hunter2',
        confirmPassword: 'hunter2hunter2',
        directEnable: false,
      },
      client
    );
    expect(outcome.previousStartedAt).toBeNull();
  });

  test('后端错误码原样抛给调用方', async () => {
    const { client } = scripted({
      '/healthz': Response.json({ startedAt: 1 }),
      '/api/setup/hub': () =>
        new Response(JSON.stringify({ error: { code: 'user_exists', message: 'taken' } }), {
          status: 409,
        }),
    });
    const error = await submitBecomeHub(
      {
        hubPublicUrl: 'https://vibeterm.example.com',
        username: 'alice',
        password: 'hunter2hunter2',
        confirmPassword: 'hunter2hunter2',
        directEnable: false,
      },
      client
    ).catch((e) => e);
    expect(error).toBeInstanceOf(SetupApiError);
    expect((error as SetupApiError).code).toBe('user_exists');
  });
});

describe('submitJoinHub', () => {
  const values: JoinHubValues = {
    method: 'token',
    hubUrl: ' https://vibeterm.example.com ',
    token: 'abc\ndef',
    password: '',
    name: ' 书房 ',
    directEnable: true,
    insecureLocal: true,
  };

  test('非 production 下带上 insecureLocal，token 去空白', async () => {
    const { client, calls } = scripted({
      '/healthz': Response.json({ startedAt: 7 }),
      '/api/setup/join': Response.json({
        ok: true,
        hubUrl: 'https://vibeterm.example.com',
        username: 'alice',
        direct: 'enabled',
        directError: null,
        restarting: true,
      }),
    });
    const outcome = await submitJoinHub(values, 'development', client);
    expect(outcome.previousStartedAt).toBe(7);
    expect(calls.map((c) => c.url)).toEqual(['/healthz', '/api/setup/join']);
    expect(calls[1].body).toEqual({
      hubUrl: 'https://vibeterm.example.com',
      method: 'token',
      token: 'abcdef',
      name: '书房',
      directEnable: true,
      insecureLocal: true,
    });
  });

  test('密码方式只发 password，不带 token', async () => {
    const { client, calls } = scripted({
      '/healthz': Response.json({ startedAt: 7 }),
      '/api/setup/join': Response.json({
        ok: true,
        hubUrl: 'https://vibeterm.example.com',
        username: 'alice',
        direct: 'skipped',
        directError: null,
        restarting: true,
      }),
    });
    await submitJoinHub(
      { ...values, method: 'password', password: 'hunter2hunter2' },
      'production',
      client
    );
    expect(calls[1].body).toEqual({
      hubUrl: 'https://vibeterm.example.com',
      method: 'password',
      password: 'hunter2hunter2',
      name: '书房',
      directEnable: true,
    });
  });

  test('production 下不发送 insecureLocal', async () => {
    const { client, calls } = scripted({
      '/healthz': Response.json({ startedAt: 7 }),
      '/api/setup/join': Response.json({
        ok: true,
        hubUrl: 'https://vibeterm.example.com',
        username: 'alice',
        direct: 'skipped',
        directError: null,
        restarting: true,
      }),
    });
    await submitJoinHub(values, 'production', client);
    expect(calls[1].body).not.toHaveProperty('insecureLocal');
  });
});

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
  /** 记录每个 setup 端点收到的 body；`precheck` 按无端口地址给出高位端口。 */
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

  /** 表单里的那条链路：探测核心 + precheck 适配器，与组件同一份实现。 */
  function discoverer(client: ApiClient, kind: 'hub' | 'relay') {
    const core = createAddressProbeCore();
    return async (url: string) => (await core.run(url, precheckProbe(client, kind))) ?? url;
  }

  test('凭据先填、地址最后填直接提交：端口在提交里现定，发出去的是带端口的地址', async () => {
    const { client, calls } = harness('https://hub.example.com:13443');
    // 失焦探测一次都没跑过：`values.hubUrl` 还是用户刚敲进去的无端口地址。
    const values = joinHubValues({ hubUrl: 'https://hub.example.com' });
    await submitJoinHubDiscovered(values, 'production', discoverer(client, 'hub'), client);

    expect(calls.map((call) => call.path)).toEqual(['/api/setup/precheck', '/api/setup/join']);
    expect(calls[0]?.body).toEqual({ url: 'https://hub.example.com', kind: 'hub' });
    expect(calls[1]?.body.hubUrl).toBe('https://hub.example.com:13443');
  });

  test('地址已写端口：不探测，端口原样提交', async () => {
    const { client, calls } = harness('https://hub.example.com:2053');
    const values = joinHubValues({ hubUrl: 'https://hub.example.com:8443' });
    await submitJoinHubDiscovered(values, 'production', discoverer(client, 'hub'), client);

    expect(calls.map((call) => call.path)).toEqual(['/api/setup/join']);
    expect(calls[0]?.body.hubUrl).toBe('https://hub.example.com:8443');
  });

  test('一个端口都没答话：沿用用户输入，由后端给出真正的失败原因', async () => {
    const { client, calls } = harness(null);
    const values = joinHubValues({ hubUrl: 'https://hub.example.com' });
    await submitJoinHubDiscovered(values, 'production', discoverer(client, 'hub'), client);

    expect(calls[1]?.body.hubUrl).toBe('https://hub.example.com');
  });

  test('中继侧按中继判据探测，探到的端口进 relay-join', async () => {
    const { client, calls } = harness('https://relay.example.com:13443');
    const values = joinRelayValues({ relayUrl: 'https://relay.example.com' });
    await submitJoinRelayDiscovered(values, discoverer(client, 'relay'), client);

    expect(calls[0]?.body).toEqual({ url: 'https://relay.example.com', kind: 'relay' });
    expect(calls[1]?.body.relayUrl).toBe('https://relay.example.com:13443');
  });
});
