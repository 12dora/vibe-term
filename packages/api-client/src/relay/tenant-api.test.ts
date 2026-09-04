import { describe, expect, test } from 'bun:test';
import { ApiClient } from '../client';
import { RelayApiError } from './admin-api';
import {
  RELAY_LAST,
  RelayTenantApi,
  isRelayNotConfigured,
  isRelayPasswordInvalid,
  isRelayQuotaExceeded,
  isRelayRoutesMissing,
  normalizeJoinMaterial,
  normalizeRelayStatus,
  relayErrorCode,
} from './tenant-api';

type Call = { url: string; init?: RequestInit };

function recorder(responses: Response[]): { api: RelayTenantApi; calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;
  const client = new ApiClient('', (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(responses[index++] ?? new Response('{}', { status: 200 }));
  });
  return { api: new RelayTenantApi(client), calls };
}

function ok(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** 节点侧的错误体是 `{ code }`（`session-middleware.ts` 的 `jsonError`）。 */
function fail(status: number, code: string, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ code, ...extra }), { status });
}

function bodyOf(call: Call): unknown {
  return JSON.parse(String(call.init?.body));
}

/** 32 字节 base64url（无填充）= 43 个字符。 */
const LOG_KEY_B64 = 'A'.repeat(43);
const TOKEN_B64 = 'B'.repeat(43);

describe('RelayTenantApi 状态', () => {
  test('status 走 /api/mesh/relay/status 并补齐缺省字段', async () => {
    const { api, calls } = recorder([
      ok({ mode: 'relay', tenantId: 'ab'.repeat(16), relays: [{ url: 'https://r.example' }] }),
    ]);
    const status = await api.status();
    expect(calls[0].url).toBe('/api/mesh/relay/status');
    expect(status.mode).toBe('relay');
    expect(status.relays).toEqual([
      {
        url: 'https://r.example',
        priority: 0,
        online: false,
        attached: false,
        rttMs: null,
        lastError: null,
        lastErrorCode: null,
        lastErrorAt: null,
        kicked: false,
      },
    ]);
    expect(status.metaEpoch).toBe(0);
    expect(status.nodesViaRelay).toBe(0);
    expect(status.reauthRequired).toBe(false);
    expect(status.quota).toBeNull();
  });

  test('switchRelay 走 POST /api/mesh/relay/switch', async () => {
    const { api, calls } = recorder([ok({ mode: 'relay', tenantId: 'ab'.repeat(16), relays: [] })]);
    const status = await api.switchRelay('https://b.example');
    expect(calls[0].url).toBe('/api/mesh/relay/switch');
    expect(calls[0].init?.method).toBe('POST');
    expect(bodyOf(calls[0])).toEqual({ url: 'https://b.example' });
    expect(status.mode).toBe('relay');
  });

  test('switchRelay 502 保留 lastError / lastErrorCode', async () => {
    const { api } = recorder([
      fail(502, 'RELAY_SWITCH_FAILED', {
        lastError: 'heartbeat-timeout',
        lastErrorCode: 'heartbeat-lost',
      }),
    ]);
    const error = await api.switchRelay('https://b.example').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(RelayApiError);
    const typed = error as RelayApiError;
    expect(typed.code).toBe('RELAY_SWITCH_FAILED');
    expect(typed.status).toBe(502);
    expect(typed.details).toEqual({
      lastError: 'heartbeat-timeout',
      lastErrorCode: 'heartbeat-lost',
    });
  });

  test('normalizeRelayStatus 对空响应给出 none 模式', () => {
    expect(normalizeRelayStatus(null).mode).toBe('none');
    expect(normalizeRelayStatus({ reauthRequired: true }).reauthRequired).toBe(true);
    const quota = { maxNodes: 8, maxStreams: 16, bandwidthBytesPerSec: null };
    expect(
      normalizeRelayStatus({
        relays: [
          {
            url: 'https://r.example',
            priority: 1,
            online: false,
            attached: false,
            lastError: 'client-too-old',
            lastErrorAt: 7,
          },
        ],
      }).relays[0]
    ).toEqual({
      url: 'https://r.example',
      priority: 1,
      online: false,
      attached: false,
      rttMs: null,
      lastError: 'client-too-old',
      lastErrorCode: null,
      lastErrorAt: 7,
      kicked: false,
    });
    expect(normalizeRelayStatus({ quota }).quota).toEqual({ ...quota, usage: null });
    expect(
      normalizeRelayStatus({
        quota: {
          ...quota,
          usage: {
            currentNodes: 1,
            currentStreams: 0,
            bytesInPerSec: 2,
            bytesOutPerSec: 1,
            sampledAt: 9,
          },
        },
      }).quota?.usage
    ).toEqual({
      currentNodes: 1,
      currentStreams: 0,
      bytesInPerSec: 2,
      bytesOutPerSec: 1,
      sampledAt: 9,
    });
    expect(
      normalizeRelayStatus({
        relays: [{ url: 'https://r.example', online: true, lastError: 'connect-failed' } as never],
      }).relays[0].lastError
    ).toBeNull();
    expect(
      normalizeRelayStatus({
        quota: { ...quota, currentNodes: 2 },
      }).quota?.currentNodes
    ).toBe(2);
  });

  test('路由不存在时抛 404，isRelayRoutesMissing 认得出来', async () => {
    const { api } = recorder([new Response('not found', { status: 404 })]);
    const error = await api.status().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(RelayApiError);
    expect(isRelayRoutesMissing(error)).toBe(true);
  });
});

