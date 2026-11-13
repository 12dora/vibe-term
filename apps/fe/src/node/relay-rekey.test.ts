// 吊销之后刷新中继令牌：对每条已配置的中继重走接入（root 签 proof → enroll → set-relays）。

import { describe, expect, test } from 'bun:test';
import type { RecordSigner } from '@/auth/key-log-actions';
import type { AuthApi } from '@vibeterm/api-client/auth/index';
import { RelayApiError } from '@vibeterm/api-client/relay/admin-api';
import type { RelayTenantApi } from '@vibeterm/api-client/relay/tenant-api';
import {
  decodeBase64url,
  decodeKeyLogRecord,
  deriveSeed,
  encodeBase64url,
  rootKeyFromSeed,
  verifyEd25519,
} from '@vibeterm/shared/auth';
import { alreadyLocked } from './relay-enroll';
import { RELAY_REKEY_NEEDS_ROOT, rekeyRelays } from './relay-rekey';

const KDF_JSON = {
  salt: encodeBase64url(new Uint8Array(16).fill(0x05)),
  memory_kib: 64,
  iterations: 1,
  parallelism: 1,
};

async function rootKeyOf(password: string) {
  return rootKeyFromSeed(
    await deriveSeed(password, {
      salt: decodeBase64url(KDF_JSON.salt),
      memory_kib: KDF_JSON.memory_kib,
      iterations: KDF_JSON.iterations,
      parallelism: KDF_JSON.parallelism,
    })
  );
}

const PAYLOAD = encodeBase64url(new Uint8Array([1, 2, 3]));
const URL_A = 'https://relay-a.example.com';
const URL_B = 'https://relay-b.example.com';

type Appended = { bytes: string; sig: string };

function authApi(appended: Appended[]): AuthApi {
  return {
    keyLogHead: () =>
      Promise.resolve({ seq: 4, hash: encodeBase64url(new Uint8Array(32).fill(7)) }),
    appendKeyLog: (body: Appended) => {
      appended.push(body);
      return Promise.resolve({ ok: true, hubAck: true });
    },
  } as unknown as AuthApi;
}

interface Calls {
  enroll: Array<{
    url: string;
    password: string | null;
    proof: { bytes: string; sig: string };
    force_rotate?: boolean;
  }>;
  passwordLookups: string[];
}

function relayApiOf(options: {
  urls: string[];
  mode?: 'relay' | 'none';
  rootPublicKey: string;
  passwords?: Record<string, string | null>;
  failEnroll?: Record<string, string>;
  statusError?: Error;
}): { api: RelayTenantApi; calls: Calls } {
  const calls: Calls = { enroll: [], passwordLookups: [] };
  const api = {
    status: () =>
      options.statusError
        ? Promise.reject(options.statusError)
        : Promise.resolve({
            mode: options.mode ?? 'relay',
            relays: options.urls.map((url, priority) => ({ url, priority })),
          }),
    enrollPassword: (url: string) => {
      calls.passwordLookups.push(url);
      return Promise.resolve({
        known: true,
        password: options.passwords?.[url] ?? null,
        passwordEpoch: 1,
      });
    },
    proofMaterial: (url: string) =>
      Promise.resolve({
        url,
        relayHost: new URL(url).host,
        ts: 1_700_000_000_000,
        maxSkewMs: 300_000,
        rootPublicKey: options.rootPublicKey,
        rootEpoch: 3,
      }),
    readmitPrepare: () => Promise.resolve({ rootEpoch: 3, entries: [] }),
    enroll: (body: Calls['enroll'][number]) => {
      calls.enroll.push(body);
      const code = options.failEnroll?.[body.url];
      if (code) return Promise.reject(new RelayApiError(code, code, 401));
      return Promise.resolve({
        tenantId: 'cd'.repeat(16),
        token: 'dA',
        passwordEpoch: 1,
        payload: PAYLOAD,
        payloadHash: 'h',
      });
    },
  } as unknown as RelayTenantApi;
  return { api, calls };
}

