import { describe, expect, test } from 'bun:test';
import { ApiClient } from '../client';
import {
  RELAY_QUOTA_LIMITS,
  RelayAdminApi,
  RelayApiError,
  type RelayQuota,
  type RelayStatusResponse,
  isRelayNotEnabled,
  isRelayUnauthorized,
} from './admin-api';
import type { RelayMetricsResponse } from './metrics-types';

type Call = { url: string; init?: RequestInit };

function recorder(responses: Response[]): { api: RelayAdminApi; calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;
  const client = new ApiClient('', (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(responses[index++] ?? new Response('{}', { status: 200 }));
  });
  return { api: new RelayAdminApi(client), calls };
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

const DEFAULT_QUOTA: RelayQuota = {
  maxNodes: 8,
  maxStreams: 16,
  bandwidthBytesPerSec: 524_288,
};

const STATUS: RelayStatusResponse = {
  config: {
    hasPassword: true,
    passwordEpoch: 3,
    minTokenEpoch: 2,
    defaultQuota: DEFAULT_QUOTA,
  },
  tenants: [
    {
      id: '0123456789abcdef0123456789abcdef',
      label: '上海',
      createdAt: 1_700_000_000_000,
      lastSeenAt: 1_700_000_600_000,
      nodes: 3,
      nodesRevoked: 0,
      nodesOnline: 2,
      streams: 4,
      bytesIn: 1024,
      bytesOut: 2048,
      quota: null,
      tokenEpoch: 3,
      kicked: false,
    },
  ],
  totals: { tenants: 1, nodes: 3, nodesOnline: 2, streams: 4, bytesIn: 1024, bytesOut: 2048 },
};

describe('RelayAdminApi 读接口', () => {
  test('GET /api/relay/status 原样返回', async () => {
    const { api, calls } = recorder([ok(STATUS)]);
    expect(await api.status()).toEqual(STATUS);
    expect(calls[0]?.url).toBe('/api/relay/status');
    expect(calls[0]?.init).toBeUndefined();
  });

  test('GET /api/relay/health', async () => {
    const health = { ok: true, version: '1.1.23', tenants: 1, nodesOnline: 2, uptimeMs: 60_000 };
    const { api, calls } = recorder([ok(health)]);
    expect(await api.health()).toEqual(health);
    expect(calls[0]?.url).toBe('/api/relay/health');
  });

  test('GET /api/relay/metrics 原样返回，members:false 带 query 且类型不含 members', async () => {
    const metrics: RelayMetricsResponse = {
      schemaVersion: 1,
      sampledAt: 1,
      intervalMs: 5000,
      uptimeMs: 10,
      version: '1.1.23',
      process: {
        memory: { rssBytes: 1, heapTotalBytes: 1, heapUsedBytes: 1, externalBytes: 0 },
        cpu: { utilizationPct: null },
        loadAvg: null,
        eventLoop: { lagMs: 0, maxLagMs: 0 },
        openSockets: 0,
        authenticatedLinks: 0,
      },
      totals: {
        tenants: 0,
        members: 0,
        membersOnline: 0,
        activeStreams: 0,
        bytesIn: 0,
        bytesOut: 0,
        bytesInPerSec: 0,
        bytesOutPerSec: 0,
        framesInPerSec: 0,
        framesOutPerSec: 0,
        bandwidthBytesPerSec: 0,
      },
      tenants: [],
      members: [],
      history: { intervalMs: 5000, samples: [] },
    };
    const { members: _members, ...withoutMembers } = metrics;
    const { api, calls } = recorder([ok(metrics), ok(withoutMembers)]);
    expect(await api.metrics()).toEqual(metrics);
    expect(calls[0]?.url).toBe('/api/relay/metrics');
    const slim = await api.metrics({ members: false });
    expect(calls[1]?.url).toBe('/api/relay/metrics?members=0');
    expect('members' in slim).toBe(false);
    expectSlimMetrics(slim);
  });
});

function expectSlimMetrics<T>(value: 'members' extends keyof T ? never : T): T {
  return value;
}

describe('RelayAdminApi 写接口', () => {
  test('POST /api/relay/password 带 mode', async () => {
    const { api, calls } = recorder([new Response(null, { status: 204 })]);
    await api.setPassword({ password: 'hunter22', mode: 'kick' });
    expect(calls[0]?.url).toBe('/api/relay/password');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ password: 'hunter22', mode: 'kick' }));
  });

  test('force 传给改密与踢租户请求', async () => {
    const { api, calls } = recorder([ok({ ok: true }), ok({ ok: true })]);
    await api.setPassword({ password: 'hunter22', mode: 'kick', force: true });
    await api.kickTenant('t1', { force: true });
    expect(JSON.parse(calls[0]?.init?.body as string).force).toBe(true);
    expect(JSON.parse(calls[1]?.init?.body as string)).toEqual({ force: true });
  });

  test('清除口令：password 为 null 且照样带 mode', async () => {
    const { api, calls } = recorder([ok({ ok: true })]);
    await api.setPassword({ password: null, mode: 'keep' });
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ password: null, mode: 'keep' }));
  });

  test('PATCH /api/relay/config 把配额包进 defaultQuota', async () => {
    const { api, calls } = recorder([ok({ ok: true })]);
    await api.updateDefaultQuota({ ...DEFAULT_QUOTA, bandwidthBytesPerSec: null });
    expect(calls[0]?.url).toBe('/api/relay/config');
    expect(calls[0]?.init?.method).toBe('PATCH');
    expect(calls[0]?.init?.body).toBe(
      JSON.stringify({ defaultQuota: { maxNodes: 8, maxStreams: 16, bandwidthBytesPerSec: null } })
    );
  });

  test('PATCH /api/relay/config 把中继限额包进 limits', async () => {
    const { api, calls } = recorder([ok({ ok: true })]);
    await api.updateLimits({
      maxTenants: 4,
      totalBandwidthBytesPerSec: 1024,
      fairShare: false,
    });
    expect(calls[0]?.url).toBe('/api/relay/config');
    expect(calls[0]?.init?.method).toBe('PATCH');
    expect(calls[0]?.init?.body).toBe(
      JSON.stringify({
        limits: { maxTenants: 4, totalBandwidthBytesPerSec: 1024, fairShare: false },
      })
    );
  });

  test('RELAY_QUOTA_LIMITS 与服务端 relay-quota.ts 的硬上限一致', () => {
    expect(RELAY_QUOTA_LIMITS.maxNodes).toBe(256);
    expect(RELAY_QUOTA_LIMITS.maxStreams).toBe(65_536);
    expect(RELAY_QUOTA_LIMITS.bandwidthBytesPerSec).toBe(10 * 1024 * 1024 * 1024);
    expect(RELAY_QUOTA_LIMITS.maxFileBytes).toBe(1024 * 1024 * 1024 * 1024);
  });

  test('PATCH /api/relay/tenants/:id 只发传入的字段', async () => {
    const { api, calls } = recorder([ok({ ok: true })]);
    await api.updateTenant('abc', { quota: null });
    expect(calls[0]?.url).toBe('/api/relay/tenants/abc');
    expect(calls[0]?.init?.method).toBe('PATCH');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ quota: null }));
  });

  test('租户编号进路径前做百分号编码', async () => {
    const { api, calls } = recorder([ok({ ok: true }), ok({ ok: true })]);
    await api.kickTenant('a/b');
    expect(calls[0]?.url).toBe('/api/relay/tenants/a%2Fb/kick');
    expect(calls[0]?.init?.method).toBe('POST');
    await api.deleteTenant('a b');
    expect(calls[1]?.url).toBe('/api/relay/tenants/a%20b');
    expect(calls[1]?.init?.method).toBe('DELETE');
  });

  test('POST kick 与 DELETE 不带请求体', async () => {
    const { api, calls } = recorder([ok({ ok: true }), ok({ ok: true })]);
    await api.kickTenant('t1');
    await api.deleteTenant('t1');
    expect(calls[0]?.init?.body).toBeUndefined();
    expect(calls[1]?.init?.body).toBeUndefined();
  });
});

