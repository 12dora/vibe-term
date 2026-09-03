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
import { createEnrollmentOnRelay } from './relay-join';

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

function relayApiOf(relays: string[]): RelayTenantApi {
  return {
    joinMaterial: () =>
      Promise.resolve({
        tenantId: 'ab'.repeat(16),
        token: encodeBase64url(TOKEN),
        logKey: encodeBase64url(LOG_KEY),
        relays,
      }),
  } as unknown as RelayTenantApi;
}

function channelOf(calls: unknown[]): HubApi {
  return {
    createEnrollment: (body: unknown) => {
      calls.push(body);
      return Promise.resolve({ ok: true, id: 'enr-1', expires_at: 1_700_000_600_000 });
    },
  } as unknown as HubApi;
}

describe('createEnrollmentOnRelay', () => {
  beforeEach(() => {
    setPendingStorage(memoryStorage());
  });

  test('拼出 r3 join 串，带上 K_log / 租户令牌 / 地址表', async () => {
    const calls: unknown[] = [];
    const created = await createEnrollmentOnRelay({
      channel: channelOf(calls),
      relayApi: relayApiOf(['https://a.example', 'https://b.example']),
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
    expect(decoded.tenantId).toBe('ab'.repeat(16));
    expect(decoded.logKey).toEqual(LOG_KEY);
    expect(decoded.token).toEqual(TOKEN);
    expect(decoded.rootPublicKey).toEqual(ROOT.publicKey);
    expect(decoded.keyLogHeadHash).toEqual(HEAD_HASH);
    expect(decoded.relayUrls).toEqual(['https://a.example', 'https://b.example']);
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