describe('RelayTenantApi 接入', () => {
  test('proofMaterial 与 enroll 的请求体', async () => {
    const { api, calls } = recorder([
      ok({
        url: 'https://r.example',
        relayHost: 'r.example',
        ts: 1_700_000_000_000,
        maxSkewMs: 300_000,
        rootPublicKey: 'cms',
        rootEpoch: 2,
      }),
      ok({
        tenantId: 'cd'.repeat(16),
        token: 'dG9rZW4',
        passwordEpoch: 1,
        metaEpoch: 3,
        payload: 'cGF5bG9hZA',
        payloadHash: 'aGFzaA',
      }),
    ]);
    const material = await api.proofMaterial('https://r.example');
    expect(calls[0].url).toBe('/api/mesh/relay/enroll/proof-material');
    expect(bodyOf(calls[0])).toEqual({ url: 'https://r.example' });
    expect(material.relayHost).toBe('r.example');

    const enrolled = await api.enroll({
      url: material.url,
      password: 'secret',
      proof: { bytes: 'Ym8', sig: 'c2ln' },
    });
    expect(calls[1].url).toBe('/api/mesh/relay/enroll');
    expect(bodyOf(calls[1])).toEqual({
      url: 'https://r.example',
      password: 'secret',
      proof: { bytes: 'Ym8', sig: 'c2ln' },
    });
    expect(enrolled.payload).toBe('cGF5bG9hZA');
    expect(enrolled.tenantId).toBe('cd'.repeat(16));
  });

  test('口令错 401 与配额 409 都能按 code 判定', async () => {
    const { api } = recorder([
      fail(401, 'RELAY_PASSWORD_INVALID'),
      fail(409, 'RELAY_QUOTA_NODES'),
      fail(409, 'RELAY_NOT_CONFIGURED'),
    ]);
    const wrong = await api
      .enroll({ url: 'https://r.example', proof: { bytes: 'Ym8', sig: 'c2ln' } })
      .catch((err: unknown) => err);
    expect(isRelayPasswordInvalid(wrong)).toBe(true);
    expect(relayErrorCode(wrong)).toBe('RELAY_PASSWORD_INVALID');

    const quota = await api
      .createEnrollment({ enroll_pk: 'a', authorization: 'b', authorization_sig: 'c', exp: 1 })
      .catch((err: unknown) => err);
    expect(isRelayQuotaExceeded(quota)).toBe(true);

    const missing = await api.leavePrepare().catch((err: unknown) => err);
    expect(isRelayNotConfigured(missing)).toBe(true);
  });

  test('BAD_PROOF 的 reason 进 message，便于排查', async () => {
    const { api } = recorder([fail(400, 'BAD_PROOF', { reason: 'ts_skew' })]);
    const error = await api
      .enroll({ url: 'https://r.example', proof: { bytes: 'Ym8', sig: 'c2ln' } })
      .catch((err: unknown) => err);
    expect((error as RelayApiError).message).toBe('BAD_PROOF: ts_skew');
  });
});

describe('RelayTenantApi 待签 payload', () => {
  test('leavePrepare 是整体离开', async () => {
    const { api, calls } = recorder([ok({ payload: 'AA', payloadHash: 'BB', metaEpoch: 2 })]);
    const prepared = await api.leavePrepare();
    expect(calls[0].url).toBe('/api/mesh/relay/leave/prepare');
    expect(bodyOf(calls[0])).toEqual({});
    expect(prepared.payload).toBe('AA');
  });

  test('removePrepare 只送要摘掉的地址', async () => {
    const { api, calls } = recorder([ok({ payload: 'AA', payloadHash: 'BB', metaEpoch: 3 })]);
    const prepared = await api.removePrepare('https://relay-2.example');
    expect(calls[0].url).toBe('/api/mesh/relay/remove/prepare');
    expect(bodyOf(calls[0])).toEqual({ url: 'https://relay-2.example' });
    expect(prepared.metaEpoch).toBe(3);
  });

  test('removePrepare 把 RELAY_LAST 透传成类型化错误', async () => {
    const { api } = recorder([
      new Response(JSON.stringify({ code: 'RELAY_LAST' }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      }),
    ]);
    await expect(api.removePrepare('https://relay.example')).rejects.toMatchObject({
      code: RELAY_LAST,
    });
  });

  test('metaKeyPrepare 原样送 op', async () => {
    const { api, calls } = recorder([
      ok({ epoch: 4, payload: 'AA', payloadHash: 'BB' }),
      ok({ epoch: 5, payload: 'CC', payloadHash: 'DD' }),
    ]);
    await api.metaKeyPrepare({ op: 'admit', node_id: 'ab'.repeat(16) });
    expect(calls[0].url).toBe('/api/mesh/relay/meta-key/prepare');
    expect(bodyOf(calls[0])).toEqual({ op: 'admit', node_id: 'ab'.repeat(16) });
    const rotated = await api.metaKeyPrepare({ op: 'rotate', exclude: ['cd'.repeat(16)] });
    expect(bodyOf(calls[1])).toEqual({ op: 'rotate', exclude: ['cd'.repeat(16)] });
    expect(rotated.epoch).toBe(5);
  });
});

