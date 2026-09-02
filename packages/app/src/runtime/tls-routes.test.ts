import '../lib/test-master-key';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMigratedAuthDb } from '../../../../apps/gateway/src/auth/test-db';
import { setMeshRequestContext } from '../../../../apps/gateway/src/mesh/mesh-deps';
import { TlsConfigStore } from '../../../../apps/gateway/src/tls/tls-config-store';
import { AcmeHttp01Challenge } from '../tls/acme-challenge';
import type { HttpsListenerConfig, HttpsListenerState } from '../tls/https-listener';
import { type TlsListener, TlsService } from '../tls/tls-service';
import { createTlsRoutes, resolveEffectiveHttps } from './tls-routes';

type EffectiveHttps = {
  source: 'builtin' | 'reverse-proxy' | 'none';
  verified: boolean;
  publicUrl: string | null;
};

function listenerStatus(running: boolean) {
  return { listener: { running, port: running ? 9443 : null, error: null } };
}

function requestWithForwarded(init: {
  proto?: string;
  host?: string;
  via?: string;
  trustProxy?: boolean;
  url?: string;
}): Request {
  const headers: Record<string, string> = {};
  if (init.proto) headers['x-forwarded-proto'] = init.proto;
  if (init.host) headers['x-forwarded-host'] = init.host;
  const req = new Request(init.url ?? 'http://127.0.0.1:19663/api/tls', { headers });
  if (init.via !== undefined || init.trustProxy !== undefined) {
    setMeshRequestContext(req, {
      via: init.via ?? 'self',
      trustProxy: init.trustProxy,
    });
  }
  return req;
}

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

async function bootTlsRoutes(opts?: { configuredPublicUrl?: string | null }) {
  const { db, close } = createMigratedAuthDb();
  const dir = await mkdtemp(join(tmpdir(), 'tmex-tls-https-'));
  const service = new TlsService({
    store: new TlsConfigStore(db),
    listener: new FakeListener(),
    challenge: new AcmeHttp01Challenge(),
    envPath: join(dir, 'app.env'),
    scheduleBackground: () => {},
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => {},
  });
  const handle = createTlsRoutes({
    service,
    authorize: async () => null,
    configuredPublicUrl: opts?.configuredPublicUrl ?? null,
  });
  return {
    handle,
    close: async () => {
      service.stop();
      close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describe('resolveEffectiveHttps', () => {
  test('builtin listener running wins over proxy headers and config url', () => {
    const req = requestWithForwarded({
      proto: 'https',
      host: 'hub.example',
      via: 'self',
      trustProxy: true,
    });
    expect(resolveEffectiveHttps(listenerStatus(true), req, 'https://configured.example')).toEqual({
      source: 'builtin',
      verified: true,
      publicUrl: null,
    });
  });

  test('trusted forwarded https is reverse-proxy verified with request origin', () => {
    const req = requestWithForwarded({
      proto: 'https',
      host: 'hub.example',
      via: 'self',
      trustProxy: true,
    });
    expect(resolveEffectiveHttps(listenerStatus(false), req, 'http://configured.example')).toEqual({
      source: 'reverse-proxy',
      verified: true,
      publicUrl: 'https://hub.example',
    });
  });

  test('untrusted forwarded https is ignored; config https is reverse-proxy unverified', () => {
    const req = requestWithForwarded({
      proto: 'https',
      host: 'hub.example',
      via: 'self',
      trustProxy: false,
    });
    expect(
      resolveEffectiveHttps(listenerStatus(false), req, 'https://configured.example/path')
    ).toEqual({
      source: 'reverse-proxy',
      verified: false,
      publicUrl: 'https://configured.example/path',
    });
  });

  test('no listener, no trusted https, no https config is none', () => {
    const req = requestWithForwarded({ proto: 'https', host: 'hub.example' });
    expect(resolveEffectiveHttps(listenerStatus(false), req, 'http://127.0.0.1:19663')).toEqual({
      source: 'none',
      verified: false,
      publicUrl: null,
    });
  });
});

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

  test('PUT /api/tls and POST /api/tls/renew call onApplied after success', async () => {
    const { db, close } = createMigratedAuthDb();
    const dir = await mkdtemp(join(tmpdir(), 'tmex-tls-applied-'));
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
    let applied = 0;
    const handle = createTlsRoutes({
      service,
      authorize: async () => null,
      onApplied: () => {
        applied += 1;
      },
    });
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
    expect(applied).toBe(1);
    const bad = await handle(
      new Request('http://127.0.0.1/api/tls', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'selfsigned', sans: [] }),
      })
    );
    expect(bad?.status).toBe(400);
    expect(applied).toBe(1);
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

  test('GET /api/tls reports trusted forwarded https as reverse-proxy verified', async () => {
    const ctx = await bootTlsRoutes({ configuredPublicUrl: 'http://configured.example' });
    cleanups.push(ctx.close);
    const req = requestWithForwarded({
      proto: 'https',
      host: 'hub.example',
      via: 'self',
      trustProxy: true,
    });
    const res = await ctx.handle(req);
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { https: EffectiveHttps };
    expect(body.https).toEqual({
      source: 'reverse-proxy',
      verified: true,
      publicUrl: 'https://hub.example',
    });
  });

  test('GET /api/tls ignores untrusted forwarded https and falls back to config', async () => {
    const ctx = await bootTlsRoutes({ configuredPublicUrl: 'https://configured.example' });
    cleanups.push(ctx.close);
    const req = requestWithForwarded({
      proto: 'https',
      host: 'spoof.example',
      via: 'entry-node',
      trustProxy: true,
    });
    const res = await ctx.handle(req);
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { https: EffectiveHttps };
    expect(body.https).toEqual({
      source: 'reverse-proxy',
      verified: false,
      publicUrl: 'https://configured.example',
    });
  });

  test('GET /api/tls uses config-only https when no forwarded headers are present', async () => {
    const ctx = await bootTlsRoutes({ configuredPublicUrl: 'https://hub.example' });
    cleanups.push(ctx.close);
    const res = await ctx.handle(new Request('http://127.0.0.1:19663/api/tls'));
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { https: EffectiveHttps };
    expect(body.https).toEqual({
      source: 'reverse-proxy',
      verified: false,
      publicUrl: 'https://hub.example',
    });
  });

  test('PUT /api/tls and POST /api/tls/renew merge https into the status body', async () => {
    const ctx = await bootTlsRoutes({ configuredPublicUrl: 'https://hub.example' });
    cleanups.push(ctx.close);
    const put = await ctx.handle(
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
    const putBody = (await put?.json()) as { https: EffectiveHttps };
    expect(putBody.https).toEqual({ source: 'builtin', verified: true, publicUrl: null });

    const renewed = await ctx.handle(
      new Request('http://127.0.0.1/api/tls/renew', { method: 'POST' })
    );
    expect(renewed?.status).toBe(200);
    const renewBody = (await renewed?.json()) as { https: EffectiveHttps };
    expect(renewBody.https).toEqual({ source: 'builtin', verified: true, publicUrl: null });
  });
});
