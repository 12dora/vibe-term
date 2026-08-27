import '../lib/test-master-key';
import { afterEach, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { ensureNodeIdentity } from '../../../../apps/gateway/src/auth/node-identity-service';
import {
  JOIN_TOKEN_CHARS,
  createNodeCertificate,
  decodeJoinToken,
  randomBytes,
  rootKeyFromSeed,
} from '../../../shared/src/auth';
import { parseArgs } from '../lib/args';
import { type LocalAuthContext, openLocalAuth } from '../lib/local-auth';
import { fakeLocalRedeem, runEnroll } from './enroll';
import { runHubUserAdd } from './hub';

const MIGRATIONS = resolve(import.meta.dir, '../../../../apps/gateway/drizzle');
const parsed = parseArgs(['enroll', '--ttl', '10m']);
const handles: LocalAuthContext[] = [];

afterEach(() => {
  for (const ctx of handles.splice(0)) ctx.close();
});

describe('enroll', () => {
  test('path (a) creates a token and admits after a fake redeem', async () => {
    const auth = await openLocalAuth({
      memory: true,
      migrationsFolder: MIGRATIONS,
      env: {
        TMEX_MASTER_KEY: process.env.TMEX_MASTER_KEY || '',
        TMEX_ROLES: 'hub,node',
        TMEX_HUB_PUBLIC_URL: 'https://hub.example',
      },
    });
    handles.push(auth);
    await runHubUserAdd(parsed, 'frank', {
      auth,
      password: 'enroll-pass-word',
      log: () => undefined,
    });
    const identity = await ensureNodeIdentity(auth.identityStore);
    let capturedToken = '';
    const result = await runEnroll(parsed, {
      auth,
      password: 'enroll-pass-word',
      log: (message) => {
        if (message.startsWith('join token: ')) {
          capturedToken = message.slice('join token: '.length);
        }
      },
      pollIntervalMs: 1,
      pollRedeemed: async () => {
        const user = auth.userStore.getByUsername('frank');
        if (!user) throw new Error('missing frank');
        const decoded = decodeJoinToken(capturedToken);
        const enrollPk = rootKeyFromSeed(decoded.enrollSk).publicKey;
        const realCert = createNodeCertificate(decoded.enrollSk, {
          uid: user.id,
          edPk: identity.edPublicKey,
          x25519Pk: identity.x25519PublicKey,
          enrollPk,
          now: Date.now(),
          nodeId: randomBytes(16),
        });
        await fakeLocalRedeem(auth, {
          enrollPk,
          certificateBytes: realCert.certificateBytes,
          certSig: realCert.certSig,
          name: 'joined',
        });
        return { certificateBytes: realCert.certificateBytes, certSig: realCert.certSig };
      },
    });
    expect(result.token).toHaveLength(JOIN_TOKEN_CHARS);
    expect(result.joinCommand).toContain('npx tmex-cli hub join');
    expect(result.admitted).toBe(true);
    const user = auth.userStore.getByUsername('frank');
    if (!user) throw new Error('missing frank');
    expect(auth.userStore.listCertsByUser(user.id).length).toBe(2);
  });
});