describe('RelayTenantApi enrollment 与 join 材料', () => {
  test('joinMaterial 直读节点侧的 camelCase 字段（每条中继自带凭据）', async () => {
    const { api, calls } = recorder([
      ok({
        logKey: LOG_KEY_B64,
        relays: [{ url: 'https://r.example', tenantId: 'ab'.repeat(16), token: TOKEN_B64 }],
        tenantId: 'ab'.repeat(16),
        token: TOKEN_B64,
      }),
    ]);
    expect(await api.joinMaterial()).toEqual({
      logKey: LOG_KEY_B64,
      relays: [{ url: 'https://r.example', tenantId: 'ab'.repeat(16), token: TOKEN_B64 }],
    });
    expect(calls[0].url).toBe('/api/mesh/relay/join-material');
  });

  test('材料不全直接报错，不静默拼一个解不开的 join 串', () => {
    expect(() => normalizeJoinMaterial({ logKey: LOG_KEY_B64, relays: [] })).toThrow(RelayApiError);
    expect(() =>
      normalizeJoinMaterial({
        logKey: LOG_KEY_B64,
        relays: [{ url: 'https://r.example', tenantId: 'nope', token: TOKEN_B64 }],
      })
    ).toThrow(RelayApiError);
    expect(() =>
      normalizeJoinMaterial({
        relays: [{ url: 'https://r.example', tenantId: 'ab'.repeat(16), token: TOKEN_B64 }],
      })
    ).toThrow(RelayApiError);
  });

  test('K_log 与令牌必须是 32 字节的 base64url：长度不对当场报错', () => {
    // 畸形值放行的话，要一路带到密封那一步才抛，那时 K_log 已经解出来在堆里了。
    expect(() =>
      normalizeJoinMaterial({
        logKey: 'aw',
        relays: [{ url: 'https://r.example', tenantId: 'ab'.repeat(16), token: TOKEN_B64 }],
      })
    ).toThrow(RelayApiError);
    expect(() =>
      normalizeJoinMaterial({
        logKey: LOG_KEY_B64,
        relays: [{ url: 'https://r.example', tenantId: 'ab'.repeat(16), token: 'dA' }],
      })
    ).toThrow(RelayApiError);
  });

  test('createEnrollment / getEnrollment 的路径', async () => {
    const { api, calls } = recorder([
      ok({ ok: true, id: 'enr-1', expiresAt: 1_700_000_600_000 }, 201),
      ok({ status: 'redeemed', enroll_pk: 'pk', certificate: 'c', cert_sig: 's' }),
    ]);
    const created = await api.createEnrollment({
      enroll_pk: 'pk',
      authorization: 'a',
      authorization_sig: 's',
      exp: 1_700_000_600_000,
    });
    expect(calls[0].url).toBe('/api/mesh/relay/enrollments');
    expect(created.id).toBe('enr-1');
    expect(created.expiresAt).toBe(1_700_000_600_000);
    const status = await api.getEnrollment('enr 1');
    expect(calls[1].url).toBe('/api/mesh/relay/enrollments/enr%201');
    expect(status.status).toBe('redeemed');
  });
});

describe('RelayTenantApi 密封包', () => {
  test('uploadPack 一次把逐台密封的包送到 /pack', async () => {
    const { api, calls } = recorder([ok({ ok: true, results: [] })]);
    const body = {
      packs: [
        { url: 'https://a.example', sealed_pack: 'AAAA' },
        { url: 'https://b.example', sealed_pack: 'CCCC' },
      ],
      kdf_params: { salt: 'BBBB', memory_kib: 65536, iterations: 3, parallelism: 1 },
      root_epoch: 2,
      head_seq: 7,
    };
    expect(await api.uploadPack(body)).toEqual({ ok: true, results: [] });
    expect(calls[0].url).toBe('/api/mesh/relay/pack');
    expect(calls[0].init?.method).toBe('POST');
    expect(bodyOf(calls[0])).toEqual(body);
  });

  test('一台中继都没转发成功时把 code 带出来', async () => {
    const { api } = recorder([fail(502, 'RELAY_PACK_FORWARD_FAILED')]);
    await expect(
      api.uploadPack({
        packs: [{ url: 'https://a.example', sealed_pack: 'AAAA' }],
        kdf_params: { salt: 'BBBB', memory_kib: 65536, iterations: 3, parallelism: 1 },
        root_epoch: 0,
        head_seq: '0',
      })
    ).rejects.toMatchObject({ code: 'RELAY_PACK_FORWARD_FAILED' });
  });
});
