import { describe, expect, test } from 'bun:test';
import { ApiClient } from './client';
import { fetchDomainAccess, updateDomainAccess } from './domain-access';

type Call = { url: string; init?: RequestInit };

function recorder(responses: Response[]): { client: ApiClient; calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;
  const client = new ApiClient('', (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(responses[index++] ?? new Response('{}', { status: 200 }));
  });
  return { client, calls };
}

const POLICY = {
  allowed: true,
  viaDomain: false,
  hosts: ['tmex.example.com'],
};

describe('fetchDomainAccess / updateDomainAccess', () => {
  test('GET /api/system/domain-access', async () => {
    const { client, calls } = recorder([new Response(JSON.stringify(POLICY), { status: 200 })]);
    expect(await fetchDomainAccess(client)).toEqual(POLICY);
    expect(calls[0]?.url).toBe('/api/system/domain-access');
  });

  test('PATCH /api/system/domain-access { allowed }', async () => {
    const updated = { ...POLICY, allowed: false };
    const { client, calls } = recorder([new Response(JSON.stringify(updated), { status: 200 })]);
    expect(await updateDomainAccess(false, client)).toEqual(updated);
    expect(calls[0]?.url).toBe('/api/system/domain-access');
    expect(calls[0]?.init?.method).toBe('PATCH');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ allowed: false }));
  });

  test('转发器的顶层信封（节点不可达）：503 { code, nodeId } 也要读出 code', async () => {
    const { client } = recorder([
      new Response(JSON.stringify({ code: 'NODE_UNREACHABLE', nodeId: 'n1' }), { status: 503 }),
    ]);
    const err = (await fetchDomainAccess(client).catch((e) => e)) as Error & { status: number };
    expect(err.message).toBe('NODE_UNREACHABLE');
    expect(err.status).toBe(503);
  });

  test('non-OK JSON error uses error.code', async () => {
    const { client } = recorder([
      new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), { status: 401 }),
    ]);
    const err = (await fetchDomainAccess(client).catch((e) => e)) as Error & { status: number };
    expect(err.message).toBe('UNAUTHORIZED');
    expect(err.status).toBe(401);
  });

  test('403 DOMAIN_ACCESS_DISABLED surfaces error.code', async () => {
    const { client } = recorder([
      new Response(
        JSON.stringify({
          error: {
            code: 'DOMAIN_ACCESS_DISABLED',
            message: 'Access through this domain is disabled for this node.',
          },
        }),
        { status: 403 }
      ),
    ]);
    const err = (await fetchDomainAccess(client).catch((e) => e)) as Error & { status: number };
    expect(err.message).toBe('DOMAIN_ACCESS_DISABLED');
    expect(err.status).toBe(403);
  });
});
