// 密封包刷新：请求体字段、AAD 绑定（用共享的 open 对拍）、失败不抛、根钥/中继模式两道门。

import { beforeEach, describe, expect, test } from 'bun:test';
import type { RecordSigner } from '@/auth/key-log-actions';
import type { AuthApi } from '@tmex/api-client/auth/index';
import type { RelayPackUpload, RelayTenantApi } from '@tmex/api-client/relay/tenant-api';
import { decodeBase64url, encodeBase64url, rootKeyFromSeed } from '@tmex/shared/auth';
import { openRelayPack } from '@tmex/shared/relay';
import { resetMeshRelayStateForTest, setMeshRelayStateForTest } from './mesh-relay';
import {
  clearRelayPackDebtForTest,
  relayPackDebt,
  relayPackDebtDetail,
  rememberRelayPackDebt,
} from './relay-meta-key-pending';
import {
  refreshRelayPack,
  refreshRelayPackForSigner,
  resetRelayPackDedupeForTest,
} from './relay-pack';

const TENANT_A = 'ab'.repeat(16);
const TENANT_B = 'cd'.repeat(16);
const SEED = new Uint8Array(32).fill(9);
const LOG_KEY = new Uint8Array(32).fill(1);
const TOKEN_A = new Uint8Array(32).fill(2);
const TOKEN_B = new Uint8Array(32).fill(4);
const HEAD_HASH = new Uint8Array(32).fill(3);

const KDF_JSON = {
  salt: encodeBase64url(new Uint8Array(16).fill(5)),
  memory_kib: 65536,
  iterations: 3,
  parallelism: 1,
};

function authApi(overrides: Partial<AuthApi> = {}): AuthApi {
  return {
    keyLogHead: () =>
      Promise.resolve({ seq: 7, hash: encodeBase64url(HEAD_HASH), rootEpoch: 2, uid: 'u1' }),
    getMode: () => Promise.resolve({ mode: 'mesh', kdfParams: KDF_JSON }),
    ...overrides,
  } as unknown as AuthApi;
}

function relayApi(uploads: RelayPackUpload[], overrides: Record<string, unknown> = {}) {
  return {
    joinMaterial: () =>
      Promise.resolve({
        logKey: encodeBase64url(LOG_KEY),
        relays: [
          { url: 'https://a.example', tenantId: TENANT_A, token: encodeBase64url(TOKEN_A) },
          { url: 'https://b.example', tenantId: TENANT_B, token: encodeBase64url(TOKEN_B) },
        ],
      }),
    uploadPack: (body: RelayPackUpload) => {
      uploads.push(body);
      return Promise.resolve({ ok: true as const });
    },
    ...overrides,
  } as unknown as RelayTenantApi;
}

