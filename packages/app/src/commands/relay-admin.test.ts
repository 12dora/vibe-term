import { describe, expect, test } from 'bun:test';
import { parseArgs } from '../lib/args';
import {
  formatTenantRows,
  formatTurnStatus,
  mergeLimits,
  mergeQuota,
  readLimitsFlags,
  readQuotaFlags,
  runRelayKick,
  runRelayLabel,
  runRelayLimits,
  runRelayMetrics,
  runRelayPasswd,
  runRelayQuota,
  runRelayRemove,
  runRelayStatus,
  runRelayTenants,
} from './relay-admin';
import { type RelayIo, relayErrorCode } from './relay-shared';

const ENV = { GATEWAY_PORT: '19993', VIBETERM_RELAY_ADMIN_TOKEN: 'admin-token' };

const STATUS = {
  config: {
    hasPassword: true,
    passwordEpoch: 3,
    minTokenEpoch: 2,
    defaultQuota: { maxNodes: 8, maxStreams: 32, bandwidthBytesPerSec: null },
    limits: { maxTenants: 4, totalBandwidthBytesPerSec: 1_048_576, fairShare: false },
  },
  tenants: [
    {
      id: 'a'.repeat(32),
      label: 'alice',
      createdAt: 1_700_000_000_000,
      lastSeenAt: 1_700_000_100_000,
      nodes: 3,
      nodesOnline: 2,
      streams: 1,
      bytesIn: 2048,
      bytesOut: 4096,
      quota: { maxNodes: 4, maxStreams: 8, bandwidthBytesPerSec: 262_144 },
      tokenEpoch: 3,
      kicked: false,
    },
    {
      id: 'b'.repeat(32),
      label: null,
      createdAt: 1_700_000_000_000,
      lastSeenAt: null,
      nodes: 1,
      nodesOnline: 0,
      streams: 0,
      bytesIn: 0,
      bytesOut: 0,
      quota: null,
      tokenEpoch: 1,
      kicked: true,
    },
  ],
  totals: { tenants: 2 },
  turn: {
    enabled: true,
    source: 'builtin',
    url: 'turn:relay.example:40000?transport=udp',
    port: 40000,
    externalIp: '203.0.113.9',
    listening: true,
    allocations: 3,
    error: null,
    relayPortRange: '40001-40049',
  },
};

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function recorder(responses?: Record<string, unknown>) {
  const calls: Call[] = [];
  const logs: string[] = [];
  const fetcher = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const headers = { ...((init?.headers as Record<string, string>) ?? {}) };
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const path = new URL(url).pathname;
    const payload = responses?.[`${init?.method ?? 'GET'} ${path}`] ?? responses?.[path] ?? {};
    if (payload instanceof Response) return payload.clone();
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  const io: RelayIo = { env: ENV, fetcher, log: (line) => logs.push(line) };
  return { calls, logs, io };
}

const STATUS_RESPONSES = { '/api/relay/status': STATUS };

