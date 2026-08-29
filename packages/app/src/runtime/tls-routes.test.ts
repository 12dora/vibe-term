import '../lib/test-master-key';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMigratedAuthDb } from '../../../../apps/gateway/src/auth/test-db';
import { TlsConfigStore } from '../../../../apps/gateway/src/tls/tls-config-store';
import { AcmeHttp01Challenge } from '../tls/acme-challenge';
import type { HttpsListenerConfig, HttpsListenerState } from '../tls/https-listener';
import { type TlsListener, TlsService } from '../tls/tls-service';
import { createTlsRoutes } from './tls-routes';

class FakeListener implements TlsListener {
  private current: HttpsListenerState = { running: false, port: null, error: null };
  async apply(cfg: HttpsListenerConfig | null): Promise<void> {
    this.current = cfg
      ? { running: true, port: cfg.port, error: null }
      : { running: false, port: null, error: null };
  }
  state(): HttpsListenerState {
    return this.current;
  }
  async stop(): Promise<void> {
    await this.apply(null);
  }
}

describe('createTlsRoutes', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  test('authorizes API routes, serves CA, and answers http-01 challenges without auth', async () => {
    const { db, close } = createMigratedAuthDb();
    const dir = await mkdtemp(join(tmpdir(), 'tmex-tls-routes-'));
    const challenge = new AcmeHttp01Challenge();
    const jobs: Array<Promise<void>> = [];
    const service = new TlsService({
      store: new TlsConfigStore(db),
      listener: new FakeListener(),
      challenge,
      envPath: join(dir, 'app.env'),
      scheduleBackground: (work) => {
        jobs.push(work());
      },
      setTimeoutFn: () => 1,
      clearTimeoutFn: () => {},
    });
    cleanups.push(async () => {
      service.stop();
      close();
      await rm(dir, { recursive: true, force: true });
    });

    let authorized = false;
    const handle = createTlsRoutes({
      service,
      authorize: async () => {
        authorized = true;
        return null;
      },
    });

    challenge.set('abc', 'abc.thumb');
    const challengeRes = await handle(
      new Request('http://127.0.0.1/.well-known/acme-challenge/abc')
    );
    expect(authorized).toBe(false);
    expect(challengeRes?.status).toBe(200);
    expect(await challengeRes?.text()).toBe('abc.thumb');

    const denied = createTlsRoutes({
      service,
      authorize: async () => new Response('no', { status: 401 }),
    });
    const blocked = await denied(new Request('http://127.0.0.1/api/tls'));
    expect(blocked?.status).toBe(401);
    const publicCa = await denied(new Request('http://127.0.0.1/api/tls/ca.crt'));
    expect(publicCa?.status).toBe(404);

    const put = await handle(
      new Request('http://127.0.0.1/api/tls', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: 'selfsigned',
          sans: ['localhost'],
          tlsPort: 9443,
          bindHost: '127.0.0.1',
        }),
      })
    );
    expect(put?.status).toBe(200);
    const body = (await put?.json()) as { mode: string; caFingerprint: string };
    expect(body.mode).toBe('selfsigned');
    expect(body.caFingerprint).toMatch(/^[0-9a-f]{64}$/);

    const ca = await handle(new Request('http://127.0.0.1/api/tls/ca.crt'));
    expect(ca?.status).toBe(200);
    expect(ca?.headers.get('content-type')).toBe('application/x-x509-ca-cert');
    expect(ca?.headers.get('content-disposition')).toContain('tmex-ca.crt');
    expect(await ca?.text()).toContain('BEGIN CERTIFICATE');

    const other = await handle(new Request('http://127.0.0.1/healthz'));
    expect(other).toBeNull();
    await Promise.all(jobs);
  });

  test('maps validation errors to { error: { code, message } }', async () => {
    const { db, close } = createMigratedAuthDb();
    const dir = await mkdtemp(join(tmpdir(), 'tmex-tls-routes-err-'));
    const service = new TlsService({
      store: new TlsConfigStore(db),
      listener: new FakeListener(),
      challenge: new AcmeHttp01Challenge(),
      envPath: join(dir, 'app.env'),
      scheduleBackground: () => {},
      setTimeoutFn: () => 1,
      clearTimeoutFn: () => {},
    });
    cleanups.push(async () => {
      service.stop();
      close();
      await rm(dir, { recursive: true, force: true });
    });
    const handle = createTlsRoutes({
      service,
      authorize: async () => null,
    });
    const res = await handle(
      new Request('http://127.0.0.1/api/tls', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: 'selfsigned',
          sans: [],
          tlsPort: 9443,
          bindHost: '127.0.0.1',
        }),
      })
    );
    expect(res?.status).toBe(400);
    expect(await res?.json()).toEqual({
      error: { code: 'invalid_sans', message: expect.any(String) },
    });

    const renew = await handle(new Request('http://127.0.0.1/api/tls/renew', { method: 'POST' }));
    expect(renew?.status).toBe(409);
    expect(await renew?.json()).toEqual({
      error: { code: 'not_applicable', message: expect.any(String) },
    });
  });
});
