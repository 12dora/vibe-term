import { describe, expect, test } from 'bun:test';
import { parseArgs } from '../lib/args';
import {
  formatTenantRows,
  mergeQuota,
  readQuotaFlags,
  runRelayKick,
  runRelayLabel,
  runRelayPasswd,
  runRelayQuota,
  runRelayRemove,
  runRelayStatus,
  runRelayTenants,
} from './relay-admin';
import { type RelayIo, relayErrorCode } from './relay-shared';

const ENV = { GATEWAY_PORT: '19993', TMEX_RELAY_ADMIN_TOKEN: 'admin-token' };

const STATUS = {
  config: {
    hasPassword: true,
    passwordEpoch: 3,
    minTokenEpoch: 2,
    defaultQuota: { maxNodes: 8, maxStreams: 32, bandwidthBytesPerSec: null },
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
    expect(logs).toContain('default quota: nodes=8 streams=32 bw=unlimited');
    expect(logs).toContain('tenants: 2');
    expect(logs).toContain('nodes: 2 online / 4 known');
    expect(logs).toContain('traffic: 2.0 KiB in / 4.0 KiB out');
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
    ).rejects.toThrow('TMEX_RELAY_ADMIN_TOKEN missing');
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
    expect(next).toEqual({ maxNodes: 16, maxStreams: 32, bandwidthBytesPerSec: null });
    expect(calls[1].url).toBe('http://127.0.0.1:19993/api/relay/config');
    expect(calls[1].method).toBe('PATCH');
    expect(calls[1].body).toEqual({
      defaultQuota: { maxNodes: 16, maxStreams: 32, bandwidthBytesPerSec: null },
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
      quota: { maxNodes: 4, maxStreams: 8, bandwidthBytesPerSec: 524_288 },
    });
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
  });

  test('mergeQuota falls back to the built-in defaults when nothing is known', () => {
    expect(mergeQuota(null, { maxStreams: 4 })).toEqual({
      maxNodes: 8,
      maxStreams: 4,
      bandwidthBytesPerSec: null,
    });
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