describe('relay status / tenants', () => {
  test('status reads GET /api/relay/status with a bearer admin token', async () => {
    const { calls, logs, io } = recorder(STATUS_RESPONSES);
    await runRelayStatus(parseArgs(['relay', 'status']), io);
    expect(calls[0].url).toBe('http://127.0.0.1:19993/api/relay/status');
    expect(calls[0].method).toBe('GET');
    expect(calls[0].headers.authorization).toBe('Bearer admin-token');
    expect(logs).toContain('password: set');
    expect(logs).toContain('password epoch: 3 (min token epoch 2)');
    expect(logs).toContain('default quota: nodes=8 streams=32 bw=unlimited file=unlimited');
    expect(logs).toContain('tenants: 2');
    expect(logs).toContain('nodes: 2 online / 4 known');
    expect(logs).toContain('traffic: 2.0 KiB in / 4.0 KiB out');
    expect(logs).toContain(
      'turn: builtin enabled listening url=turn:relay.example:40000?transport=udp port=40000 external_ip=203.0.113.9 relay_range=40001-40049 allocations=3'
    );
  });

  test('formatTurnStatus covers off / error', () => {
    expect(formatTurnStatus(null)).toBe('turn: off');
    expect(formatTurnStatus({ source: 'off', enabled: false })).toBe('turn: off');
    expect(formatTurnStatus({ source: 'builtin', error: 'EADDRINUSE: address in use' })).toBe(
      'turn: builtin error=EADDRINUSE: address in use'
    );
  });

  test('--json prints the raw body', async () => {
    const { logs, io } = recorder(STATUS_RESPONSES);
    await runRelayStatus(parseArgs(['relay', 'status', '--json']), io);
    expect(JSON.parse(logs.join('\n'))).toEqual(STATUS);
  });

  test('tenants prints one padded row per tenant', async () => {
    const { logs, io } = recorder(STATUS_RESPONSES);
    await runRelayTenants(parseArgs(['relay', 'tenants']), io);
    expect(logs[0]).toContain('TENANT');
    expect(logs[1]).toContain('alice');
    expect(logs[1]).toContain('2/3');
    expect(logs[1]).toContain('nodes=4 streams=8 bw=256 KB/s');
    expect(logs[2]).toContain('inherit');
    expect(logs[2]).toContain('kicked');
  });

  test('formatTenantRows says so when there are none', () => {
    expect(formatTenantRows([])).toEqual(['no tenants']);
  });

  test('missing admin token is a clear error', async () => {
    const { io } = recorder(STATUS_RESPONSES);
    await expect(
      runRelayStatus(parseArgs(['relay', 'status']), { ...io, env: { GATEWAY_PORT: '19993' } })
    ).rejects.toThrow('VIBETERM_RELAY_ADMIN_TOKEN missing');
  });
});

const METRICS = {
  schemaVersion: 1,
  sampledAt: 1_700_000_000_000,
  intervalMs: 5_000,
  uptimeMs: 3_600_000,
  version: '2.3.5',
  process: {
    memory: {
      rssBytes: 80 * 1024 * 1024,
      heapTotalBytes: 64 * 1024 * 1024,
      heapUsedBytes: 40 * 1024 * 1024,
      externalBytes: 0,
    },
    cpu: { utilizationPct: 3.2 },
    eventLoop: { lagMs: 1.2, maxLagMs: 4 },
  },
  totals: {
    tenants: 2,
    members: 8,
    membersOnline: 5,
    activeStreams: 3,
    bytesIn: 10 * 1024 * 1024,
    bytesOut: 20 * 1024 * 1024,
    bytesInPerSec: 1024,
    bytesOutPerSec: 2048,
  },
  members: [
    {
      tenantId: 'a'.repeat(32),
      nodeId: 'c'.repeat(32),
      name: 'edge',
      online: true,
      rttMs: 12.5,
      activeStreams: 1,
      bytesInPerSec: 100,
      bytesOutPerSec: 200,
    },
  ],
};

describe('relay metrics', () => {
  test('omits members by default (?members=0)', async () => {
    const slim = { ...METRICS };
    delete (slim as { members?: unknown }).members;
    const { calls, logs, io } = recorder({ '/api/relay/metrics': slim });
    await runRelayMetrics(parseArgs(['relay', 'metrics']), io);
    expect(calls[0].url).toBe('http://127.0.0.1:19993/api/relay/metrics?members=0');
    expect(logs.some((line) => line.startsWith('version: 2.3.5'))).toBe(true);
    expect(logs.some((line) => line.includes('members: 5 online / 8'))).toBe(true);
    expect(logs.some((line) => line.includes('TENANT'))).toBe(false);
  });

  test('--members requests members=1 and prints the table', async () => {
    const { calls, logs, io } = recorder({ '/api/relay/metrics': METRICS });
    await runRelayMetrics(parseArgs(['relay', 'metrics', '--members']), io);
    expect(calls[0].url).toBe('http://127.0.0.1:19993/api/relay/metrics?members=1');
    expect(calls[0].headers.authorization).toBe('Bearer admin-token');
    expect(logs.some((line) => line.includes('edge'))).toBe(true);
    expect(logs.some((line) => line.includes('online'))).toBe(true);
  });

  test('--json prints the raw body', async () => {
    const { logs, io } = recorder({ '/api/relay/metrics': METRICS });
    await runRelayMetrics(parseArgs(['relay', 'metrics', '--json', '--members']), io);
    expect(JSON.parse(logs.join('\n'))).toEqual(METRICS);
  });
});

