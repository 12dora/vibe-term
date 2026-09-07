import '../lib/test-master-key';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HubTrustStore } from '../../../../apps/gateway/src/auth/hub-trust-store';
import { TlsConfigStore } from '../../../../apps/gateway/src/tls/tls-config-store';
import { parseArgs } from '../lib/args';
import { readEnvFile } from '../lib/env-file';
import { type LocalAuthContext, openLocalAuth } from '../lib/local-auth';
import { createCa, spkiFingerprint } from '../tls/cert-authority';
import { runHubCaFingerprint, runHubCaRotate, runHubTrustRefresh, runHubUrls } from './hub';

const handles: LocalAuthContext[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const ctx of handles.splice(0)) ctx.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function auth() {
  const ctx = await openLocalAuth({ memory: true });
  handles.push(ctx);
  return ctx;
}
const quiet = { log: () => undefined };

describe('hub recovery commands', () => {
  test('missing CA is a successful empty query like an empty hub URL list', async () => {
    const ctx = await auth();
    const lines: string[] = [];
    const io = { auth: ctx, log: (line: string) => lines.push(line) };
    expect(await runHubCaFingerprint(parseArgs([]), io)).toBe('');
    expect(lines.splice(0)).toEqual(['no CA configured']);
    expect(await runHubUrls(parseArgs([]), 'list', '', io)).toEqual([]);
    expect(lines).toEqual(['VIBETERM_HUB_URLS=']);
  });

  test('seed URLs are canonical, deduplicated and preserve unrelated env keys', async () => {
    const ctx = await auth();
    const dir = await mkdtemp(join(tmpdir(), 'hub-urls-'));
    dirs.push(dir);
    ctx.envPath = join(dir, 'app.env');
    await writeFile(ctx.envPath, 'VIBETERM_HUB_URL=https://old.example\nOTHER=keep\n');
    const io = { auth: ctx, ...quiet };
    await runHubUrls(parseArgs([]), 'add', 'https://NEW.example:443/', io);
    expect(await runHubUrls(parseArgs([]), 'add', 'https://new.example', io)).toEqual([
      'https://new.example',
    ]);
    expect(await runHubUrls(parseArgs([]), 'list', '', io)).toEqual(['https://new.example']);
    expect(await runHubUrls(parseArgs([]), 'remove', 'https://new.example/', io)).toEqual([]);
    expect(await readEnvFile(ctx.envPath)).toEqual({
      VIBETERM_HUB_URL: 'https://old.example',
      VIBETERM_HUB_URLS: '',
      OTHER: 'keep',
    });
    await expect(runHubUrls(parseArgs([]), 'add', 'http://new.example', io)).rejects.toThrow(
      'https:'
    );
  });

  test('refresh verifies the supplied CA and a live TLS connection before replacing a pin', async () => {
    const ctx = await auth();
    const ca = await createCa({ name: 'refresh-test', now: Date.now() });
    const fingerprint = await spkiFingerprint(ca.certPem);
    const trust = new HubTrustStore(ctx.db);
    trust.put({ hubUrl: 'https://hub.example', caPem: 'old', fingerprint: '0'.repeat(64) });
    const calls: unknown[] = [];
    const result = await runHubTrustRefresh(
      parseArgs(['--fingerprint', fingerprint]),
      'https://hub.example/',
      {
        auth: ctx,
        ...quiet,
        fetcher: async (_input, init) => {
          calls.push(init?.tls);
          return new Response(ca.certPem);
        },
      }
    );
    expect(result.fingerprint).toBe(fingerprint);
    expect(calls).toEqual([{ rejectUnauthorized: false }, { ca: [ca.certPem] }]);
    expect(trust.get('https://hub.example')?.fingerprint).toBe(fingerprint);
  });

  test('wrong fingerprint or live TLS failure leaves the old pin intact', async () => {
    const ctx = await auth();
    const ca = await createCa({ name: 'refresh-failure', now: Date.now() });
    const fingerprint = await spkiFingerprint(ca.certPem);
    const trust = new HubTrustStore(ctx.db);
    trust.put({ hubUrl: 'https://hub.example', caPem: 'old', fingerprint: '0'.repeat(64) });
    await expect(
      runHubTrustRefresh(parseArgs(['--fingerprint', '1'.repeat(64)]), 'https://hub.example', {
        auth: ctx,
        ...quiet,
        fetcher: async () => new Response(ca.certPem),
      })
    ).rejects.toThrow('ca_fingerprint_mismatch');
    await expect(
      runHubTrustRefresh(parseArgs(['--fingerprint', fingerprint]), 'https://hub.example', {
        auth: ctx,
        ...quiet,
        fetcher: async (_input, init) => {
          if (init?.tls?.ca) throw new Error('TLS hostname mismatch');
          return new Response(ca.certPem);
        },
      })
    ).rejects.toThrow('TLS hostname mismatch');
    expect(trust.get('https://hub.example')?.caPem).toBe('old');
  });

  test('fingerprint matches the join token SPKI form and rotation requires confirmation', async () => {
    const ctx = await auth();
    const ca = await createCa({ name: 'ca-cli', now: Date.now() });
    await new TlsConfigStore(ctx.db).upsert({
      mode: 'selfsigned',
      sans: ['localhost'],
      caCertPem: ca.certPem,
      caKeyPem: ca.keyPem,
    });
    const old = await runHubCaFingerprint(parseArgs([]), { auth: ctx, ...quiet });
    expect(old).toBe(await spkiFingerprint(ca.certPem));
    await expect(
      runHubCaRotate(parseArgs([]), { auth: ctx, ...quiet, isTTY: false })
    ).rejects.toThrow('--yes');
    expect(await runHubCaFingerprint(parseArgs([]), { auth: ctx, ...quiet })).toBe(old);
    const next = await runHubCaRotate(parseArgs(['--yes']), { auth: ctx, ...quiet, isTTY: false });
    expect(next).not.toBe(old);
  });
});
