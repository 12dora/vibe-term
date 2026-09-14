import { describe, expect, test } from 'bun:test';
import { ApiClient } from '@vibeterm/api-client';
import { EnrollmentApiError, RelayEnrollmentApi } from './enrollment-api';

function client(handler: (path: string, init?: RequestInit) => Response): {
  api: RelayEnrollmentApi;
  calls: Array<{ path: string; init?: RequestInit }>;
} {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const transport = async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    return handler(path, init);
  };
  return { api: new RelayEnrollmentApi(new ApiClient('', transport)), calls };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('RelayEnrollmentApi', () => {
  test('createEnrollment 打 /api/mesh/relay/enrollments', async () => {
    const { api, calls } = client(() =>
      json(201, { ok: true, id: 'e-1', expiresAt: 1_700_000_060_000, relays: [] })
    );
    const created = await api.createEnrollment({
      enroll_pk: 'pk',
      authorization: 'auth',
      authorization_sig: 'sig',
      exp: 1_700_000_060_000,
    });
    expect(created.id).toBe('e-1');
    expect(created.expires_at).toBe(1_700_000_060_000);
    expect(calls[0]?.path).toBe('/api/mesh/relay/enrollments');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      enroll_pk: 'pk',
      authorization: 'auth',
      authorization_sig: 'sig',
      exp: 1_700_000_060_000,
    });
  });

  test('getEnrollment 打 /api/mesh/relay/enrollments/:id', async () => {
    const { api, calls } = client(() =>
      json(200, { status: 'redeemed', enroll_pk: 'pk', certificate: 'c', cert_sig: 's' })
    );
    const status = await api.getEnrollment('e 1');
    expect(status.status).toBe('redeemed');
    expect(calls[0]?.path).toBe('/api/mesh/relay/enrollments/e%201');
  });

  test('非 2xx 带出后端 code', async () => {
    const { api } = client(() => json(409, { code: 'RELAY_NOT_CONFIGURED' }));
    const err = await api
      .createEnrollment({
        enroll_pk: 'pk',
        authorization: 'auth',
        authorization_sig: 'sig',
        exp: 1,
      })
      .catch((error: unknown) => error);
    expect(err).toBeInstanceOf(EnrollmentApiError);
    expect((err as EnrollmentApiError).code).toBe('RELAY_NOT_CONFIGURED');
    expect((err as EnrollmentApiError).status).toBe(409);
  });

  test('读不出 body 时退到通用码', async () => {
    const { api } = client(() => new Response('nope', { status: 500 }));
    const err = await api.getEnrollment('e-1').catch((error: unknown) => error);
    expect((err as EnrollmentApiError).code).toBe('enrollment_status_failed');
  });
});
