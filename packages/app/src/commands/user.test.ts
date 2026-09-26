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
  encodeAddPasskeyPayload,
  encodeBase64url,
  rootKeyFromSeed,
  totpCode,
} from '../../../shared/src/auth';
import { setLang, t } from '../i18n';
import { parseArgs } from '../lib/args';
import { type LocalAuthContext, openLocalAuth } from '../lib/local-auth';
import { deriveRootKey } from '../lib/password';
import { mapPasswdApplyError } from '../lib/user-passwd';
import { runUserAdd, runUserPasswd, runUserTotp } from './user';

const MIGRATIONS = resolve(import.meta.dir, '../../../../apps/gateway/drizzle');
const parsed = parseArgs([]);

function totpIo(password: string) {
  return {
    password,
    log: () => undefined,
    readTotpCode: (secret: Uint8Array) => totpCode(secret, Math.floor(Date.now() / 1000)),
  };
}

function must<T>(value: T | null | undefined, label: string): T {
  if (value == null) throw new Error(`missing ${label}`);
  return value;
}

function lastKeyLogType(auth: LocalAuthContext, userId: string): string {
  const logs = auth.keyLogStore.list(userId);
  const last = logs.at(-1);
  if (!last) throw new Error('empty key log');
  return decodeKeyLogRecord(last.bytes).type;
}

async function addTestPasskey(
  auth: LocalAuthContext,
  username: string,
  password: string
): Promise<void> {
  const user = must(auth.userStore.getByUsername(username), username);
  const rootKey = await deriveRootKey(password, kdfParamsFromJson(user.kdfParamsJson));
  const applied = await auth.userKeys.signAndApply(user.id, rootKey, {
    type: 'add-passkey',
    payload: encodeAddPasskeyPayload({
      credential_id: encodeBase64url(new Uint8Array(16).fill(8)),
      public_key: new Uint8Array(32).fill(1),
      rp_id: 'example.test',
      origin: 'https://example.test',
      counter: 0,
      transports: ['internal'],
      backup_eligible: false,
      backup_state: false,
      device_type: 'singleDevice',
      name: 'laptop',
    }),
  });
  if (!applied.ok) throw new Error(`add-passkey failed: ${applied.error}`);
}

async function openUserAuth(roles = 'node'): Promise<LocalAuthContext> {
  return await openLocalAuth({
    memory: true,
    migrationsFolder: MIGRATIONS,
    env: {
      VIBETERM_MASTER_KEY: process.env.VIBETERM_MASTER_KEY || '',
      VIBETERM_ROLES: roles,
    },
  });
}

const authHandles: LocalAuthContext[] = [];

afterEach(() => {
  setLang('en');
  for (const ctx of authHandles.splice(0)) {
    ctx.close();
  }
});

