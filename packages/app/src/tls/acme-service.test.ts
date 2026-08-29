import '../lib/test-master-key';
import { describe, expect, test } from 'bun:test';
import { createMigratedAuthDb } from '../../../../apps/gateway/src/auth/test-db';
import { TlsConfigStore } from '../../../../apps/gateway/src/tls/tls-config-store';
import { AcmeHttp01Challenge } from './acme-challenge';
import {
  ACME_RENEW_LEAD_MS,
  type AcmeClientLike,
  RENEWAL_BACKOFF_MAX_MS,
  RENEWAL_BACKOFF_MIN_MS,
  RENEWAL_CHECK_INTERVAL_MS,
  RenewalScheduler,
  acmeDirectoryUrl,
  issue,
  waitForTxt,
} from './acme-service';
import { createCa, issueLeaf } from './cert-authority';
import { CloudflareDnsClient } from './cloudflare-dns';

const AUTHZ = { identifier: { type: 'dns', value: 'example.com' } };

function fakeClient(opts: {
  certPem: string;
  challenge: { type: string; token: string };
  keyAuth: string;
  onCreate?: (challengeType: string) => void;
  fail?: boolean;
  skipRemove?: boolean;
}): AcmeClientLike {
  return {
    getAccountUrl: () => 'https://acme.example/acct/1',
    createAccount: async () => ({ status: 'valid' }),
    auto: async (autoOpts) => {
      if (opts.fail) {
        throw new Error('acme boom');
      }
      expect(autoOpts.challengePriority).toEqual([opts.challenge.type]);
      await autoOpts.challengeCreateFn(AUTHZ, opts.challenge, opts.keyAuth);
      opts.onCreate?.(opts.challenge.type);
      if (!opts.skipRemove) {
        try {
          await autoOpts.challengeRemoveFn(AUTHZ, opts.challenge, opts.keyAuth);
        } catch {
          // swallowed like acme-client
        }
      }
      return opts.certPem;
    },
  };
}

function instantDnsWait() {
  return {
    resolveTxt: (async () => [['dns-key-auth']]) as (
      hostname: string,
      nameservers?: string[]
    ) => Promise<string[][]>,
    sleep: async () => {},
    dnsIntervalMs: 1,
    dnsTimeoutMs: 50,
  };
}

