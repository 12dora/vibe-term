import { describe, expect, test } from 'bun:test';
import type { RecordSigner } from '@/auth/key-log-actions';
import type { AuthApi } from '@vibeterm/api-client/auth/index';
import {
  decodeBase64url,
  decodeKeyLogRecord,
  decodeLoginPolicyPayload,
  deriveSeed,
  encodeBase64url,
  loginPolicyFromPreset,
  rootKeyFromSeed,
} from '@vibeterm/shared/auth';
import { LOGIN_POLICY_UNCONFIRMED, setLoginPolicyViaKeyLog } from './login-policy-actions';

const KDF = { salt: new Uint8Array(16).fill(0x05), memory_kib: 64, iterations: 1, parallelism: 1 };
const MODE = { uid: 'user-1', rootEpoch: 0 };
const noLock = <T>(run: () => Promise<T>) => run();

async function rootSigner(): Promise<RecordSigner> {
  return { kind: 'root', rootKey: rootKeyFromSeed(await deriveSeed('pw', KDF)) };
}

type Appended = { bytes: string; sig: string };

function authApi(appended: Appended[], result: unknown = { ok: true, hubAck: true }): AuthApi {
  return {
    keyLogHead: () =>
      Promise.resolve({ seq: 4, hash: encodeBase64url(new Uint8Array(32).fill(1)) }),
    appendKeyLog: (body: Appended) => {
      appended.push(body);
      return Promise.resolve(result);
    },
  } as unknown as AuthApi;
}

describe('setLoginPolicyViaKeyLog', () => {
  test('signs a login-policy record carrying the policy', async () => {
    const appended: Appended[] = [];
    const policy = loginPolicyFromPreset('strict', false);
    const result = await setLoginPolicyViaKeyLog(
      { api: authApi(appended), mode: MODE, lock: noLock },
      policy,
      await rootSigner()
    );
    expect(result).toEqual({ ok: true });
    const record = decodeKeyLogRecord(decodeBase64url(appended[0].bytes));
    expect(record.type).toBe('login-policy');
    expect(record.seq).toBe(5n);
    const payload = decodeLoginPolicyPayload(record.payload);
    expect(payload.preset).toBe('strict');
    expect(payload.ip_fail_threshold).toBe(5);
    expect(payload.exempt_local).toBe(false);
  });

  test('rejects an invalid policy before touching the key log', async () => {
    const appended: Appended[] = [];
    const bad = { ...loginPolicyFromPreset('standard'), ipFailThreshold: 99 };
    const result = await setLoginPolicyViaKeyLog(
      { api: authApi(appended), mode: MODE, lock: noLock },
      bad,
      await rootSigner()
    );
    expect(result.ok).toBe(false);
    expect(appended).toHaveLength(0);
  });

  test('server rejection and unconfirmed append surface as codes', async () => {
    const policy = loginPolicyFromPreset('relaxed');
    const rejected = await setLoginPolicyViaKeyLog(
      {
        api: authApi([], { ok: false, code: 'KEYLOG_TYPE_UNSUPPORTED_BY_NODES' }),
        mode: MODE,
        lock: noLock,
      },
      policy,
      await rootSigner()
    );
    expect(rejected).toEqual({ ok: false, code: 'KEYLOG_TYPE_UNSUPPORTED_BY_NODES' });
    const unconfirmed = await setLoginPolicyViaKeyLog(
      { api: authApi([], { ok: true, hubAck: false }), mode: MODE, lock: noLock },
      policy,
      await rootSigner()
    );
    expect(unconfirmed).toEqual({ ok: false, code: LOGIN_POLICY_UNCONFIRMED });
  });
});
