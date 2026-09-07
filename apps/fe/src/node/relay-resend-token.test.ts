// 重发中继令牌：prepare 的 payload 原样签成 set-relays、全程在写锁里、
// 以及「中继没确认」必须当失败上报（E2 审计 F3：CLI 那边正是这里报成功坑了人）。

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
} from '@vibeterm/shared/auth';
import { alreadyLocked } from './relay-enroll';
import { RELAY_TOKEN_NOT_ACKED, resendRelayToken } from './relay-resend-token';

const KDF = {
  salt: encodeBase64url(new Uint8Array(16).fill(0x05)),
  memory_kib: 64,
  iterations: 1,
  parallelism: 1,
};

const PAYLOAD = encodeBase64url(new Uint8Array([9, 8, 7]));

async function rootSigner(): Promise<RecordSigner> {
  const seed = await deriveSeed('pw', {
    salt: decodeBase64url(KDF.salt),
    memory_kib: KDF.memory_kib,
    iterations: KDF.iterations,
    parallelism: KDF.parallelism,
  });
  return { kind: 'root', rootKey: rootKeyFromSeed(seed) };
}

type Appended = { bytes: string; sig: string; hubSync?: boolean };

function authApi(appended: Appended[], result: unknown = { ok: true, relayAck: true }): AuthApi {
  return {
    keyLogHead: () =>
      Promise.resolve({ seq: 11, hash: encodeBase64url(new Uint8Array(32).fill(3)) }),
    appendKeyLog: (body: { bytes: string; sig: string }, opts?: { hubSync?: boolean }) => {
      appended.push({ ...body, hubSync: opts?.hubSync });
      return Promise.resolve(result);
    },
  } as unknown as AuthApi;
}

function relayApi(prepare: () => Promise<unknown>): RelayTenantApi {
  return { resendTokenPrepare: prepare } as unknown as RelayTenantApi;
}

const preparedOk = () =>
  Promise.resolve({ payload: PAYLOAD, payloadHash: 'h', metaEpoch: 2, nodes: 4 });

const mode = { uid: 'u1', rootEpoch: 3, kdfParams: KDF };

describe('resendRelayToken', () => {
  test('把 prepare 的 payload 签成 set-relays，走 hub=sync，并报出覆盖的节点数', async () => {
    const appended: Appended[] = [];
    let locked = 0;
    const result = await resendRelayToken(
      {
        api: authApi(appended),
        relayApi: relayApi(preparedOk),
        mode,
        lock: (run) => {
          locked += 1;
          return run();
        },
      },
      await rootSigner()
    );
    expect(result).toEqual({ ok: true, nodes: 4 });
    expect(locked).toBe(1);
    expect(appended[0].hubSync).toBe(true);
    const record = decodeKeyLogRecord(decodeBase64url(appended[0].bytes));
    expect(record.type).toBe('set-relays');
    expect(record.payload).toEqual(new Uint8Array([9, 8, 7]));
    expect(Number(record.seq)).toBe(12);
  });

  test('prepare 与签名 / 提交同在一把锁里', async () => {
    const order: string[] = [];
    await resendRelayToken(
      {
        api: authApi([]),
        relayApi: relayApi(() => {
          order.push('prepare');
          return preparedOk();
        }),
        mode,
        lock: async (run) => {
          order.push('lock');
          const value = await run();
          order.push('unlock');
          return value;
        },
      },
      await rootSigner()
    );
    expect(order).toEqual(['lock', 'prepare', 'unlock']);
  });

  test('中继没确认时报 RELAY_TOKEN_NOT_ACKED 并带出上联错误', async () => {
    const result = await resendRelayToken(
      {
        api: authApi([], { ok: true, relayAck: false, relayError: 'offline' }),
        relayApi: relayApi(preparedOk),
        mode,
        lock: alreadyLocked,
      },
      await rootSigner()
    );
    expect(result).toEqual({ ok: false, code: RELAY_TOKEN_NOT_ACKED, relayError: 'offline' });
  });

  test('中继没确认也没给原因时不编造 relayError', async () => {
    const result = await resendRelayToken(
      {
        api: authApi([], { ok: true, relayAck: false }),
        relayApi: relayApi(preparedOk),
        mode,
        lock: alreadyLocked,
      },
      await rootSigner()
    );
    expect(result).toEqual({ ok: false, code: RELAY_TOKEN_NOT_ACKED });
  });

  test('prepare 失败时原样透出中继错误码，一条记录都不签', async () => {
    const appended: Appended[] = [];
    const result = await resendRelayToken(
      {
        api: authApi(appended),
        relayApi: relayApi(() =>
          Promise.reject(new RelayApiError('NO_ADMITTED_NODES', 'no members', 409))
        ),
        mode,
        lock: alreadyLocked,
      },
      await rootSigner()
    );
    expect(result).toEqual({ ok: false, code: 'NO_ADMITTED_NODES' });
    expect(appended).toEqual([]);
  });

  test('append 被拒时原样透出 code', async () => {
    const result = await resendRelayToken(
      {
        api: authApi([], { ok: false, code: 'KEY_LOG_FORK' }),
        relayApi: relayApi(preparedOk),
        mode,
        lock: alreadyLocked,
      },
      await rootSigner()
    );
    expect(result).toEqual({ ok: false, code: 'KEY_LOG_FORK' });
  });
});