describe('refreshRelayPack', () => {
  test('每台中继各一块密封包：租户编号 / 令牌 / AAD 都绑到那一台', async () => {
    const uploads: RelayPackUpload[] = [];
    const outcome = await refreshRelayPack({
      rootSeed: SEED,
      api: authApi(),
      relayApi: relayApi(uploads),
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.failed).toEqual([]);
    expect(uploads).toHaveLength(1);
    const body = uploads[0];
    expect(body.root_epoch).toBe(2);
    expect(body.head_seq).toBe(7);
    expect(body.kdf_params).toEqual(KDF_JSON);
    expect(body.packs.map((row) => row.url)).toEqual(['https://a.example', 'https://b.example']);

    const rootPublicKey = rootKeyFromSeed(SEED).publicKey;
    const first = await openRelayPack({
      rootSeed: SEED,
      tenantId: TENANT_A,
      rootPublicKey,
      rootEpoch: 2,
      sealedPack: decodeBase64url(body.packs[0].sealed_pack),
    });
    expect(first.log_key).toEqual(LOG_KEY);
    expect(first.token).toEqual(TOKEN_A);
    expect(first.head_seq).toBe(7n);
    expect(first.head_hash).toEqual(HEAD_HASH);

    const second = await openRelayPack({
      rootSeed: SEED,
      tenantId: TENANT_B,
      rootPublicKey,
      rootEpoch: 2,
      sealedPack: decodeBase64url(body.packs[1].sealed_pack),
    });
    expect(second.token).toEqual(TOKEN_B);

    // 换一台中继的租户编号就开不出来：KEK 与 AAD 都钉着 tenant_id。
    await expect(
      openRelayPack({
        rootSeed: SEED,
        tenantId: TENANT_B,
        rootPublicKey,
        rootEpoch: 2,
        sealedPack: decodeBase64url(body.packs[0].sealed_pack),
      })
    ).rejects.toThrow();
  });

  test('AAD 绑定 root_epoch：epoch 对不上就开不出来', async () => {
    const uploads: RelayPackUpload[] = [];
    await refreshRelayPack({ rootSeed: SEED, api: authApi(), relayApi: relayApi(uploads) });
    await expect(
      openRelayPack({
        rootSeed: SEED,
        tenantId: TENANT_A,
        rootPublicKey: rootKeyFromSeed(SEED).publicKey,
        rootEpoch: 3,
        sealedPack: decodeBase64url(uploads[0].packs[0].sealed_pack),
      })
    ).rejects.toThrow();
  });

  test('显式给的 kdf 参数 / epoch / 中继子集优先于服务端下发的（改密那一路）', async () => {
    const uploads: RelayPackUpload[] = [];
    const newKdf = { ...KDF_JSON, salt: encodeBase64url(new Uint8Array(16).fill(6)) };
    await refreshRelayPack({
      rootSeed: SEED,
      api: authApi({ getMode: () => Promise.reject(new Error('should not be called')) } as never),
      relayApi: relayApi(uploads),
      kdfParams: newKdf,
      rootEpoch: 3,
      urls: ['https://b.example'],
    });
    expect(uploads[0].kdf_params).toEqual(newKdf);
    expect(uploads[0].root_epoch).toBe(3);
    expect(uploads[0].packs.map((row) => row.url)).toEqual(['https://b.example']);
  });

  test('任何一步失败都只报 ok:false，不抛给主流程', async () => {
    const outcome = await refreshRelayPack({
      rootSeed: SEED,
      api: authApi(),
      relayApi: relayApi([], {
        uploadPack: () => Promise.reject(new Error('RELAY_PACK_FORWARD_FAILED')),
      }),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.transportError).toBe(true);
  });

  test('逐台回执里有一台没成功就不算成功，只报那一台', async () => {
    const outcome = await refreshRelayPack({
      rootSeed: SEED,
      api: authApi(),
      relayApi: relayApi([], {
        uploadPack: () =>
          Promise.resolve({
            ok: true as const,
            results: [
              { url: 'https://a.example', ok: true, status: 200 },
              { url: 'https://b.example', ok: false, status: 502 },
            ],
          }),
      }),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.transportError).toBe(false);
    expect(outcome.requested).toEqual(['https://a.example', 'https://b.example']);
    expect(outcome.failed).toEqual(['https://b.example']);
  });

  test('旧节点不下发 results：按全部成功算（一台都没成的话它回的是 502）', async () => {
    const outcome = await refreshRelayPack({
      rootSeed: SEED,
      api: authApi(),
      relayApi: relayApi([]),
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.failed).toEqual([]);
  });
});

describe('refreshRelayPackForSigner', () => {
  beforeEach(() => {
    clearRelayPackDebtForTest();
    resetMeshRelayStateForTest();
    resetRelayPackDedupeForTest();
  });

  function rootSigner(): RecordSigner {
    return { kind: 'root', rootKey: rootKeyFromSeed(SEED) };
  }

  test('中继模式 + 根钥：刷一次并销掉欠账', async () => {
    setMeshRelayStateForTest({ mode: 'relay' });
    rememberRelayPackDebt();
    const uploads: RelayPackUpload[] = [];
    const outcome = await refreshRelayPackForSigner(rootSigner(), {
      api: authApi(),
      relayApi: relayApi(uploads),
    });
    expect(outcome).toBe('refreshed');
    expect(uploads).toHaveLength(1);
    expect(relayPackDebt()).toBe(false);
  });

  test('通行密钥签的记录跳过：KEK 要根种子，断言给不出', async () => {
    setMeshRelayStateForTest({ mode: 'relay' });
    const uploads: RelayPackUpload[] = [];
    const outcome = await refreshRelayPackForSigner(
      { kind: 'passkey', credentialId: 'c1' },
      { api: authApi(), relayApi: relayApi(uploads) }
    );
    expect(outcome).toBe('skipped');
    expect(uploads).toHaveLength(0);
  });

  test('非中继模式不发任何请求', async () => {
    setMeshRelayStateForTest({ mode: 'hub' });
    const uploads: RelayPackUpload[] = [];
    const outcome = await refreshRelayPackForSigner(rootSigner(), {
      api: authApi(),
      relayApi: relayApi(uploads),
    });
    expect(outcome).toBe('skipped');
    expect(uploads).toHaveLength(0);
  });

  test('同一个日志头只刷一次，头一变就再刷（去重按头，不按根钥对象）', async () => {
    setMeshRelayStateForTest({ mode: 'relay' });
    const uploads: RelayPackUpload[] = [];
    const signer = rootSigner();
    let seq = 7;
    const api = authApi({
      keyLogHead: () =>
        Promise.resolve({ seq, hash: encodeBase64url(HEAD_HASH), rootEpoch: 2, uid: 'u1' }),
    } as never);
    expect(await refreshRelayPackForSigner(signer, { api, relayApi: relayApi(uploads) })).toBe(
      'refreshed'
    );
    expect(await refreshRelayPackForSigner(signer, { api, relayApi: relayApi(uploads) })).toBe(
      'skipped'
    );
    expect(uploads).toHaveLength(1);

    // 又落了一条根签记录：头往前走，同一把根钥必须重封。
    seq = 8;
    expect(await refreshRelayPackForSigner(signer, { api, relayApi: relayApi(uploads) })).toBe(
      'refreshed'
    );
    expect(uploads).toHaveLength(2);
  });

  test('在途的同一个头并到同一次重封，只上传一次', async () => {
    setMeshRelayStateForTest({ mode: 'relay' });
    const uploads: RelayPackUpload[] = [];
    const signer = rootSigner();
    const [first, second] = await Promise.all([
      refreshRelayPackForSigner(signer, { api: authApi(), relayApi: relayApi(uploads) }),
      refreshRelayPackForSigner(signer, { api: authApi(), relayApi: relayApi(uploads) }),
    ]);
    expect([first, second]).toEqual(['refreshed', 'refreshed']);
    expect(uploads).toHaveLength(1);
  });

  test('请求没打通只报 failed，不新记欠账', async () => {
    setMeshRelayStateForTest({ mode: 'relay' });
    const outcome = await refreshRelayPackForSigner(rootSigner(), {
      api: authApi(),
      relayApi: relayApi([], { joinMaterial: () => Promise.reject(new Error('boom')) }),
    });
    expect(outcome).toBe('failed');
    expect(relayPackDebt()).toBe(false);
  });

  test('逐台回执里失败的那台留欠账，成功的那台销账', async () => {
    setMeshRelayStateForTest({ mode: 'relay' });
    rememberRelayPackDebt();
    const outcome = await refreshRelayPackForSigner(rootSigner(), {
      api: authApi(),
      relayApi: relayApi([], {
        uploadPack: () =>
          Promise.resolve({
            ok: true as const,
            results: [
              { url: 'https://a.example', ok: true, status: 200 },
              { url: 'https://b.example', ok: false, status: 502 },
            ],
          }),
      }),
    });
    expect(outcome).toBe('failed');
    expect(relayPackDebtDetail()).toEqual({ all: false, urls: ['https://b.example'] });
  });
});
