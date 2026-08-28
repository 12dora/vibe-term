import '../lib/test-master-key';
import { afterEach, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { kdfParamsFromJson } from '../../../../apps/gateway/src/auth/user-key-service';
import {
  bytesEqual,
  decodeKeyLogRecord,
  decodeSetTotpPayload,
  decryptTotpSecret,
  deriveSeed,
  deriveTotpKey,
  rootKeyFromSeed,
} from '../../../shared/src/auth';
import { parseArgs } from '../lib/args';
import { type LocalAuthContext, openLocalAuth } from '../lib/local-auth';
import { runHubUserAdd, runHubUserPasswd, runHubUserReset, runHubUserTotp } from './hub';

const MIGRATIONS = resolve(import.meta.dir, '../../../../apps/gateway/drizzle');
const parsed = parseArgs([]);

function must<T>(value: T | null | undefined, label: string): T {
  if (value == null) throw new Error(`missing ${label}`);
  return value;
}

async function openHubAuth(roles = 'hub,node'): Promise<LocalAuthContext> {
  return await openLocalAuth({
    memory: true,
    migrationsFolder: MIGRATIONS,
    env: {
      TMEX_MASTER_KEY: process.env.TMEX_MASTER_KEY || '',
      TMEX_ROLES: roles,
    },
  });
}

const authHandles: LocalAuthContext[] = [];

afterEach(() => {
  for (const ctx of authHandles.splice(0)) {
    ctx.close();
  }
});

describe('hub user commands', () => {
  test('hub user add writes genesis and self-signed admit-node identity', async () => {
    const auth = await openHubAuth();
    authHandles.push(auth);
    const result = await runHubUserAdd(parsed, 'alice', {
      auth,
      password: 'tmex-test-pass',
      log: () => undefined,
    });
    expect(result.userId).toBeTruthy();
    expect(result.fingerprint).toHaveLength(64);
    expect(result.rootEpoch).toBe(1);

    const user = must(auth.userStore.getByUsername('alice'), 'alice');
    const logs = auth.keyLogStore.list(user.id);
    expect(logs.map((row) => row.seq)).toEqual([1, 2]);
    expect(auth.userStore.listCertsByUser(user.id).length).toBe(1);
    const identity = await auth.identityStore.load();
    expect(identity?.nodeId).toBeTruthy();
    expect(identity?.userId).toBe(result.userId);
  });

  test('hub user passwd rotate-root accepts new password and rejects old', async () => {
    const auth = await openHubAuth();
    authHandles.push(auth);
    await runHubUserAdd(parsed, 'bob', {
      auth,
      password: 'old-pass-word',
      log: () => undefined,
    });
    const before = must(auth.userStore.getByUsername('bob'), 'bob');
    const rotated = await runHubUserPasswd(parsed, 'bob', {
      auth,
      oldPassword: 'old-pass-word',
      newPassword: 'new-pass-word',
      log: () => undefined,
    });
    expect(rotated.rootEpoch).toBeGreaterThan(before.rootEpoch);

    const after = must(auth.userStore.getByUsername('bob'), 'bob after rotate');
    const oldSeed = await deriveSeed('old-pass-word', kdfParamsFromJson(after.kdfParamsJson));
    expect(bytesEqual(rootKeyFromSeed(oldSeed).publicKey, after.rootPublicKey)).toBe(false);
    const newSeed = await deriveSeed('new-pass-word', kdfParamsFromJson(after.kdfParamsJson));
    expect(bytesEqual(rootKeyFromSeed(newSeed).publicKey, after.rootPublicKey)).toBe(true);

    await expect(
      runHubUserPasswd(parsed, 'bob', {
        auth,
        oldPassword: 'old-pass-word',
        newPassword: 'another',
        log: () => undefined,
      })
    ).rejects.toThrow(/password does not match/);
  });

  test('hub user totp record decrypts with deriveTotpKey', async () => {
    const auth = await openHubAuth();
    authHandles.push(auth);
    await runHubUserAdd(parsed, 'carol', {
      auth,
      password: 'totp-pass-word',
      log: () => undefined,
    });
    const enrolled = await runHubUserTotp(parsed, 'carol', {
      auth,
      password: 'totp-pass-word',
      log: () => undefined,
    });
    expect(enrolled.uri.startsWith('otpauth://totp/')).toBe(true);

    const user = must(auth.userStore.getByUsername('carol'), 'carol');
    const state = auth.userKeys.currentState(user.id);
    expect(state.totp).toBeTruthy();
    const seed = await deriveSeed('totp-pass-word', state.kdfParams);
    const kTotp = deriveTotpKey(seed, user.id, state.rootEpoch);
    const totpSeq = user.totpRecordSeq;
    if (totpSeq == null) throw new Error('missing totp seq');
    const entry = auth.keyLogStore.getAtSeq(user.id, totpSeq);
    if (!entry) throw new Error('missing totp record');
    const rec = decodeSetTotpPayload(decodeKeyLogRecord(entry.bytes).payload);
    const plain = await decryptTotpSecret(kTotp, rec, {
      uid: user.id,
      root_epoch: state.rootEpoch,
      seq: BigInt(totpSeq),
    });
    expect(bytesEqual(plain, enrolled.secret)).toBe(true);
  });

  test('hub user add refuses an existing username', async () => {
    const auth = await openHubAuth();
    authHandles.push(auth);
    await runHubUserAdd(parsed, 'alice', {
      auth,
      password: 'tmex-test-pass',
      log: () => undefined,
    });
    await expect(
      runHubUserAdd(parsed, 'alice', {
        auth,
        password: 'other-pass-word',
        log: () => undefined,
      })
    ).rejects.toThrow(/already exists/);
    expect(auth.userStore.getByUsername('alice')).toBeTruthy();
  });

  test('hub user reset wipes nodes and enrollment tokens', async () => {
    const auth = await openHubAuth();
    authHandles.push(auth);
    const added = await runHubUserAdd(parsed, 'dave', {
      auth,
      password: 'reset-pass-word',
      log: () => undefined,
    });
    auth.userStore.createNode({
      id: 'aa'.repeat(16),
      userId: added.userId,
      name: 'extra',
      now: Date.now(),
    });
    auth.userStore.createEnrollmentToken({
      id: crypto.randomUUID(),
      userId: added.userId,
      enrollPublicKey: new Uint8Array(32).fill(3),
      authorizationJson: '{}',
      authorizationSig: new Uint8Array(64),
      expiresAt: Date.now() + 60_000,
    });
    const events: string[] = [];
    const wiped = await runHubUserReset(parsed, {
      auth,
      log: () => undefined,
      skipRestart: true,
      stop: async () => {
        events.push('stop');
        expect(auth.userStore.listNodes().length).toBeGreaterThan(0);
      },
      restart: async () => {
        events.push('restart');
        expect(auth.userStore.listNodes()).toEqual([]);
      },
    });
    expect(wiped.wiped).toBeGreaterThan(0);
    expect(events).toEqual(['stop', 'restart']);
    expect(auth.userStore.listNodes()).toEqual([]);
    expect(auth.userStore.listCertsByUser(added.userId).length).toBe(1);
  });
});
