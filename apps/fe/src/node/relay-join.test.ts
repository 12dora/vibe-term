// 中继模式的加入码：join 串 v3 的字段、pending 只落公开字段、地址表来自 join-material。

import { beforeEach, describe, expect, test } from 'bun:test';
import type { RelayTenantApi } from '@tmex/api-client/relay/tenant-api';
import {
  decodeBase64url,
  encodeBase64url,
  rootKeyFromSeed,
  signEd25519,
  verifyEd25519,
} from '@tmex/shared/auth';
import { decodeRelayJoinToken, isRelayJoinToken } from '@tmex/shared/relay';
import type { PendingStorage } from './enrollment';
import { listPendingEnrollments, setPendingStorage } from './enrollment';
import type { HubApi } from './hub-api';
import { RELAY_ENROLLMENT_NO_RELAY, createEnrollmentOnRelay } from './relay-join';

function memoryStorage(): PendingStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

const LOG_KEY = new Uint8Array(32).fill(0x11);
const TOKEN = new Uint8Array(32).fill(0x22);
const ROOT = rootKeyFromSeed(new Uint8Array(32).fill(0x33));
const HEAD_HASH = new Uint8Array(32).fill(0x44);

function relayApiOf(
  relays: Array<{ url: string; tenantId: string }>,
  all: Array<{ url: string; tenantId: string }> = relays
): RelayTenantApi & { scopes: string[] } {
  const scopes: string[] = [];
  const api = {
    scopes,
    joinMaterial: (options: { scope?: string } = {}) => {
      scopes.push(options.scope ?? 'attached');
      const rows = options.scope === 'all' ? all : relays;
      return Promise.resolve({
        logKey: encodeBase64url(LOG_KEY),
        relays: rows.map((relay) => ({ ...relay, token: encodeBase64url(TOKEN) })),
      });
    },
  };
  return api as unknown as RelayTenantApi & { scopes: string[] };
}

function channelOf(calls: unknown[], created: Record<string, unknown> = {}): HubApi {
  return {
    createEnrollment: (body: unknown) => {
      calls.push(body);
      return Promise.resolve({
        ok: true,
        id: 'enr-1',
        expires_at: 1_700_000_600_000,
        ...created,
      });
    },
  } as unknown as HubApi;
}

const SHARED = {
  uid: 'u1',
  rootEpoch: 3,
  signer: { kind: 'root', rootKey: ROOT } as const,
  rootPublicKey: ROOT.publicKey,
  keyLogHeadHash: HEAD_HASH,
  now: 1_700_000_000_000,
};

const RELAY_A = { url: 'https://a.example', tenantId: 'ab'.repeat(16) };
const RELAY_B = { url: 'https://b.example', tenantId: 'cd'.repeat(16) };

describe('createEnrollmentOnRelay', () => {
  beforeEach(() => {
    setPendingStorage(memoryStorage());
  });

  test('拼出 r3 join 串，带上 K_log 与该中继自己的租户凭据', async () => {
    const calls: unknown[] = [];
    const created = await createEnrollmentOnRelay({
      channel: channelOf(calls),
      relayApi: relayApiOf([{ url: 'https://a.example', tenantId: 'ab'.repeat(16) }]),
      uid: 'u1',
      rootEpoch: 3,
      signer: { kind: 'root', rootKey: ROOT },
      rootPublicKey: ROOT.publicKey,
      keyLogHeadHash: HEAD_HASH,
      name: ' laptop ',
      now: 1_700_000_000_000,
    });

    expect(isRelayJoinToken(created.joinToken)).toBe(true);
    const decoded = decodeRelayJoinToken(created.joinToken);
    expect(decoded.logKey).toEqual(LOG_KEY);
    expect(decoded.rootPublicKey).toEqual(ROOT.publicKey);
    expect(decoded.keyLogHeadHash).toEqual(HEAD_HASH);
    // enrollment 只在当前 attach 的中继上，join 串就只带这一条（含它自己的凭据）。
    expect(decoded.relays).toEqual([
      { url: 'https://a.example', tenantId: 'ab'.repeat(16), token: TOKEN },
    ]);
    // join 命令用第一条地址。
    expect(created.hubPublicUrl).toBe('https://a.example');

    // 送到中继通道的 enroll_pk 与 join 串里的 enroll_sk 是同一对钥匙。
    const body = calls[0] as { enroll_pk: string; exp: number };
    const message = new Uint8Array([9, 9, 9]);
    expect(
      verifyEd25519(
        signEd25519(decoded.enrollSk, message),
        message,
        decodeBase64url(body.enroll_pk)
      )
    ).toBe(true);
    expect(body.exp).toBe(1_700_000_600_000);

    // pending 只有公开字段，绝不含私钥或 join 串。
    const pending = listPendingEnrollments();
    expect(pending).toHaveLength(1);
    expect(pending[0].hubEnrollmentId).toBe('enr-1');
    expect(pending[0].name).toBe('laptop');
    expect(JSON.stringify(pending[0])).not.toContain(created.joinToken);
  });

  test('一条中继都没有时直接报错，不建 enrollment', async () => {
    const calls: unknown[] = [];
    await expect(
      createEnrollmentOnRelay({
        channel: channelOf(calls),
        relayApi: relayApiOf([]),
        uid: 'u1',
        rootEpoch: 3,
        signer: { kind: 'root', rootKey: ROOT },
        rootPublicKey: ROOT.publicKey,
        keyLogHeadHash: HEAD_HASH,
      })
    ).rejects.toThrow('relay list is empty');
    expect(calls).toHaveLength(0);
  });
});

