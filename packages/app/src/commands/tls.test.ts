import '../lib/test-master-key';
import { afterEach, describe, expect, test } from 'bun:test';
import { tlsConfig } from '../../../../apps/gateway/src/db/schema';
import { TlsConfigStore } from '../../../../apps/gateway/src/tls/tls-config-store';
import { parseArgs } from '../lib/args';
import { type LocalAuthContext, openLocalAuth } from '../lib/local-auth';
import { createCa } from '../tls/cert-authority';
import { runMeshResetIdentity } from './mesh';
import { runTlsReset } from './tls';

const handles: LocalAuthContext[] = [];
const quiet = { log() {}, isTTY: false };
const yes = parseArgs(['--yes']);

afterEach(() => {
  for (const ctx of handles.splice(0)) ctx.close();
});

async function brokenTls() {
  const auth = await openLocalAuth({ memory: true });
  handles.push(auth);
  auth.db
    .insert(tlsConfig)
    .values({
      id: 1,
      mode: 'selfsigned',
      sans: ['localhost'],
      caKeyEnc: 'unreadable-ca',
      keyEnc: 'unreadable-leaf',
      acmeAccountKeyEnc: 'unreadable-account',
      acmeCfTokenEnc: 'unreadable-cf',
      acmeDnsSecretEnc: 'unreadable-dns',
      updatedAt: 1,
    })
    .run();
  return { auth, store: new TlsConfigStore(auth.db) };
}

describe('TLS recovery commands', () => {
  test('confirmed TLS reset clears every undecryptable secret and allows normal reconfiguration', async () => {
    const { auth, store } = await brokenTls();
    await expect(store.upsert({ mode: 'none' })).rejects.toThrow();
    await runTlsReset(yes, { auth, ...quiet });
    expect(auth.db.select().from(tlsConfig).all()).toEqual([]);
    expect((await store.get()).mode).toBe('none');
    expect(Object.values(await store.getPrivateMaterial())).toEqual(Array(5).fill(null));
    const ca = await createCa({ name: 'replacement-ca', now: Date.now() });
    await store.upsert({ mode: 'selfsigned', caCertPem: ca.certPem, caKeyPem: ca.keyPem });
    expect((await store.getPrivateMaterial()).caKeyPem).toBe(ca.keyPem);
  });

  test('TLS reset requires explicit non-interactive confirmation before modifying rows', async () => {
    const { auth } = await brokenTls();
    const before = auth.db.select().from(tlsConfig).all();
    await expect(runTlsReset(parseArgs([]), { auth, ...quiet })).rejects.toThrow('--yes');
    expect(auth.db.select().from(tlsConfig).all()).toEqual(before);
  });

  test('TLS reset requires typed yes on a TTY even with --yes', async () => {
    const { auth } = await brokenTls();
    await expect(
      runTlsReset(yes, {
        auth,
        ...quiet,
        isTTY: true,
        readConfirmation: async () => 'y',
      })
    ).rejects.toThrow();
    expect(auth.db.select().from(tlsConfig).all()).toHaveLength(1);
    await runTlsReset(yes, {
      auth,
      ...quiet,
      isTTY: true,
      readConfirmation: async () => 'yes',
    });
    expect(auth.db.select().from(tlsConfig).all()).toEqual([]);
  });

  test('TLS reset requires the local install authentication context', async () => {
    await expect(
      runTlsReset(parseArgs(['--install-dir', '/tmp/vibeterm-missing-tls-install', '--yes']), quiet)
    ).rejects.toThrow('config file not found');
  });

  test('reset-identity preserves broken TLS unless --reset-tls is explicitly confirmed', async () => {
    const { auth } = await brokenTls();
    const before = auth.db.select().from(tlsConfig).all();
    await runMeshResetIdentity(yes, { auth, ...quiet });
    expect(auth.db.select().from(tlsConfig).all()).toEqual(before);
    await expect(
      runMeshResetIdentity(parseArgs(['--reset-tls']), { auth, ...quiet })
    ).rejects.toThrow('--yes');
    expect(auth.db.select().from(tlsConfig).all()).toEqual(before);
    await runMeshResetIdentity(parseArgs(['--reset-tls', '--yes']), { auth, ...quiet });
    expect(auth.db.select().from(tlsConfig).all()).toEqual([]);
    expect((await auth.identityStore.load())?.nodeId).toBeTruthy();
  });

  test('reset-identity rolls back the identity replacement when the TLS reset fails', async () => {
    const { auth } = await brokenTls();
    const before = await runMeshResetIdentity(yes, { auth, ...quiet });
    auth.sqlite.run(
      "CREATE TRIGGER fail_tls_reset BEFORE DELETE ON tls_config BEGIN SELECT RAISE(ABORT, 'reset failed'); END",
      []
    );
    await expect(
      runMeshResetIdentity(parseArgs(['--reset-tls', '--yes']), { auth, ...quiet })
    ).rejects.toThrow('reset failed');
    expect((await auth.identityStore.load())?.nodeId).toBe(before.nodeId);
    expect(auth.db.select().from(tlsConfig).all()).toHaveLength(1);
  });
});
