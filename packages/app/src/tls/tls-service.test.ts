import '../lib/test-master-key';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMigratedAuthDb } from '../../../../apps/gateway/src/auth/test-db';
import { TlsConfigStore } from '../../../../apps/gateway/src/tls/tls-config-store';
import { AcmeHttp01Challenge } from './acme-challenge';
import { type AcmeIssuedMaterial, acmeDirectoryUrl } from './acme-service';
import { createCa, spkiFingerprint } from './cert-authority';
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function dummyMaterial(overrides: Partial<AcmeIssuedMaterial> = {}): AcmeIssuedMaterial {
  const now = Date.now();
  return {
    certPem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
    keyPem: '-----BEGIN PRIVATE KEY-----\nMIIK\n-----END PRIVATE KEY-----',
    notBefore: now,
    notAfter: now + 90 * 24 * 60 * 60 * 1000,
    nextRenewAt: now + 60 * 24 * 60 * 60 * 1000,
    accountKey: 'acct-key',
    accountUrl: 'https://acme.example/acct/1',
    directoryUrl: acmeDirectoryUrl(true),
    domain: 'example.com',
    cleanupWarning: null,
    ...overrides,
  };
}

async function setup(overrides?: {
  envPath?: string;
  issueAcme?: (input: unknown) => Promise<AcmeIssuedMaterial>;
  now?: () => number;
}) {
  const { db, close } = createMigratedAuthDb();
  const dir = await mkdtemp(join(tmpdir(), 'tmex-tls-'));
  const envPath = overrides?.envPath ?? join(dir, 'app.env');
  const jobs: Array<Promise<void>> = [];
  const listener = new FakeListener();
  const store = new TlsConfigStore(db);
  const service = new TlsService({
    store,
    listener,
    challenge: new AcmeHttp01Challenge(),
    envPath,
    scheduleBackground: (work) => {
      jobs.push(work());
    },
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => {},
    issueAcme: overrides?.issueAcme ?? (async () => dummyMaterial()),
    now: overrides?.now,
  });
  return {
    service,
    listener,
    store,
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

  test('external env failure rolls back: mode and listener stay unchanged', async () => {
    const ctx = await setup();
    cleanups.push(ctx.close);
    await ctx.service.applyMode({
      mode: 'selfsigned',
      sans: ['localhost'],
      tlsPort: 9443,
      bindHost: '127.0.0.1',
    });
    const fingerprint = (await ctx.service.status()).caFingerprint;
    const failing = new TlsService({
      store: ctx.store,
      listener: ctx.listener,
      challenge: new AcmeHttp01Challenge(),
      envPath: ctx.dir,
      scheduleBackground: () => {},
      setTimeoutFn: () => 1,
      clearTimeoutFn: () => {},
    });
    try {
      await failing.applyMode({ mode: 'external', trustProxy: true });
      throw new Error('expected env write to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(TlsApiError);
      expect((error as TlsApiError).code).toBe('tls_failed');
    }
    const status = await ctx.service.status();
    expect(status.mode).toBe('selfsigned');
    expect(status.listener.running).toBe(true);
    expect(status.caFingerprint).toBe(fingerprint);
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
    expect(pending.acme?.nextRenewAt).not.toBeNull();
    expect(pending.listener.running).toBe(false);
    await Promise.all(ctx.jobs);
    const ok = await ctx.service.status();
    expect(ok.acme?.status).toBe('ok');
    expect(ok.listener.running).toBe(true);
    expect(ok.acme?.hasCloudflareToken).toBe(false);
    expect(ok.acme?.nextRenewAt).not.toBeNull();
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

  test('stale ACME job result is discarded after a mode change', async () => {
    const started = deferred<void>();
    const gate = deferred<AcmeIssuedMaterial>();
    const stale = dummyMaterial({
      certPem: '-----BEGIN CERTIFICATE-----\nSTALE\n-----END CERTIFICATE-----',
    });
    const ctx = await setup({
      issueAcme: async () => {
        started.resolve();
        return gate.promise;
      },
    });
    cleanups.push(ctx.close);
    await ctx.service.applyMode({
      mode: 'acme',
      domain: 'example.com',
      email: 'ops@example.com',
      challenge: 'http-01',
      staging: true,
      tlsPort: 9443,
      bindHost: '0.0.0.0',
    });
    await started.promise;
    const selfsigned = await ctx.service.applyMode({
      mode: 'selfsigned',
      sans: ['localhost'],
      tlsPort: 9443,
      bindHost: '127.0.0.1',
    });
    gate.resolve(stale);
    await Promise.all(ctx.jobs);
    const status = await ctx.service.status();
    expect(status.mode).toBe('selfsigned');
    expect(status.caFingerprint).toBe(selfsigned.caFingerprint);
    expect(ctx.listener.lastCfg?.certPem).not.toContain('STALE');
    const row = await ctx.store.get();
    expect(row.certPem).not.toContain('STALE');
  });

  test('two concurrent first-time self-signed applies produce one CA', async () => {
    const ctx = await setup();
    cleanups.push(ctx.close);
    const input = {
      mode: 'selfsigned' as const,
      sans: ['localhost'],
      tlsPort: 9443,
      bindHost: '127.0.0.1',
    };
    const [first, second] = await Promise.all([
      ctx.service.applyMode(input),
      ctx.service.applyMode(input),
    ]);
    expect(first.caFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(second.caFingerprint).toBe(first.caFingerprint);
    const row = await ctx.store.get();
    expect(row.caCertPem).toBeTruthy();
  });

  test('listener bind failure after ACME issuance is retried without reissuing', async () => {
    let issueCalls = 0;
    const ctx = await setup({
      issueAcme: async () => {
        issueCalls += 1;
        return dummyMaterial();
      },
    });
    cleanups.push(ctx.close);
    ctx.listener.failNext = true;
    await ctx.service.applyMode({
      mode: 'acme',
      domain: 'example.com',
      email: 'ops@example.com',
      challenge: 'http-01',
      staging: true,
      tlsPort: 9443,
      bindHost: '0.0.0.0',
    });
    await Promise.all(ctx.jobs);
    const failed = await ctx.service.status();
    expect(failed.acme?.status).toBe('error');
    expect(failed.acme?.lastError).toBe('Failed to bind');
    expect(failed.acme?.nextRenewAt).not.toBeNull();
    expect(failed.listener.running).toBe(false);
    expect((await ctx.store.get()).certPem).toContain('BEGIN CERTIFICATE');
    expect(issueCalls).toBe(1);

    await ctx.service.startup();
    await Promise.all(ctx.jobs);
    const ok = await ctx.service.status();
    expect(ok.acme?.status).toBe('ok');
    expect(ok.listener.running).toBe(true);
    expect(issueCalls).toBe(1);
  });

  test('issuance failure arms nextRenewAt backoff and never leaves it null', async () => {
    const ctx = await setup({
      issueAcme: async () => {
        throw new Error('le down');
      },
    });
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
    expect(pending.acme?.nextRenewAt).not.toBeNull();
    await Promise.all(ctx.jobs);
    const failed = await ctx.service.status();
    expect(failed.acme?.status).toBe('error');
    expect(failed.acme?.lastError).toBe('le down');
    expect(failed.acme?.nextRenewAt).not.toBeNull();
    expect(failed.acme?.nextRenewAt ?? 0).toBeGreaterThan(Date.now());
  });

  test('startup resumes pending ACME rows that have no certificate', async () => {
    let issueCalls = 0;
    const ctx = await setup({
      issueAcme: async () => {
        issueCalls += 1;
        return dummyMaterial();
      },
    });
    cleanups.push(ctx.close);
    await ctx.store.upsert({
      mode: 'acme',
      acmeDomain: 'example.com',
      acmeEmail: 'ops@example.com',
      acmeChallenge: 'http-01',
      acmeStaging: true,
      acmeStatus: 'pending',
      acmeNextRenewAt: null,
    });
    await ctx.service.startup();
    await Promise.all(ctx.jobs);
    expect(issueCalls).toBe(1);
    const status = await ctx.service.status();
    expect(status.acme?.status).toBe('ok');
    expect(status.listener.running).toBe(true);
  });

  test('clears the ACME account URL when switching staging and production directories', async () => {
    const gate = deferred<AcmeIssuedMaterial>();
    const ctx = await setup({
      issueAcme: async () => gate.promise,
    });
    cleanups.push(ctx.close);
    await ctx.store.upsert({
      acmeAccountKey: 'keep-me',
      acmeAccountUrl: 'https://staging.example/acct/1',
      acmeAccountDirectory: acmeDirectoryUrl(true),
    });
    await ctx.service.applyMode({
      mode: 'acme',
      domain: 'example.com',
      email: 'ops@example.com',
      challenge: 'http-01',
      staging: false,
      tlsPort: 9443,
      bindHost: '0.0.0.0',
    });
    const afterProd = await ctx.store.get();
    expect(afterProd.acmeAccountUrl).toBeNull();
    expect(afterProd.acmeAccountDirectory).toBe(acmeDirectoryUrl(false));
    expect((await ctx.store.getPrivateMaterial()).acmeAccountKey).toBe('keep-me');

    gate.resolve(dummyMaterial({ directoryUrl: acmeDirectoryUrl(false) }));
    await Promise.all(ctx.jobs);

    const gate2 = deferred<AcmeIssuedMaterial>();
    const second = new TlsService({
      store: ctx.store,
      listener: ctx.listener,
      challenge: new AcmeHttp01Challenge(),
      envPath: ctx.envPath,
      scheduleBackground: (work) => {
        ctx.jobs.push(work());
      },
      setTimeoutFn: () => 1,
      clearTimeoutFn: () => {},
      issueAcme: async () => gate2.promise,
    });
    await ctx.store.upsert({
      acmeAccountUrl: 'https://prod.example/acct/9',
      acmeAccountDirectory: acmeDirectoryUrl(false),
      acmeAccountKey: 'keep-me',
    });
    await second.applyMode({
      mode: 'acme',
      domain: 'example.com',
      email: 'ops@example.com',
      challenge: 'http-01',
      staging: true,
      tlsPort: 9443,
      bindHost: '0.0.0.0',
    });
    const afterStaging = await ctx.store.get();
    expect(afterStaging.acmeAccountUrl).toBeNull();
    expect(afterStaging.acmeAccountDirectory).toBe(acmeDirectoryUrl(true));
    expect((await ctx.store.getPrivateMaterial()).acmeAccountKey).toBe('keep-me');
    gate2.resolve(dummyMaterial());
    await Promise.all(ctx.jobs);
    second.stop();
  });

  test('rotates the CA when remaining validity is below 30 days', async () => {
    const ctx = await setup();
    cleanups.push(ctx.close);
    const shortLived = await createCa({ name: 'expiring CA', days: 10 });
    const oldFingerprint = await spkiFingerprint(shortLived.certPem);
    await ctx.store.upsert({
      caCertPem: shortLived.certPem,
      caKeyPem: shortLived.keyPem,
    });
    const status = await ctx.service.applyMode({
      mode: 'selfsigned',
      sans: ['localhost'],
      tlsPort: 9443,
      bindHost: '127.0.0.1',
    });
    expect(status.caFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(status.caFingerprint).not.toBe(oldFingerprint);
  });

  test('status reuses the projection within TTL', async () => {
    const ctx = await setup();
    cleanups.push(ctx.close);
    const originalGet = ctx.store.get.bind(ctx.store);
    let gets = 0;
    ctx.store.get = async () => {
      gets += 1;
      return originalGet();
    };
    const first = await ctx.service.status();
    const second = await ctx.service.status();
    expect(gets).toBe(1);
    expect(second).toEqual(first);
  });

  test('status cache is per service instance', async () => {
    const a = await setup();
    const b = await setup();
    cleanups.push(a.close, b.close);
    const wrap = (store: TlsConfigStore) => {
      const originalGet = store.get.bind(store);
      let gets = 0;
      store.get = async () => {
        gets += 1;
        return originalGet();
      };
      return () => gets;
    };
    const aGets = wrap(a.store);
    const bGets = wrap(b.store);
    await a.service.status();
    await a.service.status();
    await b.service.status();
    expect(aGets()).toBe(1);
    expect(bGets()).toBe(1);
  });

  test('status cache is invalidated by applyMode', async () => {
    const ctx = await setup();
    cleanups.push(ctx.close);
    const originalGet = ctx.store.get.bind(ctx.store);
    let gets = 0;
    ctx.store.get = async () => {
      gets += 1;
      return originalGet();
    };
    await ctx.service.status();
    expect(gets).toBe(1);
    await ctx.service.applyMode({
      mode: 'selfsigned',
      sans: ['localhost'],
      tlsPort: 9443,
      bindHost: '127.0.0.1',
    });
    expect(gets).toBeGreaterThan(1);
    const afterApply = gets;
    await ctx.service.status();
    expect(gets).toBe(afterApply);
  });

  test('status cache expires after TTL using injectable now', async () => {
    let now = 1_000;
    const ctx = await setup({ now: () => now });
    cleanups.push(ctx.close);
    const originalGet = ctx.store.get.bind(ctx.store);
    let gets = 0;
    ctx.store.get = async () => {
      gets += 1;
      return originalGet();
    };
    await ctx.service.status();
    now += 9_999;
    await ctx.service.status();
    expect(gets).toBe(1);
    now += 2;
    await ctx.service.status();
    expect(gets).toBe(2);
  });
});