describe('createEnrollmentOnRelay 的 fan-out 结果', () => {
  beforeEach(() => {
    setPendingStorage(memoryStorage());
  });

  test('只把 accepted 的中继写进 join 串', async () => {
    const created = await createEnrollmentOnRelay({
      channel: channelOf([], {
        relays: [
          { ...RELAY_A, token: encodeBase64url(TOKEN), accepted: true },
          { ...RELAY_B, accepted: false, error: 'timeout' },
        ],
      }),
      relayApi: relayApiOf([RELAY_A], [RELAY_A, RELAY_B]),
      ...SHARED,
    });

    expect(decodeRelayJoinToken(created.joinToken).relays).toEqual([
      { url: RELAY_A.url, tenantId: RELAY_A.tenantId, token: TOKEN },
    ]);
    expect(created.hubPublicUrl).toBe(RELAY_A.url);
  });

  test('accepted 的那条没带令牌时按地址回查 join-material', async () => {
    const created = await createEnrollmentOnRelay({
      channel: channelOf([], {
        relays: [{ ...RELAY_B, accepted: true }],
      }),
      relayApi: relayApiOf([RELAY_B]),
      ...SHARED,
    });
    expect(decodeRelayJoinToken(created.joinToken).relays).toEqual([
      { url: RELAY_B.url, tenantId: RELAY_B.tenantId, token: TOKEN },
    ]);
  });

  test('一台都没接受：报错并带上逐台原因', async () => {
    const failure = await createEnrollmentOnRelay({
      channel: channelOf([], {
        relays: [
          { ...RELAY_A, accepted: false, error: 'timeout' },
          { ...RELAY_B, accepted: false, error: 'RELAY_QUOTA_NODES' },
        ],
      }),
      relayApi: relayApiOf([RELAY_A]),
      ...SHARED,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error & { code?: string }).code).toBe(RELAY_ENROLLMENT_NO_RELAY);
    expect((failure as Error).message).toContain('timeout');
    expect((failure as Error).message).toContain('RELAY_QUOTA_NODES');
  });

  test('旧形态的地址表：全部当作已接受，令牌从 scope=all 取', async () => {
    const relayApi = relayApiOf([RELAY_A], [RELAY_A, RELAY_B]);
    const created = await createEnrollmentOnRelay({
      channel: channelOf([], { relays: [RELAY_A.url, RELAY_B.url] }),
      relayApi,
      ...SHARED,
    });

    expect(relayApi.scopes).toEqual(['attached', 'all']);
    expect(decodeRelayJoinToken(created.joinToken).relays.map((relay) => relay.url)).toEqual([
      RELAY_A.url,
      RELAY_B.url,
    ]);
  });

  test('旧形态的地址表没超出手头这一份时不再多问一次', async () => {
    const relayApi = relayApiOf([RELAY_A]);
    await createEnrollmentOnRelay({
      channel: channelOf([], { relays: [RELAY_A.url] }),
      relayApi,
      ...SHARED,
    });
    expect(relayApi.scopes).toEqual(['attached']);
  });

  test('旧节点根本不下发 relays：维持原样，只带当前 attach 的那一台', async () => {
    const relayApi = relayApiOf([RELAY_A], [RELAY_A, RELAY_B]);
    const created = await createEnrollmentOnRelay({
      channel: channelOf([]),
      relayApi,
      ...SHARED,
    });
    expect(relayApi.scopes).toEqual(['attached']);
    expect(decodeRelayJoinToken(created.joinToken).relays.map((relay) => relay.url)).toEqual([
      RELAY_A.url,
    ]);
  });
});
