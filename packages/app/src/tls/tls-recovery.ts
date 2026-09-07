import type { AuthDb } from '../../../../apps/gateway/src/auth/types';
import { encrypt } from '../../../../apps/gateway/src/crypto';
import { tlsConfig } from '../../../../apps/gateway/src/db/schema';
import { TlsConfigStore } from '../../../../apps/gateway/src/tls/tls-config-store';
import { rotateSelfSignedCa } from './tls-service';

export function resetTlsConfig(db: Pick<AuthDb, 'delete'>): void {
  db.delete(tlsConfig).run();
}

export async function rotateStoredSelfSignedCa(db: AuthDb, now: number): Promise<void> {
  const store = new TlsConfigStore(db);
  await rotateSelfSignedCa(
    {
      get: () => store.get(),
      upsert: async (patch) => {
        if (!patch.caKeyPem || !patch.keyPem) throw new Error('missing replacement TLS keys');
        const [caKeyEnc, keyEnc] = await Promise.all([
          encrypt(patch.caKeyPem),
          encrypt(patch.keyPem),
        ]);
        db.update(tlsConfig)
          .set({
            caCertPem: patch.caCertPem,
            caKeyEnc,
            certPem: patch.certPem,
            keyEnc,
            certNotBefore: patch.certNotBefore,
            certNotAfter: patch.certNotAfter,
            acmeCfTokenEnc: null,
            acmeDnsSecretEnc: null,
            acmeDnsProvider: null,
            acmeAccountKeyEnc: null,
            acmeAccountUrl: null,
            acmeAccountDirectory: null,
            updatedAt: now,
          })
          .run();
        return store.get();
      },
    },
    { now }
  );
}