describe('RelayAdminApi 错误', () => {
  test('契约错误体解出 code / message / status', async () => {
    const { api } = recorder([
      new Response(JSON.stringify({ error: { code: 'RELAY_TENANT_UNKNOWN', message: 'no' } }), {
        status: 409,
      }),
    ]);
    const err = (await api.kickTenant('t1').catch((e) => e)) as RelayApiError;
    expect(err).toBeInstanceOf(RelayApiError);
    expect(err.code).toBe('RELAY_TENANT_UNKNOWN');
    expect(err.message).toBe('no');
    expect(err.status).toBe(409);
  });

  test('离线成员错误保留人数供界面确认', async () => {
    const { api } = recorder([
      new Response(
        JSON.stringify({
          error: {
            code: 'relay_members_offline',
            message: 'relay_members_offline',
            online: 1,
            admitted: 3,
          },
        }),
        { status: 409 }
      ),
    ]);
    const error = await api.kickTenant('t1').catch((error) => error);
    expect(error).toBeInstanceOf(RelayApiError);
    expect(error.details).toEqual({ online: 1, admitted: 3 });
  });

  test('非 JSON 错误体退回 fallback code', async () => {
    const { api } = recorder([new Response('nope', { status: 500 })]);
    const err = (await api.status().catch((e) => e)) as RelayApiError;
    expect(err.code).toBe('relay_status_failed');
    expect(err.status).toBe(500);
  });

  test('404 即角色缺席，`isRelayNotEnabled` 认得出来', async () => {
    const { api } = recorder([new Response('{}', { status: 404 })]);
    const err = await api.status().catch((e) => e);
    expect(isRelayNotEnabled(err)).toBe(true);
    expect(isRelayUnauthorized(err)).toBe(false);
  });

  test('401 是未登录，不是角色缺席', async () => {
    const { api } = recorder([
      new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), { status: 401 }),
    ]);
    const err = await api.status().catch((e) => e);
    expect(isRelayUnauthorized(err)).toBe(true);
    expect(isRelayNotEnabled(err)).toBe(false);
  });

  test('两个判定函数对非 RelayApiError 一律 false', () => {
    expect(isRelayNotEnabled(new Error('boom'))).toBe(false);
    expect(isRelayUnauthorized(null)).toBe(false);
  });
});