describe('issue', () => {
  test('http-01 writes challenge, returns cert/key, and does not commit the store', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new TlsConfigStore(db);
      const responder = new AcmeHttp01Challenge();
      const ca = await createCa({ name: 'acme test' });
      const leaf = await issueLeaf({ ca, sans: ['example.com'], days: 90 });
      await store.upsert({
        mode: 'acme',
        acmeDomain: 'example.com',
        acmeEmail: 'ops@example.com',
        acmeChallenge: 'http-01',
        acmeStaging: true,
      });
      let seenPending = false;
      const client = fakeClient({
        certPem: leaf.certPem,
        challenge: { type: 'http-01', token: 'tok-1' },
        keyAuth: 'tok-1.thumb',
        onCreate: () => {
          const res = responder.handle(
            new Request('http://127.0.0.1/.well-known/acme-challenge/tok-1')
          );
          expect(res?.status).toBe(200);
          seenPending = true;
        },
      });
      const result = await issue({
        store,
        challenge: responder,
        dns: new CloudflareDnsClient(async () => new Response('no', { status: 500 })),
        clientFactory: () => client,
      });
      expect(seenPending).toBe(true);
      expect(
        responder.handle(new Request('http://127.0.0.1/.well-known/acme-challenge/tok-1'))?.status
      ).toBe(404);
      expect(result.certPem).toContain('BEGIN CERTIFICATE');
      expect(result.keyPem).toContain('BEGIN');
      expect(result.nextRenewAt).toBe(result.notAfter - ACME_RENEW_LEAD_MS);
      expect(result.directoryUrl).toBe(acmeDirectoryUrl(true));
      expect(result.accountUrl).toBe('https://acme.example/acct/1');
      expect(result.cleanupWarning).toBeNull();
      const row = await store.get();
      expect(row.acmeStatus).toBe('idle');
      expect(row.certPem).toBeNull();
      expect(row.hasLeafKey).toBe(false);
    } finally {
      close();
    }
  });

  test('dns-01 waits for TXT visibility then deletes records in an outer finally', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new TlsConfigStore(db);
      const ca = await createCa({ name: 'acme dns' });
      const leaf = await issueLeaf({ ca, sans: ['example.com'], days: 90 });
      await store.upsert({
        mode: 'acme',
        acmeDomain: 'example.com',
        acmeEmail: 'ops@example.com',
        acmeChallenge: 'dns-01',
        acmeCfToken: 'cf-secret',
      });
      const calls: string[] = [];
      const seenNameservers: Array<string[] | undefined> = [];
      const dns = new CloudflareDnsClient(async (url, init) => {
        const method = init?.method ?? 'GET';
        calls.push(`${method} ${url}`);
        if (String(url).includes('/zones?name=example.com')) {
          return Response.json({ success: true, result: [{ id: 'zone-1', name: 'example.com' }] });
        }
        if (method === 'GET' && String(url).endsWith('/zones/zone-1')) {
          return Response.json({
            success: true,
            result: { name_servers: ['ns1.example.com', '203.0.113.1'] },
          });
        }
        if (method === 'POST') {
          const body = JSON.parse(String(init?.body));
          expect(body.name).toBe('_acme-challenge.example.com');
          expect(body.content).toBe('dns-key-auth');
          return Response.json({ success: true, result: { id: 'rec-1' } });
        }
        if (method === 'DELETE') {
          expect(String(url)).toContain('/dns_records/rec-1');
          return Response.json({ success: true, result: { id: 'rec-1' } });
        }
        return Response.json({ success: false }, { status: 400 });
      });
      const result = await issue({
        store,
        challenge: new AcmeHttp01Challenge(),
        dns,
        clientFactory: () =>
          fakeClient({
            certPem: leaf.certPem,
            challenge: { type: 'dns-01', token: 'dns-tok' },
            keyAuth: 'dns-key-auth',
          }),
        resolveTxt: async (_hostname, nameservers) => {
          seenNameservers.push(nameservers);
          return [['dns-key-auth']];
        },
        sleep: async () => {},
        dnsIntervalMs: 1,
        dnsTimeoutMs: 50,
      });
      expect(calls.some((item) => item.startsWith('POST '))).toBe(true);
      expect(calls.some((item) => item.startsWith('DELETE '))).toBe(true);
      expect(calls.some((item) => item.includes('GET ') && item.endsWith('/zones/zone-1'))).toBe(
        true
      );
      expect(seenNameservers[0]).toEqual(['ns1.example.com', '203.0.113.1']);
      expect(result.cleanupWarning).toBeNull();
      expect((await store.get()).acmeStatus).toBe('idle');
    } finally {
      close();
    }
  });

  test('persists a cleanup warning when TXT deletion fails after successful issuance', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new TlsConfigStore(db);
      const ca = await createCa({ name: 'acme dns fail' });
      const leaf = await issueLeaf({ ca, sans: ['example.com'], days: 90 });
      await store.upsert({
        mode: 'acme',
        acmeDomain: 'example.com',
        acmeEmail: 'ops@example.com',
        acmeChallenge: 'dns-01',
        acmeCfToken: 'cf-secret',
      });
      const dns = new CloudflareDnsClient(async (url, init) => {
        const method = init?.method ?? 'GET';
        if (String(url).includes('/zones?name=example.com')) {
          return Response.json({ success: true, result: [{ id: 'zone-1', name: 'example.com' }] });
        }
        if (method === 'GET' && String(url).endsWith('/zones/zone-1')) {
          return Response.json({ success: true, result: { name_servers: ['203.0.113.1'] } });
        }
        if (method === 'POST') {
          return Response.json({ success: true, result: { id: 'rec-1' } });
        }
        if (method === 'DELETE') {
          return Response.json({ success: false, errors: [{ message: 'busy' }] }, { status: 500 });
        }
        return Response.json({ success: false }, { status: 400 });
      });
      const result = await issue({
        store,
        challenge: new AcmeHttp01Challenge(),
        dns,
        clientFactory: () =>
          fakeClient({
            certPem: leaf.certPem,
            challenge: { type: 'dns-01', token: 'dns-tok' },
            keyAuth: 'dns-key-auth',
            skipRemove: true,
          }),
        ...instantDnsWait(),
      });
      expect(result.certPem).toContain('BEGIN CERTIFICATE');
      expect(result.cleanupWarning).toContain('dns-01 cleanup failed');
      expect(result.cleanupWarning).toContain('rec-1');
    } finally {
      close();
    }
  });

  test('does not reuse an account URL from a different ACME directory', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new TlsConfigStore(db);
      const ca = await createCa({ name: 'dir switch' });
      const leaf = await issueLeaf({ ca, sans: ['example.com'], days: 90 });
      const seen: Array<{ directoryUrl: string; accountUrl?: string }> = [];
      const factory: (opts: {
        directoryUrl: string;
        accountKey: string;
        accountUrl?: string;
      }) => AcmeClientLike = (opts) => {
        seen.push({ directoryUrl: opts.directoryUrl, accountUrl: opts.accountUrl });
        return fakeClient({
          certPem: leaf.certPem,
          challenge: { type: 'http-01', token: 't' },
          keyAuth: 't.k',
        });
      };

      await store.upsert({
        mode: 'acme',
        acmeDomain: 'example.com',
        acmeEmail: 'ops@example.com',
        acmeChallenge: 'http-01',
        acmeStaging: true,
        acmeAccountKey: 'ACCOUNT_KEY',
        acmeAccountUrl: 'https://staging.example/acct/1',
        acmeAccountDirectory: acmeDirectoryUrl(true),
      });
      const staging = await issue({
        store,
        challenge: new AcmeHttp01Challenge(),
        dns: new CloudflareDnsClient(async () => new Response('no', { status: 500 })),
        clientFactory: factory,
        config: { staging: true },
      });
      expect(seen.at(-1)?.accountUrl).toBe('https://staging.example/acct/1');
      expect(staging.directoryUrl).toBe(acmeDirectoryUrl(true));

      const production = await issue({
        store,
        challenge: new AcmeHttp01Challenge(),
        dns: new CloudflareDnsClient(async () => new Response('no', { status: 500 })),
        clientFactory: factory,
        config: { staging: false },
      });
      expect(seen.at(-1)?.accountUrl).toBeUndefined();
      expect(production.directoryUrl).toBe(acmeDirectoryUrl(false));

      await store.upsert({
        acmeStaging: false,
        acmeAccountUrl: production.accountUrl,
        acmeAccountDirectory: production.directoryUrl,
      });
      const backToStaging = await issue({
        store,
        challenge: new AcmeHttp01Challenge(),
        dns: new CloudflareDnsClient(async () => new Response('no', { status: 500 })),
        clientFactory: factory,
        config: { staging: true },
      });
      expect(seen.at(-1)?.accountUrl).toBeUndefined();
      expect(backToStaging.directoryUrl).toBe(acmeDirectoryUrl(true));
    } finally {
      close();
    }
  });

  test('throws on issuance failure without writing cert material', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new TlsConfigStore(db);
      await store.upsert({
        mode: 'acme',
        acmeDomain: 'example.com',
        acmeEmail: 'ops@example.com',
        acmeChallenge: 'http-01',
      });
      await expect(
        issue({
          store,
          challenge: new AcmeHttp01Challenge(),
          dns: new CloudflareDnsClient(async () => new Response('no', { status: 500 })),
          clientFactory: () =>
            fakeClient({
              certPem: 'nope',
              challenge: { type: 'http-01', token: 'x' },
              keyAuth: 'y',
              fail: true,
            }),
        })
      ).rejects.toThrow('acme boom');
      const row = await store.get();
      expect(row.acmeStatus).toBe('idle');
      expect(row.certPem).toBeNull();
      expect(row.acmeLastError).toBeNull();
    } finally {
      close();
    }
  });
});