describe('relay passwd', () => {
  test('keep is the default and posts the new password', async () => {
    const { calls, logs, io } = recorder({ 'POST /api/relay/password': { passwordEpoch: 4 } });
    const result = await runRelayPasswd(parseArgs(['relay', 'passwd']), {
      ...io,
      newRelayPassword: 'hunter2hunter2',
    });
    expect(result).toEqual({ mode: 'keep', cleared: false, passwordEpoch: 4 });
    expect(calls[0].url).toBe('http://127.0.0.1:19993/api/relay/password');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({ password: 'hunter2hunter2', mode: 'keep' });
    expect(logs[0]).toContain('keep mode');
  });

  test('--kick switches the mode and explains it before asking', async () => {
    const { calls, logs, io } = recorder({ 'POST /api/relay/password': { passwordEpoch: 5 } });
    await runRelayPasswd(parseArgs(['relay', 'passwd', '--kick']), {
      ...io,
      newRelayPassword: 'hunter2hunter2',
    });
    expect(calls[0].body).toEqual({ password: 'hunter2hunter2', mode: 'kick' });
    expect(logs[0]).toContain('kick mode');
  });

  test('offline-member refusal prints counts and recovery commands, without reporting success', async () => {
    const { calls, logs, io } = recorder({
      'POST /api/relay/password': new Response(
        JSON.stringify({
          error: {
            code: 'relay_members_offline',
            online: 2,
            admitted: 4,
          },
        }),
        { status: 409 }
      ),
    });
    await expect(
      runRelayPasswd(parseArgs(['relay', 'passwd', '--kick']), {
        ...io,
        newRelayPassword: 'new-password',
      })
    ).rejects.toThrow('--force');
    expect(calls).toHaveLength(1);
    expect(logs.join('\n')).toContain('2 online / 4 admitted');
    expect(logs.join('\n')).toContain('vibeterm relay reauth <url>');
    expect(logs.join('\n')).toContain('vibeterm relay join <url> --tenant <id> --password');
    expect(logs.join('\n')).not.toContain('updated');
  });

  test('--force is forwarded for kick-mode password changes', async () => {
    const { calls, io } = recorder({ 'POST /api/relay/password': { passwordEpoch: 5 } });
    await runRelayPasswd(parseArgs(['relay', 'passwd', '--kick', '--force']), {
      ...io,
      newRelayPassword: 'new-password',
    });
    expect(calls[0].body).toEqual({ password: 'new-password', mode: 'kick', force: true });
  });

  test('--clear sends a null password without prompting', async () => {
    const { calls, logs, io } = recorder({ 'POST /api/relay/password': { passwordEpoch: 6 } });
    const result = await runRelayPasswd(parseArgs(['relay', 'passwd', '--clear']), io);
    expect(calls[0].body).toEqual({ password: null, mode: 'keep' });
    expect(result.cleared).toBe(true);
    expect(logs.at(-1)).toContain('cleared');
  });

  test('--kick with --keep is rejected', async () => {
    const { io } = recorder();
    await expect(
      runRelayPasswd(parseArgs(['relay', 'passwd', '--kick', '--keep']), io)
    ).rejects.toThrow('either --kick or --keep');
  });
});

