import '../lib/test-master-key';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMigratedAuthDb } from '../../../../apps/gateway/src/auth/test-db';
import { TlsConfigStore } from '../../../../apps/gateway/src/tls/tls-config-store';
import { AcmeHttp01Challenge } from './acme-challenge';
import { TlsApiError } from './errors';
import type { HttpsListenerConfig, HttpsListenerState } from './https-listener';
import { type TlsListener, TlsService } from './tls-service';

class FakeListener implements TlsListener {
  failNext = false;
  lastCfg: HttpsListenerConfig | null = null;
  private current: HttpsListenerState = { running: false, port: null, error: null };

  state(): HttpsListenerState {
    return this.current;
  }

  async apply(cfg: HttpsListenerConfig | null): Promise<void> {
    this.lastCfg = cfg;
    if (!cfg) {
      this.current = { running: false, port: null, error: null };
      return;
    }
    if (this.failNext) {
      this.failNext = false;
      this.current = { running: false, port: null, error: 'Failed to bind' };
      return;
    }
    this.current = { running: true, port: cfg.port, error: null };
  }

  async stop(): Promise<void> {
    await this.apply(null);
  }
}

async function setup() {
  const { db, close } = createMigratedAuthDb();
  const dir = await mkdtemp(join(tmpdir(), 'tmex-tls-'));
  const envPath = join(dir, 'app.env');
  const jobs: Array<Promise<void>> = [];
  const listener = new FakeListener();
  const service = new TlsService({
    store: new TlsConfigStore(db),
    listener,
    challenge: new AcmeHttp01Challenge(),
    envPath,
    scheduleBackground: (work) => {
      jobs.push(work());
    },
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => {},
    issueAcme: async ({ store }) => {
      await store.upsert({
        certPem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
        keyPem: '-----BEGIN PRIVATE KEY-----\nMIIK\n-----END PRIVATE KEY-----',
        certNotBefore: 1,
        certNotAfter: 2,
        acmeStatus: 'ok',
        acmeLastError: null,
        acmeNextRenewAt: 3,
      });
    },
  });
  return {
    service,
    listener,
    envPath,
    dir,
    jobs,
    close: async () => {
      service.stop();
      close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describe('TlsService', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  test('selfsigned issues a leaf, starts the listener, and none keeps material', async () => {
    const ctx = await setup();
    cleanups.push(ctx.close);
    const status = await ctx.service.applyMode({
      mode: 'selfsigned',
      sans: ['localhost', '127.0.0.1'],
      tlsPort: 9443,
      bindHost: '127.0.0.1',
    });
    expect(status.mode).toBe('selfsigned');
    expect(status.listener.running).toBe(true);
    expect(status.caFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(status.certificate?.sans).toEqual(expect.arrayContaining(['localhost', '127.0.0.1']));
    expect(ctx.listener.lastCfg?.certPem).toContain('BEGIN CERTIFICATE');
    expect(ctx.listener.lastCfg?.keyPem).toContain('BEGIN PRIVATE KEY');

    const none = await ctx.service.applyMode({ mode: 'none' });
    expect(none.mode).toBe('none');
    expect(none.listener.running).toBe(false);
    expect(none.certificate).not.toBeNull();
    expect(await ctx.service.caPem()).toBeNull();
  });

  test('rejects invalid sans and bind failures with the contract codes', async () => {
    const ctx = await setup();
    cleanups.push(ctx.close);
    try {
      await ctx.service.applyMode({
        mode: 'selfsigned',
        sans: ['not a host'],
        tlsPort: 9443,
        bindHost: '127.0.0.1',
      });
      throw new Error('expected invalid_sans');
    } catch (error) {
      expect(error).toBeInstanceOf(TlsApiError);
      expect((error as TlsApiError).code).toBe('invalid_sans');
      expect((error as TlsApiError).status).toBe(400);
    }

    ctx.listener.failNext = true;
    try {
      await ctx.service.applyMode({
        mode: 'selfsigned',
        sans: ['localhost'],
        tlsPort: 9443,
        bindHost: '127.0.0.1',
      });
      throw new Error('expected port_in_use');
    } catch (error) {
      expect((error as TlsApiError).code).toBe('port_in_use');
      expect((error as TlsApiError).status).toBe(409);
    }
    const status = await ctx.service.status();
    expect(status.mode).toBe('selfsigned');
    expect(status.listener.error).toBe('Failed to bind');
  });

  test('external writes TMEX_TRUST_PROXY and marks restart required', async () => {
    const ctx = await setup();
    cleanups.push(ctx.close);
    const status = await ctx.service.applyMode({ mode: 'external', trustProxy: true });
    expect(status.mode).toBe('external');
    expect(status.trustProxy).toBe(true);
    expect(status.restartRequired).toBe(true);
    const env = await readFile(ctx.envPath, 'utf8');
    expect(env).toContain('TMEX_TRUST_PROXY=true');
  });

  test('acme returns pending immediately then ok after background issue', async () => {
    const ctx = await setup();
    cleanups.push(ctx.close);
    const pending = await ctx.service.applyMode({
      mode: 'acme',
      domain: 'example.com',
      email: 'ops@example.com',
      challenge: 'http-01',
      staging: true,
      tlsPort: 9443,
      bindHost: '0.0.0.0',
    });
    expect(pending.acme?.status).toBe('pending');
    expect(pending.listener.running).toBe(false);
    await Promise.all(ctx.jobs);
    const ok = await ctx.service.status();
    expect(ok.acme?.status).toBe('ok');
    expect(ok.listener.running).toBe(true);
    expect(ok.acme?.hasCloudflareToken).toBe(false);
  });

  test('renew is not applicable for none/external', async () => {
    const ctx = await setup();
    cleanups.push(ctx.close);
    try {
      await ctx.service.renew();
      throw new Error('expected not_applicable');
    } catch (error) {
      expect((error as TlsApiError).code).toBe('not_applicable');
      expect((error as TlsApiError).status).toBe(409);
    }
  });

  test('startup applies stored material and starts acme renewal', async () => {
    const ctx = await setup();
    cleanups.push(ctx.close);
    await ctx.service.applyMode({
      mode: 'selfsigned',
      sans: ['localhost'],
      tlsPort: 9443,
      bindHost: '127.0.0.1',
    });
    await ctx.listener.stop();
    expect(ctx.listener.state().running).toBe(false);
    await ctx.service.startup();
    expect(ctx.listener.state().running).toBe(true);
    expect(await ctx.service.caPem()).toContain('BEGIN CERTIFICATE');
  });
});