async function setup(options: Omit<Parameters<typeof relayApiOf>[0], 'rootPublicKey'>) {
  const rootKey = await rootKeyOf('pw');
  const rootPublicKey = encodeBase64url(rootKey.publicKey);
  const appended: Appended[] = [];
  const { api, calls } = relayApiOf({ ...options, rootPublicKey });
  const deps = {
    api: authApi(appended),
    relayApi: api,
    mode: { uid: 'u1', rootEpoch: 3, kdfParams: KDF_JSON, rootPublicKey },
    lock: alreadyLocked,
  };
  const signer: RecordSigner = { kind: 'root', rootKey };
  return { deps, signer, appended, calls, rootKey };
}

describe('rekeyRelays', () => {
  test('每条中继各走一遍接入：根钥签 proof、带已存的接入密码、各提交一条 set-relays', async () => {
    const { deps, signer, appended, calls, rootKey } = await setup({
      urls: [URL_A, URL_B],
      passwords: { [URL_A]: 'relay-pw' },
    });
    expect(await rekeyRelays(deps, signer)).toEqual({ ok: true });

    expect(calls.enroll.map((row) => row.url)).toEqual([URL_A, URL_B]);
    expect(calls.enroll.map((row) => row.password)).toEqual(['relay-pw', null]);
    expect(calls.enroll.map((row) => row.force_rotate)).toEqual([true, true]);
    for (const row of calls.enroll) {
      expect(
        verifyEd25519(
          decodeBase64url(row.proof.sig),
          decodeBase64url(row.proof.bytes),
          rootKey.publicKey
        )
      ).toBe(true);
    }
    expect(appended.map((row) => decodeKeyLogRecord(decodeBase64url(row.bytes)).type)).toEqual([
      'set-relays',
      'set-relays',
    ]);
  });

  test('非中继模式：什么都不发', async () => {
    const { deps, signer, appended, calls } = await setup({ urls: [], mode: 'none' });
    expect(await rekeyRelays(deps, signer)).toEqual({ ok: true });
    expect(calls.enroll).toEqual([]);
    expect(appended).toEqual([]);
  });

  test('旧节点没有中继路由（404）：无事可做', async () => {
    const { deps, signer, calls } = await setup({
      urls: [],
      statusError: new RelayApiError('NOT_FOUND', 'not found', 404),
    });
    expect(await rekeyRelays(deps, signer)).toEqual({ ok: true });
    expect(calls.enroll).toEqual([]);
  });

  test('读不到中继列表：报错且不静默跳过', async () => {
    const { deps, signer } = await setup({
      urls: [],
      statusError: new RelayApiError('RELAY_UNREACHABLE', 'unreachable', 502),
    });
    expect(await rekeyRelays(deps, signer)).toEqual({
      ok: false,
      code: 'RELAY_UNREACHABLE',
      urls: [],
    });
  });

  test('通行密钥签名者：签不出 proof，一个请求都不发，带回待刷新的地址', async () => {
    const { deps, appended, calls } = await setup({ urls: [URL_A, URL_B] });
    const passkey: RecordSigner = { kind: 'passkey', credentialId: 'cred' };
    expect(await rekeyRelays(deps, passkey)).toEqual({
      ok: false,
      code: RELAY_REKEY_NEEDS_ROOT,
      urls: [URL_A, URL_B],
    });
    expect(calls.enroll).toEqual([]);
    expect(appended).toEqual([]);
  });

  test('单条失败不拦后面几条，失败地址带回；重试只做失败的那条', async () => {
    const { deps, signer, appended, calls } = await setup({
      urls: [URL_A, URL_B],
      failEnroll: { [URL_A]: 'RELAY_PASSWORD_REQUIRED' },
    });
    expect(await rekeyRelays(deps, signer)).toEqual({
      ok: false,
      code: 'RELAY_PASSWORD_REQUIRED',
      urls: [URL_A],
    });
    expect(calls.enroll.map((row) => row.url)).toEqual([URL_A, URL_B]);
    expect(appended).toHaveLength(1);

    const retry = await setup({ urls: [URL_A, URL_B] });
    expect(await rekeyRelays(retry.deps, retry.signer, [URL_A])).toEqual({ ok: true });
    expect(retry.calls.enroll.map((row) => row.url)).toEqual([URL_A]);
  });
});
