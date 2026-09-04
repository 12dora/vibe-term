import { describe, expect, test } from 'bun:test';
import { ApiClient } from '@tmex/api-client';
import { SetupApiError } from '@tmex/api-client/local/setup-api';
import { submitBecomeHub, submitBecomeRelay, submitJoinHub } from './submit';

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
        hubPublicUrl: '  https://tmex.example.com  ',
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
      hubPublicUrl: 'https://tmex.example.com',
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
        hubPublicUrl: 'https://tmex.example.com',
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
        hubPublicUrl: 'https://tmex.example.com',
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
  const values = {
    hubUrl: ' https://tmex.example.com ',
    token: 'abc\ndef',
    name: ' 书房 ',
    directEnable: true,
    insecureLocal: true,
  };

  test('非 production 下带上 insecureLocal，token 去空白', async () => {
    const { client, calls } = scripted({
      '/healthz': Response.json({ startedAt: 7 }),
      '/api/setup/join': Response.json({
        ok: true,
        hubUrl: 'https://tmex.example.com',
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
      hubUrl: 'https://tmex.example.com',
      token: 'abcdef',
      name: '书房',
      directEnable: true,
      insecureLocal: true,
    });
  });

  test('production 下不发送 insecureLocal', async () => {
    const { client, calls } = scripted({
      '/healthz': Response.json({ startedAt: 7 }),
      '/api/setup/join': Response.json({
        ok: true,
        hubUrl: 'https://tmex.example.com',
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