describe('relay kick / remove / label', () => {
  const tenantId = 'c'.repeat(32);

  test('kick posts to the tenant kick route', async () => {
    const { calls, io } = recorder();
    await runRelayKick(parseArgs(['relay', 'kick', tenantId]), tenantId, io);
    expect(calls[0].url).toBe(`http://127.0.0.1:19993/api/relay/tenants/${tenantId}/kick`);
    expect(calls[0].method).toBe('POST');
  });

  test('kick reports offline counts and requires --force', async () => {
    const { calls, logs, io } = recorder({
      [`POST /api/relay/tenants/${tenantId}/kick`]: new Response(
        JSON.stringify({
          error: {
            code: 'relay_members_offline',
            online: 0,
            admitted: 2,
          },
        }),
        { status: 409 }
      ),
    });
    await expect(
      runRelayKick(parseArgs(['relay', 'kick', tenantId]), tenantId, io)
    ).rejects.toThrow('--force');
    expect(calls).toHaveLength(1);
    expect(logs.join('\n')).toContain('0 online / 2 admitted');
    expect(logs.join('\n')).toContain('vibeterm relay reauth <url>');
    expect(logs.join('\n')).toContain('vibeterm relay join <url> --tenant <id> --password');
    expect(logs.join('\n')).not.toContain('kicked');
  });

  test('kick forwards --force', async () => {
    const { calls, io } = recorder();
    await runRelayKick(parseArgs(['relay', 'kick', tenantId, '--force']), tenantId, io);
    expect(calls[0].body).toEqual({ force: true });
  });

  test('kick rejects a malformed tenant id', async () => {
    const { io } = recorder();
    await expect(runRelayKick(parseArgs(['relay', 'kick', 'nope']), 'nope', io)).rejects.toThrow(
      '32 hex characters'
    );
  });

  test('remove asks for confirmation and does nothing when declined', async () => {
    const { calls, io } = recorder();
    const result = await runRelayRemove(parseArgs(['relay', 'remove', tenantId]), tenantId, {
      ...io,
      confirm: () => false,
    });
    expect(result).toEqual({ removed: false });
    expect(calls).toHaveLength(0);
  });

  test('remove issues DELETE once confirmed', async () => {
    const { calls, io } = recorder();
    await runRelayRemove(parseArgs(['relay', 'remove', tenantId, '--yes']), tenantId, io);
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].url).toBe(`http://127.0.0.1:19993/api/relay/tenants/${tenantId}`);
  });

  test('label patches the tenant, and an empty text clears it', async () => {
    const { calls, io } = recorder();
    await runRelayLabel(parseArgs(['relay', 'label']), [tenantId, 'build', 'box'], io);
    expect(calls[0].method).toBe('PATCH');
    expect(calls[0].body).toEqual({ label: 'build box' });
    await runRelayLabel(parseArgs(['relay', 'label']), [tenantId], io);
    expect(calls[1].body).toEqual({ label: null });
  });
});