describe('user commands', () => {
  test('user add writes genesis and self-signed admit-node identity', async () => {
    const auth = await openUserAuth();
    authHandles.push(auth);
    const result = await runUserAdd(parsed, 'alice', {
      auth,
      password: 'vibeterm-test-pass',
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

  test('user passwd defaults to rotate-root-keep and rejects the old password', async () => {
    const auth = await openUserAuth();
    authHandles.push(auth);
    await runUserAdd(parsed, 'bob', {
      auth,
      password: 'old-pass-word',
      log: () => undefined,
    });
    const before = must(auth.userStore.getByUsername('bob'), 'bob');
    const logs: string[] = [];
    const rotated = await runUserPasswd(parsed, 'bob', {
      auth,
      oldPassword: 'old-pass-word',
      newPassword: 'new-pass-word',
      log: (message) => logs.push(message),
    });
    expect(rotated.rootEpoch).toBeGreaterThan(before.rootEpoch);
    expect(rotated.mode).toBe('keep');
    expect(lastKeyLogType(auth, before.id)).toBe('rotate-root-keep');
    expect(logs).toEqual([t('user.passwd.doneKeep', { username: 'bob' })]);

    const after = must(auth.userStore.getByUsername('bob'), 'bob after rotate');
    const oldSeed = await deriveSeed('old-pass-word', kdfParamsFromJson(after.kdfParamsJson));
    expect(bytesEqual(rootKeyFromSeed(oldSeed).publicKey, after.rootPublicKey)).toBe(false);
    const newSeed = await deriveSeed('new-pass-word', kdfParamsFromJson(after.kdfParamsJson));
    expect(bytesEqual(rootKeyFromSeed(newSeed).publicKey, after.rootPublicKey)).toBe(true);

    await expect(
      runUserPasswd(parsed, 'bob', {
        auth,
        oldPassword: 'old-pass-word',
        newPassword: 'another',
        log: () => undefined,
      })
    ).rejects.toThrow(/password does not match/);
  });

  test('user passwd keep re-wraps TOTP and retains passkeys', async () => {
    const auth = await openUserAuth();
    authHandles.push(auth);
    await runUserAdd(parsed, 'bob', {
      auth,
      password: 'old-pass-word',
      log: () => undefined,
    });
    const enrolled = await runUserTotp(parsed, 'bob', {
      auth,
      ...totpIo('old-pass-word'),
    });
    await addTestPasskey(auth, 'bob', 'old-pass-word');
    const before = must(auth.userStore.getByUsername('bob'), 'bob');
    expect(before.totpRecordSeq).not.toBeNull();
    expect(auth.userStore.listKeysByUser(before.id)).toHaveLength(1);

    const rotated = await runUserPasswd(parsed, 'bob', {
      auth,
      oldPassword: 'old-pass-word',
      newPassword: 'new-pass-word',
      log: () => undefined,
    });
    expect(rotated.mode).toBe('keep');
    expect(lastKeyLogType(auth, before.id)).toBe('rotate-root-keep');

    const after = must(auth.userStore.getByUsername('bob'), 'bob after keep');
    expect(auth.userStore.listKeysByUser(after.id)).toHaveLength(1);
    expect(after.totpRecordSeq).toBe(after.keyLogHeadSeq);
    const state = auth.userKeys.currentState(after.id);
    expect(state.totp).toBeTruthy();
    const seed = await deriveSeed('new-pass-word', state.kdfParams);
    const kTotp = deriveTotpKey(seed, after.id, state.rootEpoch);
    const totpSeq = after.totpRecordSeq;
    if (totpSeq == null) throw new Error('missing totp seq');
    const plain = await decryptTotpSecret(kTotp, state.totp!, {
      uid: after.id,
      root_epoch: state.rootEpoch,
      seq: BigInt(totpSeq),
    });
    expect(bytesEqual(plain, enrolled.secret)).toBe(true);
  });

  test('user passwd --full-reset writes rotate-root and clears TOTP and passkeys', async () => {
    const auth = await openUserAuth();
    authHandles.push(auth);
    await runUserAdd(parsed, 'bob', {
      auth,
      password: 'old-pass-word',
      log: () => undefined,
    });
    await runUserTotp(parsed, 'bob', {
      auth,
      ...totpIo('old-pass-word'),
    });
    await addTestPasskey(auth, 'bob', 'old-pass-word');
    const before = must(auth.userStore.getByUsername('bob'), 'bob');
    const logs: string[] = [];
    const rotated = await runUserPasswd(
      parseArgs(['user', 'passwd', 'bob', '--full-reset', '--yes']),
      'bob',
      {
        auth,
        oldPassword: 'old-pass-word',
        newPassword: 'new-pass-word',
        log: (message) => logs.push(message),
      }
    );
    expect(rotated.mode).toBe('full-reset');
    expect(lastKeyLogType(auth, before.id)).toBe('rotate-root');
    expect(logs).toEqual([
      t('mesh.reset.warning'),
      t('user.passwd.doneFullReset', { username: 'bob' }),
    ]);

    const after = must(auth.userStore.getByUsername('bob'), 'bob after full-reset');
    expect(after.totpRecordSeq).toBeNull();
    expect(auth.userKeys.currentState(after.id).totp).toBeNull();
    expect(auth.userStore.listKeysByUser(after.id)).toEqual([]);
    const newSeed = await deriveSeed('new-pass-word', kdfParamsFromJson(after.kdfParamsJson));
    expect(bytesEqual(rootKeyFromSeed(newSeed).publicKey, after.rootPublicKey)).toBe(true);
  });

  test('user passwd maps apply errors without writer-forwarding codes', async () => {
    for (const lang of ['en', 'zh-CN'] as const) {
      setLang(lang);
      expect(mapPasswdApplyError('KEYLOG_TYPE_UNSUPPORTED_BY_NODES')).toBe(
        t('user.passwd.nodesTooOld')
      );
      expect(mapPasswdApplyError('HUB_TIMEOUT')).toBe(
        t('user.passwd.failed', { error: 'HUB_TIMEOUT' })
      );
    }
  });

  test('user totp record decrypts with deriveTotpKey', async () => {
    const auth = await openUserAuth();
    authHandles.push(auth);
    await runUserAdd(parsed, 'carol', {
      auth,
      password: 'totp-pass-word',
      log: () => undefined,
    });
    const enrolled = await runUserTotp(parsed, 'carol', {
      auth,
      ...totpIo('totp-pass-word'),
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

  test('user totp does not write set-totp when the code does not match', async () => {
    const auth = await openUserAuth();
    authHandles.push(auth);
    await runUserAdd(parsed, 'dave', {
      auth,
      password: 'totp-pass-word',
      log: () => undefined,
    });
    const before = must(auth.userStore.getByUsername('dave'), 'dave');
    const logsBefore = auth.keyLogStore.list(before.id).length;
    await expect(
      runUserTotp(parsed, 'dave', {
        auth,
        password: 'totp-pass-word',
        totpCode: '000000',
        log: () => undefined,
      })
    ).rejects.toThrow(/nothing was saved/);
    const after = must(auth.userStore.getByUsername('dave'), 'dave');
    expect(auth.keyLogStore.list(after.id).length).toBe(logsBefore);
    expect(after.totpRecordSeq).toBeNull();
  });

  test('user add refuses an existing username', async () => {
    const auth = await openUserAuth();
    authHandles.push(auth);
    await runUserAdd(parsed, 'alice', {
      auth,
      password: 'vibeterm-test-pass',
      log: () => undefined,
    });
    await expect(
      runUserAdd(parsed, 'alice', {
        auth,
        password: 'other-pass-word',
        log: () => undefined,
      })
    ).rejects.toThrow(/already exists/);
    expect(auth.userStore.getByUsername('alice')).toBeTruthy();
  });
});
