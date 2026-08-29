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
  issue,
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
      await autoOpts.challengeRemoveFn(AUTHZ, opts.challenge, opts.keyAuth);
      return opts.certPem;
    },
  };
}

describe('issue', () => {
  test('http-01 writes challenge, persists cert/key, and sets nextRenewAt', async () => {
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
      await issue({
        store,
        challenge: responder,
        dns: new CloudflareDnsClient(async () => new Response('no', { status: 500 })),
        clientFactory: () => client,
      });
      expect(seenPending).toBe(true);
      expect(
        responder.handle(new Request('http://127.0.0.1/.well-known/acme-challenge/tok-1'))?.status
      ).toBe(404);
      const row = await store.get();
      expect(row.acmeStatus).toBe('ok');
      expect(row.certPem).toContain('BEGIN CERTIFICATE');
      expect(row.acmeNextRenewAt).toBe((row.certNotAfter ?? 0) - ACME_RENEW_LEAD_MS);
      expect(row.hasLeafKey).toBe(true);
      expect(row.hasAccountKey).toBe(true);
      const material = await store.getPrivateMaterial();
      expect(material.keyPem).toContain('BEGIN');
      expect(material.acmeAccountKey).toContain('BEGIN');
    } finally {
      close();
    }
  });

  test('dns-01 creates and deletes Cloudflare TXT records', async () => {
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
      const dns = new CloudflareDnsClient(async (url, init) => {
        const method = init?.method ?? 'GET';
        calls.push(`${method} ${url}`);
        if (String(url).includes('/zones?name=example.com')) {
          return Response.json({ success: true, result: [{ id: 'zone-1', name: 'example.com' }] });
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
      await issue({
        store,
        challenge: new AcmeHttp01Challenge(),
        dns,
        clientFactory: () =>
          fakeClient({
            certPem: leaf.certPem,
            challenge: { type: 'dns-01', token: 'dns-tok' },
            keyAuth: 'dns-key-auth',
          }),
      });
      expect(calls.some((item) => item.startsWith('POST '))).toBe(true);
      expect(calls.some((item) => item.startsWith('DELETE '))).toBe(true);
      expect((await store.get()).acmeStatus).toBe('ok');
    } finally {
      close();
    }
  });

  test('records acme_status=error on failure', async () => {
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
      expect(row.acmeStatus).toBe('error');
      expect(row.acmeLastError).toBe('acme boom');
    } finally {
      close();
    }
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