describe('relay quota', () => {
  const tenantId = 'a'.repeat(32);

  test('default target patches /api/relay/config keeping unspecified fields', async () => {
    const { calls, io } = recorder(STATUS_RESPONSES);
    const next = await runRelayQuota(
      parseArgs(['relay', 'quota', 'default', '--max-nodes', '16']),
      'default',
      io
    );
    expect(next).toEqual({
      maxNodes: 16,
      maxStreams: 32,
      bandwidthBytesPerSec: null,
      maxFileBytes: null,
    });
    expect(calls[1].url).toBe('http://127.0.0.1:19993/api/relay/config');
    expect(calls[1].method).toBe('PATCH');
    expect(calls[1].body).toEqual({
      defaultQuota: {
        maxNodes: 16,
        maxStreams: 32,
        bandwidthBytesPerSec: null,
        maxFileBytes: null,
      },
    });
  });

  test('tenant target merges onto the tenant override and converts KB/s', async () => {
    const { calls, io } = recorder(STATUS_RESPONSES);
    await runRelayQuota(
      parseArgs(['relay', 'quota', tenantId, '--bandwidth', '512']),
      tenantId,
      io
    );
    expect(calls[1].url).toBe(`http://127.0.0.1:19993/api/relay/tenants/${tenantId}`);
    expect(calls[1].body).toEqual({
      quota: { maxNodes: 4, maxStreams: 8, bandwidthBytesPerSec: 524_288, maxFileBytes: null },
    });
  });

  test('--max-file-mb 折算成字节，none 表示不限', async () => {
    const { calls, io } = recorder(STATUS_RESPONSES);
    await runRelayQuota(
      parseArgs(['relay', 'quota', tenantId, '--max-file-mb', '100']),
      tenantId,
      io
    );
    expect((calls[1].body as { quota: { maxFileBytes: number } }).quota.maxFileBytes).toBe(
      100 * 1024 * 1024
    );
    await runRelayQuota(
      parseArgs(['relay', 'quota', tenantId, '--max-file-mb', 'none']),
      tenantId,
      io
    );
    expect((calls[3].body as { quota: { maxFileBytes: number | null } }).quota.maxFileBytes).toBe(
      null
    );
  });

  test('--inherit clears the tenant override', async () => {
    const { calls, io } = recorder(STATUS_RESPONSES);
    const next = await runRelayQuota(
      parseArgs(['relay', 'quota', tenantId, '--inherit']),
      tenantId,
      io
    );
    expect(next).toBeNull();
    expect(calls[1].body).toEqual({ quota: null });
  });

  test('--inherit is refused for the relay default', async () => {
    const { io } = recorder(STATUS_RESPONSES);
    await expect(
      runRelayQuota(parseArgs(['relay', 'quota', 'default', '--inherit']), 'default', io)
    ).rejects.toThrow('--inherit applies to a tenant');
  });

  test('no quota flag at all is refused', async () => {
    const { io } = recorder(STATUS_RESPONSES);
    await expect(
      runRelayQuota(parseArgs(['relay', 'quota', 'default']), 'default', io)
    ).rejects.toThrow('requires --max-nodes');
  });

  test('unknown tenant is refused before the PATCH', async () => {
    const { calls, io } = recorder(STATUS_RESPONSES);
    const missing = 'f'.repeat(32);
    await expect(
      runRelayQuota(parseArgs(['relay', 'quota', missing, '--max-nodes', '2']), missing, io)
    ).rejects.toThrow('unknown tenant');
    expect(calls).toHaveLength(1);
  });

  test('flag parsing rejects nonsense and understands unlimited', () => {
    expect(
      readQuotaFlags(parseArgs(['relay', 'quota', 'default', '--bandwidth', 'unlimited']))
    ).toEqual({ bandwidthBytesPerSec: null });
    expect(() => readQuotaFlags(parseArgs(['relay', 'quota', 'x', '--max-nodes', 'many']))).toThrow(
      'invalid --max-nodes'
    );
    expect(() => readQuotaFlags(parseArgs(['relay', 'quota', 'x', '--bandwidth', 'fast']))).toThrow(
      'invalid --bandwidth'
    );
    expect(() =>
      readQuotaFlags(parseArgs(['relay', 'quota', 'x', '--max-file-mb', 'big']))
    ).toThrow('invalid --max-file-mb');
  });

  test('缺值的配额旗标先报用法错，不发任何请求', async () => {
    const { calls, io } = recorder(STATUS_RESPONSES);
    await expect(
      runRelayQuota(parseArgs(['relay', 'quota', tenantId, '--max-file-mb']), tenantId, io)
    ).rejects.toThrow('--max-file-mb');
    await expect(
      runRelayQuota(
        parseArgs(['relay', 'quota', tenantId, '--max-file-mb', '--max-nodes', '2']),
        tenantId,
        io
      )
    ).rejects.toThrow('--max-file-mb');
    await expect(
      runRelayQuota(parseArgs(['relay', 'quota', tenantId, '--bandwidth=']), tenantId, io)
    ).rejects.toThrow('--bandwidth');
    await expect(
      runRelayQuota(parseArgs(['relay', 'quota', tenantId, '--max-streams=  ']), tenantId, io)
    ).rejects.toThrow('--max-streams');
    expect(calls).toHaveLength(0);
    expect(() => readQuotaFlags(parseArgs(['relay', 'quota', 'x', '--max-nodes']))).toThrow(
      '--max-nodes'
    );
  });

  test('mergeQuota falls back to the built-in defaults when nothing is known', () => {
    expect(mergeQuota(null, { maxStreams: 4 })).toEqual({
      maxNodes: 8,
      maxStreams: 4,
      bandwidthBytesPerSec: null,
      maxFileBytes: null,
    });
  });
});

