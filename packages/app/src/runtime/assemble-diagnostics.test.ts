import { describe, expect, test } from 'bun:test';
import type { LocalAuthContext } from '../lib/local-auth';
import { withRuntimeDiagnostics } from './assemble-diagnostics';
import type { AssembledFetch } from './assemble-routes';

function server(address: string): Parameters<AssembledFetch>[1] {
  return { requestIP: () => ({ address }) } as unknown as Parameters<AssembledFetch>[1];
}

const dispatch = withRuntimeDiagnostics(async () => undefined, {} as LocalAuthContext, null, null);

describe('keylog status diagnostics', () => {
  test('requires a direct loopback client', async () => {
    const cases: Array<[string, Record<string, string>, string]> = [
      ['http://localhost/api/mesh/keylog/status', {}, '203.0.113.10'],
      [
        'http://localhost/api/mesh/keylog/status',
        { 'x-forwarded-for': '198.51.100.7' },
        '127.0.0.1',
      ],
      ['http://localhost/api/mesh/keylog/status', { 'x-forwarded-proto': 'https' }, '127.0.0.1'],
      ['http://rebind.example.com/api/mesh/keylog/status', {}, '127.0.0.1'],
    ];
    for (const [url, headers, address] of cases) {
      const res = await dispatch(new Request(url, { headers }), server(address));
      expect(res?.status).toBe(403);
      expect(await res?.json()).toEqual({ error: { code: 'LOOPBACK_REQUIRED' } });
    }
  });

  test('a loopback client reaches the method check', async () => {
    const res = await dispatch(
      new Request('http://127.0.0.1/api/mesh/keylog/status', { method: 'POST' }),
      server('127.0.0.1')
    );
    expect(res?.status).toBe(405);
  });
});
