import '../lib/test-master-key';
import { afterEach, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { RelayCaPinStore } from '../../../../apps/gateway/src/auth/relay-ca-pin-store';
import { t } from '../i18n';
import { parseArgs } from '../lib/args';
import type { FetchLike } from '../lib/fetch-like';
import { type LocalAuthContext, openLocalAuth } from '../lib/local-auth';
import { createCa, spkiFingerprint } from '../tls/cert-authority';
import { runRelayTrustRefresh } from './relay-trust';

const MIGRATIONS = resolve(import.meta.dir, '../../../../apps/gateway/drizzle');
const RELAY_URL = 'https://relay.example';
const handles: LocalAuthContext[] = [];

afterEach(() => {
  for (const ctx of handles.splice(0)) ctx.close();
});

async function openAuth(): Promise<LocalAuthContext> {
  const auth = await openLocalAuth({
    memory: true,
    migrationsFolder: MIGRATIONS,
    env: {
      VIBETERM_MASTER_KEY: process.env.VIBETERM_MASTER_KEY || '',
      VIBETERM_ROLES: 'node',
    },
  });
  handles.push(auth);
  return auth;
}

describe('runRelayTrustRefresh', () => {
  test('refuses a missing url', async () => {
    await expect(
      runRelayTrustRefresh(
        parseArgs(['relay', 'trust', 'refresh', '--fingerprint', 'ab'.repeat(32)]),
        ''
      )
    ).rejects.toThrow('requires <url>');
  });

  test('refuses a fingerprint that is not 64 hex', async () => {
    await expect(
      runRelayTrustRefresh(
        parseArgs(['relay', 'trust', 'refresh', '--fingerprint', 'not-hex']),
        RELAY_URL
      )
    ).rejects.toThrow(t('relay.trust.fingerprintInvalid'));
  });

  test('fetches the CA unverified, verifies the fingerprint, and stores the pin', async () => {
    const ca = await createCa({ name: 'relay-ca' });
    const fingerprint = await spkiFingerprint(ca.certPem);
    const auth = await openAuth();
    const logs: string[] = [];
    const seen: { path: string; tls: unknown }[] = [];
    const fetcher: FetchLike = async (input, init) => {
      const url = new URL(String(input));
      seen.push({ path: url.pathname, tls: (init as { tls?: unknown } | undefined)?.tls });
      if (url.pathname === '/api/tls/ca.crt') {
        return new Response(ca.certPem, { status: 200 });
      }
      return new Response('nope', { status: 404 });
    };
    const result = await runRelayTrustRefresh(
      parseArgs(['relay', 'trust', 'refresh', '--fingerprint', fingerprint]),
      RELAY_URL,
      { auth, fetcher, log: (line) => logs.push(line) }
    );
    expect(result).toEqual({ relayUrl: RELAY_URL, fingerprint });
    expect(seen).toEqual([{ path: '/api/tls/ca.crt', tls: { rejectUnauthorized: false } }]);
    const stored = new RelayCaPinStore(auth.db).get(RELAY_URL);
    expect(stored?.fingerprint).toBe(fingerprint);
    expect(await spkiFingerprint(stored?.caPem ?? '')).toBe(fingerprint);
    expect(logs.some((line) => line.includes(fingerprint))).toBe(true);
    expect(logs).toContain(t('relay.trust.restartHint'));
  });

  test('refuses a CA that does not match the fingerprint and stores nothing', async () => {
    const attacker = await createCa({ name: 'attacker' });
    const real = await createCa({ name: 'relay-ca' });
    const fingerprint = await spkiFingerprint(real.certPem);
    const auth = await openAuth();
    const fetcher: FetchLike = async () => new Response(attacker.certPem, { status: 200 });
    await expect(
      runRelayTrustRefresh(
        parseArgs(['relay', 'trust', 'refresh', '--fingerprint', fingerprint]),
        RELAY_URL,
        { auth, fetcher }
      )
    ).rejects.toThrow('fingerprint');
    expect(new RelayCaPinStore(auth.db).get(RELAY_URL)).toBeNull();
  });
});