describe('waitForTxt', () => {
  test('polls until the exact TXT value is visible', async () => {
    let calls = 0;
    let now = 0;
    await waitForTxt({
      hostname: '_acme-challenge.example.com',
      value: 'abc',
      nameservers: ['203.0.113.1'],
      intervalMs: 2000,
      timeoutMs: 10_000,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      resolveTxt: async (hostname, nameservers) => {
        expect(hostname).toBe('_acme-challenge.example.com');
        expect(nameservers).toEqual(['203.0.113.1']);
        calls += 1;
        if (calls < 3) return [];
        return [['abc']];
      },
    });
    expect(calls).toBe(3);
  });

  test('times out when the value never appears', async () => {
    let now = 0;
    await expect(
      waitForTxt({
        hostname: '_acme-challenge.example.com',
        value: 'abc',
        intervalMs: 2000,
        timeoutMs: 4000,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        resolveTxt: async () => [],
      })
    ).rejects.toThrow(/did not propagate/);
  });
});

describe('RenewalScheduler', () => {
  test('retries with 1h..24h backoff then resumes the 12h cadence', async () => {
    const delays: number[] = [];
    let attempts = 0;
    const scheduler = new RenewalScheduler({
      isDue: () => true,
      renew: async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error(`fail-${attempts}`);
        }
      },
      setTimeoutFn: (_fn, ms) => {
        delays.push(ms);
        return delays.length;
      },
      clearTimeoutFn: () => {},
    });
    scheduler.start();
    expect(delays).toEqual([RENEWAL_CHECK_INTERVAL_MS]);
    await scheduler.runNow();
    expect(delays.at(-1)).toBe(RENEWAL_BACKOFF_MIN_MS);
    await scheduler.runNow();
    expect(delays.at(-1)).toBe(RENEWAL_BACKOFF_MIN_MS * 2);
    await scheduler.runNow();
    expect(delays.at(-1)).toBe(RENEWAL_CHECK_INTERVAL_MS);
    expect(attempts).toBe(3);
    scheduler.stop();
    expect(RENEWAL_BACKOFF_MAX_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe('resolveTxtOverHttps', () => {
  test('parses dns-json TXT answers and strips quotes', async () => {
    const { resolveTxtOverHttps } = await import('./acme-service');
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.searchParams.get('name')).toBe('_acme-challenge.example.com');
      expect(url.searchParams.get('type')).toBe('TXT');
      return Response.json({
        Answer: [
          { type: 16, data: '"abc"' },
          { type: 5, data: 'cname.example.com.' },
        ],
      });
    }) as typeof fetch;
    expect(await resolveTxtOverHttps('_acme-challenge.example.com', fetchImpl)).toEqual([['abc']]);
  });

  test('rejects on non-2xx', async () => {
    const { resolveTxtOverHttps } = await import('./acme-service');
    const fetchImpl = (async () => new Response('x', { status: 502 })) as typeof fetch;
    await expect(resolveTxtOverHttps('h', fetchImpl)).rejects.toThrow('doh 502');
  });
});