describe('relay limits', () => {
  test('no flag: only reads and prints the current limits', async () => {
    const { calls, logs, io } = recorder(STATUS_RESPONSES);
    const limits = await runRelayLimits(parseArgs(['relay', 'limits']), io);
    expect(limits).toEqual({
      maxTenants: 4,
      totalBandwidthBytesPerSec: 1_048_576,
      fairShare: false,
    });
    expect(calls).toHaveLength(1);
    expect(logs).toContain('relay limits: tenants=4 bw=1024 KB/s fair-share=off');
  });

  test('patches /api/relay/config keeping unspecified fields', async () => {
    const { calls, io } = recorder(STATUS_RESPONSES);
    const next = await runRelayLimits(
      parseArgs(['relay', 'limits', '--max-tenants', 'none', '--fair-share', 'on']),
      io
    );
    expect(next).toEqual({
      maxTenants: null,
      totalBandwidthBytesPerSec: 1_048_576,
      fairShare: true,
    });
    expect(calls[1].url).toBe('http://127.0.0.1:19993/api/relay/config');
    expect(calls[1].method).toBe('PATCH');
    expect(calls[1].body).toEqual({
      limits: { maxTenants: null, totalBandwidthBytesPerSec: 1_048_576, fairShare: true },
    });
  });

  test('flag parsing rejects nonsense', () => {
    expect(() => readLimitsFlags(parseArgs(['relay', 'limits', '--max-tenants', 'many']))).toThrow(
      'invalid --max-tenants'
    );
    expect(() =>
      readLimitsFlags(parseArgs(['relay', 'limits', '--total-bandwidth-kb', 'fast']))
    ).toThrow('invalid --total-bandwidth-kb');
    expect(() => readLimitsFlags(parseArgs(['relay', 'limits', '--fair-share', 'maybe']))).toThrow(
      'invalid --fair-share'
    );
    expect(readLimitsFlags(parseArgs(['relay', 'limits', '--total-bandwidth-kb', 'none']))).toEqual(
      { totalBandwidthBytesPerSec: null }
    );
  });

  test('缺值的限额旗标先报用法错，不发任何请求', async () => {
    const { calls, io } = recorder(STATUS_RESPONSES);
    await expect(
      runRelayLimits(parseArgs(['relay', 'limits', '--max-tenants']), io)
    ).rejects.toThrow('--max-tenants');
    // 与另一个有效旗标同时给：不能只应用有效的那个还报成功。
    await expect(
      runRelayLimits(parseArgs(['relay', 'limits', '--max-tenants', '--fair-share', 'off']), io)
    ).rejects.toThrow('--max-tenants');
    await expect(
      runRelayLimits(parseArgs(['relay', 'limits', '--max-tenants=']), io)
    ).rejects.toThrow('--max-tenants');
    await expect(
      runRelayLimits(parseArgs(['relay', 'limits', '--total-bandwidth-kb=  ']), io)
    ).rejects.toThrow('--total-bandwidth-kb');
    await expect(
      runRelayLimits(parseArgs(['relay', 'limits', '--fair-share']), io)
    ).rejects.toThrow('--fair-share');
    expect(calls).toHaveLength(0);
  });

  test('mergeLimits only overwrites the fields that were given', () => {
    const base = { maxTenants: 2, totalBandwidthBytesPerSec: 1024, fairShare: true };
    expect(mergeLimits(base, {})).toEqual(base);
    expect(mergeLimits(base, { fairShare: false })).toEqual({ ...base, fairShare: false });
    expect(mergeLimits(base, { maxTenants: null })).toEqual({ ...base, maxTenants: null });
  });
});

describe('error contract', () => {
  test('the shared error envelope is unwrapped into a code', async () => {
    const fetcher = (async () =>
      new Response(JSON.stringify({ error: { code: 'RELAY_UNAUTHORIZED', message: 'no' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    await expect(
      runRelayStatus(parseArgs(['relay', 'status']), { env: ENV, fetcher })
    ).rejects.toThrow('relay status failed: HTTP 401 RELAY_UNAUTHORIZED');
  });

  test('a legacy flat error body and a non-JSON body still produce a code', () => {
    expect(relayErrorCode({ error: 'FLAT' }, 400)).toBe('FLAT');
    expect(relayErrorCode({ code: 'FROM_CODE' }, 400)).toBe('FROM_CODE');
    expect(relayErrorCode({ raw: '<html>' }, 502)).toBe('HTTP_502');
  });
});
