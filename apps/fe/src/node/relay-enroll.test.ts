// 中继流程：记录类型 / 锁的用法 / proof 由根钥签 / 密码错不发任何请求 / 错误码透传。

import { describe, expect, test } from 'bun:test';
import type { RecordSigner } from '@/auth/key-log-actions';
import type { AuthApi } from '@tmex/api-client/auth/index';
import { RelayApiError } from '@tmex/api-client/relay/admin-api';
import type { RelayTenantApi } from '@tmex/api-client/relay/tenant-api';
import {
  DOMAIN_AUTHORIZATION,
  decodeBase64url,
  decodeKeyLogRecord,
  deriveSeed,
  encodeAuthorization,
  encodeBase64url,
  rootKeyFromSeed,
  verifyEd25519,
} from '@tmex/shared/auth';
import { decodeRelayEnrollProof } from '@tmex/shared/relay';
import { READMIT_PENDING } from './readmit-members';
import {
  ROOT_PASSWORD_INVALID,
  alreadyLocked,
  appendMetaKey,
  appendRelayRecord,
  enrollRelay,
  leaveRelay,
  removeRelay,
  resendRelayRecord,
} from './relay-enroll';

// 单测用便宜的 argon2 参数（真实参数 64 MiB / t=3 太慢）。
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

type Appended = { bytes: string; sig: string; hubSync?: boolean };

function authApi(appended: Appended[], result: unknown = { ok: true, hubAck: true }): AuthApi {
  return {
    keyLogHead: () =>
      Promise.resolve({ seq: 4, hash: encodeBase64url(new Uint8Array(32).fill(7)) }),
    appendKeyLog: (body: { bytes: string; sig: string }, opts?: { hubSync?: boolean }) => {
      appended.push({ ...body, hubSync: opts?.hubSync });
      return Promise.resolve(result);
    },
  } as unknown as AuthApi;
}

const PAYLOAD = encodeBase64url(new Uint8Array([1, 2, 3]));

/** 没有陈旧成员：接入流程照样会问一次 prepare，回空表即无操作。 */
const noStaleMembers = () => Promise.resolve({ rootEpoch: 3, entries: [] });

async function rootSigner(password = 'pw'): Promise<RecordSigner> {
  return { kind: 'root', rootKey: await rootKeyOf(password) };
}

async function modeOf(password = 'pw') {
  const rootKey = await rootKeyOf(password);
  return {
    uid: 'u1',
    rootEpoch: 3,
    kdfParams: KDF_JSON,
    rootPublicKey: encodeBase64url(rootKey.publicKey),
  };
}

describe('appendRelayRecord', () => {
  test('签出的是 set-relays 记录，走 hub=sync，并且在锁里跑', async () => {
    const appended: Appended[] = [];
    let locked = 0;
    const result = await appendRelayRecord(
      {
        api: authApi(appended),
        relayApi: {} as RelayTenantApi,
        mode: await modeOf(),
        lock: (run) => {
          locked += 1;
          return run();
        },
      },
      { type: 'set-relays', payload: PAYLOAD, signer: await rootSigner() }
    );
    expect(result).toEqual({ ok: true });
    expect(locked).toBe(1);
    expect(appended[0].hubSync).toBe(true);
    const record = decodeKeyLogRecord(decodeBase64url(appended[0].bytes));
    expect(record.type).toBe('set-relays');
    expect(record.payload).toEqual(new Uint8Array([1, 2, 3]));
    expect(Number(record.seq)).toBe(5);
  });

  test('hubAck 明确为 false 时报未确认', async () => {
    const appended: Appended[] = [];
    const result = await appendRelayRecord(
      {
        api: authApi(appended, { ok: true, hubAck: false, hubError: 'RELAY_OFFLINE' }),
        relayApi: {} as RelayTenantApi,
        mode: await modeOf(),
        lock: alreadyLocked,
      },
      { type: 'meta-key', payload: PAYLOAD, signer: await rootSigner() }
    );
    expect(result).toMatchObject({ ok: false, code: 'RELAY_OFFLINE' });
    // 上级没确认时本地 head 没动：签好的字节要原样带出来供重发。
    expect(result.ok === false && result.record?.type).toBe('meta-key');
  });

  test('append 被拒时原样带出 code', async () => {
    const result = await appendRelayRecord(
      {
        api: authApi([], { ok: false, code: 'KEY_LOG_FORK' }),
        relayApi: {} as RelayTenantApi,
        mode: await modeOf(),
        lock: alreadyLocked,
      },
      { type: 'meta-key', payload: PAYLOAD, signer: await rootSigner() }
    );
    expect(result).toEqual({ ok: false, code: 'KEY_LOG_FORK' });
  });
});

describe('appendMetaKey', () => {
  test('prepare 的 op 原样送出，payload 包成 meta-key 记录', async () => {
    const appended: Appended[] = [];
    const ops: unknown[] = [];
    const relayApi = {
      metaKeyPrepare: (op: unknown) => {
        ops.push(op);
        return Promise.resolve({ payload: PAYLOAD, payloadHash: 'h' });
      },
    } as unknown as RelayTenantApi;
    const result = await appendMetaKey(
      { api: authApi(appended), relayApi, mode: await modeOf(), lock: alreadyLocked },
      { op: 'rotate', exclude: ['cd'.repeat(16)] },
      await rootSigner()
    );
    expect(result).toEqual({ ok: true });
    expect(ops).toEqual([{ op: 'rotate', exclude: ['cd'.repeat(16)] }]);
    expect(decodeKeyLogRecord(decodeBase64url(appended[0].bytes)).type).toBe('meta-key');
  });

  test('prepare 与取 head / 签名 / append 同在一把锁里', async () => {
    // 两条 admit 补发并行时，prepare 各拿一次「当前世代 + 1」，后落账的那条必然
    // `relay_epoch_regression`——prepare 必须进锁。
    const order: string[] = [];
    const relayApi = {
      metaKeyPrepare: () => {
        order.push('prepare');
        return Promise.resolve({ payload: PAYLOAD, payloadHash: 'h' });
      },
    } as unknown as RelayTenantApi;
    await appendMetaKey(
      {
        api: authApi([]),
        relayApi,
        mode: await modeOf(),
        lock: async (run) => {
          order.push('lock:in');
          const value = await run();
          order.push('lock:out');
          return value;
        },
      },
      { op: 'rotate' },
      await rootSigner()
    );
    expect(order).toEqual(['lock:in', 'prepare', 'lock:out']);
  });

  test('prepare 失败时不签任何记录，错误码透传', async () => {
    const appended: Appended[] = [];
    const relayApi = {
      metaKeyPrepare: () => Promise.reject(new RelayApiError('NO_ADMITTED_NODES', 'none', 409)),
    } as unknown as RelayTenantApi;
    const result = await appendMetaKey(
      { api: authApi(appended), relayApi, mode: await modeOf(), lock: alreadyLocked },
      { op: 'admit', node_id: 'ab'.repeat(16) },
      await rootSigner()
    );
    expect(result).toEqual({ ok: false, code: 'NO_ADMITTED_NODES' });
    expect(appended).toHaveLength(0);
  });
});

describe('enrollRelay', () => {
  test('proof 由根钥签且绑定 relayHost，随后签一条 set-relays', async () => {
    const appended: Appended[] = [];
    const mode = await modeOf();
    const calls: Record<string, unknown> = {};
    const relayApi = {
      proofMaterial: (url: string) => {
        calls.url = url;
        return Promise.resolve({
          url: 'https://r.example',
          relayHost: 'r.example',
          ts: 1_700_000_000_000,
          maxSkewMs: 300_000,
          rootPublicKey: mode.rootPublicKey,
          rootEpoch: 3,
        });
      },
      readmitPrepare: noStaleMembers,
      enroll: (body: unknown) => {
        calls.enroll = body;
        return Promise.resolve({
          tenantId: 'cd'.repeat(16),
          token: 'dA',
          passwordEpoch: 1,
          metaEpoch: 1,
          payload: PAYLOAD,
          payloadHash: 'h',
        });
      },
    } as unknown as RelayTenantApi;

    const result = await enrollRelay(
      { api: authApi(appended), relayApi, mode, lock: alreadyLocked },
      { url: 'https://r.example/', password: 'relay-pw', rootPassword: 'pw' }
    );
    expect(result).toEqual({ ok: true });

    const body = calls.enroll as {
      url: string;
      password: string;
      proof: { bytes: string; sig: string };
    };
    expect(body.url).toBe('https://r.example');
    expect(body.password).toBe('relay-pw');
    const proof = decodeRelayEnrollProof(decodeBase64url(body.proof.bytes));
    expect(proof.relay_host).toBe('r.example');
    expect(proof.domain).toBe('tmex/relay-enroll/v1');
    const rootKey = await rootKeyOf('pw');
    expect(
      verifyEd25519(
        decodeBase64url(body.proof.sig),
        decodeBase64url(body.proof.bytes),
        rootKey.publicKey
      )
    ).toBe(true);
    expect(decodeKeyLogRecord(decodeBase64url(appended[0].bytes)).type).toBe('set-relays');
  });

  test('根密码不对时一个请求都不发', async () => {
    const appended: Appended[] = [];
    let touched = 0;
    const relayApi = {
      proofMaterial: () => {
        touched += 1;
        return Promise.reject(new Error('should not be called'));
      },
    } as unknown as RelayTenantApi;
    const result = await enrollRelay(
      { api: authApi(appended), relayApi, mode: await modeOf('pw'), lock: alreadyLocked },
      { url: 'https://r.example', rootPassword: 'wrong' }
    );
    expect(result).toEqual({ ok: false, code: ROOT_PASSWORD_INVALID });
    expect(touched).toBe(0);
    expect(appended).toHaveLength(0);
  });

  test('afterEnroll 在 set-relays 落账后、根钥清零前跑，拿到的是活的根种子', async () => {
    const appended: Appended[] = [];
    const mode = await modeOf();
    const relayApi = {
      proofMaterial: () =>
        Promise.resolve({
          url: 'https://r.example',
          relayHost: 'r.example',
          ts: 1_700_000_000_000,
          maxSkewMs: 300_000,
          rootPublicKey: mode.rootPublicKey,
          rootEpoch: 3,
        }),
      readmitPrepare: noStaleMembers,
      enroll: () =>
        Promise.resolve({
          tenantId: 'cd'.repeat(16),
          token: 'dA',
          passwordEpoch: 1,
          payload: PAYLOAD,
          payloadHash: 'h',
        }),
    } as unknown as RelayTenantApi;
    const seen: { records: number; live: boolean }[] = [];
    const result = await enrollRelay(
      { api: authApi(appended), relayApi, mode, lock: alreadyLocked },
      {
        url: 'https://r.example',
        rootPassword: 'pw',
        afterEnroll: (rootKey) =>
          void seen.push({
            records: appended.length,
            live: rootKey.seed.some((byte) => byte !== 0),
          }),
      }
    );
    expect(result).toEqual({ ok: true });
    expect(seen).toEqual([{ records: 1, live: true }]);
  });

  test('接入失败时不跑 afterEnroll', async () => {
    const mode = await modeOf();
    const relayApi = {
      proofMaterial: () =>
        Promise.resolve({
          url: 'https://r.example',
          relayHost: 'r.example',
          ts: 1_700_000_000_000,
          maxSkewMs: 300_000,
          rootPublicKey: mode.rootPublicKey,
          rootEpoch: 3,
        }),
      readmitPrepare: noStaleMembers,
      enroll: () => Promise.reject(new RelayApiError('RELAY_QUOTA_NODES', 'full', 409)),
    } as unknown as RelayTenantApi;
    let ran = 0;
    const result = await enrollRelay(
      { api: authApi([]), relayApi, mode, lock: alreadyLocked },
      {
        url: 'https://r.example',
        rootPassword: 'pw',
        afterEnroll: () => {
          ran += 1;
        },
      }
    );
    expect(result).toEqual({ ok: false, code: 'RELAY_QUOTA_NODES' });
    expect(ran).toBe(0);
  });

  test('中继口令错时把 code 带出来', async () => {
    const mode = await modeOf();
    const relayApi = {
      proofMaterial: () =>
        Promise.resolve({
          url: 'https://r.example',
          relayHost: 'r.example',
          ts: Date.now(),
          maxSkewMs: 300_000,
          rootPublicKey: mode.rootPublicKey,
          rootEpoch: 3,
        }),
      readmitPrepare: noStaleMembers,
      enroll: () =>
        Promise.reject(new RelayApiError('RELAY_PASSWORD_INVALID', 'bad password', 401)),
    } as unknown as RelayTenantApi;
    const result = await enrollRelay(
      { api: authApi([]), relayApi, mode, lock: alreadyLocked },
      { url: 'https://r.example', rootPassword: 'pw' }
    );
    expect(result).toEqual({ ok: false, code: 'RELAY_PASSWORD_INVALID' });
  });
});

describe('leaveRelay', () => {
  test('走 leave/prepare 并签一条 set-relays', async () => {
    const appended: Appended[] = [];
    let prepared = 0;
    const relayApi = {
      leavePrepare: () => {
        prepared += 1;
        return Promise.resolve({ payload: PAYLOAD, payloadHash: 'h' });
      },
    } as unknown as RelayTenantApi;
    const result = await leaveRelay(
      { api: authApi(appended), relayApi, mode: await modeOf(), lock: alreadyLocked },
      await rootSigner()
    );
    expect(result).toEqual({ ok: true });
    expect(prepared).toBe(1);
    expect(decodeKeyLogRecord(decodeBase64url(appended[0].bytes)).type).toBe('set-relays');
  });
});

describe('removeRelay', () => {
  test('走 remove/prepare 并签一条 set-relays，prepare 也在锁里', async () => {
    const appended: Appended[] = [];
    const order: string[] = [];
    const relayApi = {
      removePrepare: (url: string) => {
        order.push(`prepare:${url}`);
        return Promise.resolve({ payload: PAYLOAD, payloadHash: 'h' });
      },
    } as unknown as RelayTenantApi;
    const result = await removeRelay(
      {
        api: authApi(appended),
        relayApi,
        mode: await modeOf(),
        lock: async (run) => {
          order.push('lock:in');
          const value = await run();
          order.push('lock:out');
          return value;
        },
      },
      'https://relay-2.example',
      await rootSigner()
    );
    expect(result).toEqual({ ok: true });
    expect(order).toEqual(['lock:in', 'prepare:https://relay-2.example', 'lock:out']);
    expect(decodeKeyLogRecord(decodeBase64url(appended[0].bytes)).type).toBe('set-relays');
  });

  test('RELAY_LAST 原样透传成 code', async () => {
    const relayApi = {
      removePrepare: () => Promise.reject(new RelayApiError('RELAY_LAST', 'RELAY_LAST', 409)),
    } as unknown as RelayTenantApi;
    const result = await removeRelay(
      { api: authApi([]), relayApi, mode: await modeOf(), lock: alreadyLocked },
      'https://relay.example',
      await rootSigner()
    );
    expect(result).toEqual({ ok: false, code: 'RELAY_LAST' });
  });
});

describe('resendRelayRecord', () => {
  test('原样重发存下来的字节，不重新取 head 也不重签', async () => {
    const appended: Appended[] = [];
    const api = authApi(appended);
    const signed = { type: 'meta-key' as const, bytes: 'YWJj', sig: 'ZGVm' };
    const result = await resendRelayRecord(
      { api, relayApi: {} as RelayTenantApi, mode: await modeOf(), lock: alreadyLocked },
      signed
    );
    expect(result).toEqual({ ok: true });
    expect(appended).toEqual([{ bytes: 'YWJj', sig: 'ZGVm', hubSync: true }]);
  });
});

describe('接入时补签成员', () => {
  function readmitEntry() {
    return {
      nodeId: 'ab'.repeat(8),
      name: 'node-1',
      admitSeq: 3,
      admitRootEpoch: 1,
      authorization_bytes: encodeBase64url(
        encodeAuthorization({
          domain: DOMAIN_AUTHORIZATION,
          uid: 'u1',
          enroll_pk: new Uint8Array(32).fill(9),
          exp: 1_700_000_000_000n,
          root_epoch: 1,
          signer: 'root',
          credential_id: null,
        })
      ),
      certificate_bytes: encodeBase64url(new Uint8Array([1, 2, 3])),
      cert_sig: encodeBase64url(new Uint8Array(64).fill(4)),
    };
  }

  function enrollApi(
    mode: { rootPublicKey: string },
    options: {
      readmitRequired?: number;
      readmitPrepare?: () => Promise<{ rootEpoch: number; entries: unknown[] }>;
      trace?: string[];
    } = {}
  ): RelayTenantApi {
    const trace = options.trace ?? [];
    return {
      proofMaterial: () => {
        trace.push('proof-material');
        return Promise.resolve({
          url: 'https://r.example',
          relayHost: 'r.example',
          ts: 1_700_000_000_000,
          maxSkewMs: 300_000,
          rootPublicKey: mode.rootPublicKey,
          rootEpoch: 3,
        });
      },
      enroll: () => {
        trace.push('enroll');
        return Promise.resolve({
          tenantId: 'cd'.repeat(16),
          token: 'dA',
          passwordEpoch: 1,
          payload: PAYLOAD,
          payloadHash: 'h',
          readmitRequired: options.readmitRequired ?? 0,
        });
      },
      readmitPrepare: () => {
        trace.push('readmit-prepare');
        const fallback = () => Promise.resolve({ rootEpoch: 3, entries: [readmitEntry()] });
        return (options.readmitPrepare ?? fallback)();
      },
    } as unknown as RelayTenantApi;
  }

  test('补签在换发令牌之前：先 readmit-node 落账，才去 proof-material / enroll', async () => {
    const appended: Appended[] = [];
    const trace: string[] = [];
    const mode = await modeOf();
    const result = await enrollRelay(
      { api: authApi(appended), relayApi: enrollApi(mode, { trace }), mode, lock: alreadyLocked },
      { url: 'https://r.example', rootPassword: 'pw' }
    );
    expect(result).toEqual({ ok: true });
    expect(trace).toEqual(['readmit-prepare', 'proof-material', 'enroll']);
    expect(appended.map((row) => decodeKeyLogRecord(decodeBase64url(row.bytes)).type)).toEqual([
      'readmit-node',
      'set-relays',
    ]);
  });

  test('没有陈旧成员：prepare 回空表，直接接入', async () => {
    const appended: Appended[] = [];
    const trace: string[] = [];
    const mode = await modeOf();
    const relayApi = enrollApi(mode, {
      trace,
      readmitPrepare: () => Promise.resolve({ rootEpoch: 3, entries: [] }),
    });
    const result = await enrollRelay(
      { api: authApi(appended), relayApi, mode, lock: alreadyLocked },
      { url: 'https://r.example', rootPassword: 'pw' }
    );
    expect(result).toEqual({ ok: true });
    expect(trace).toEqual(['readmit-prepare', 'proof-material', 'enroll']);
    expect(appended.map((row) => decodeKeyLogRecord(decodeBase64url(row.bytes)).type)).toEqual([
      'set-relays',
    ]);
  });

  test('补签失败：不碰远端 enroll，结论里带上补签进度', async () => {
    const appended: Appended[] = [];
    const trace: string[] = [];
    const mode = await modeOf();
    const result = await enrollRelay(
      {
        api: authApi(appended, { ok: false, code: 'KEY_LOG_FORK' }),
        relayApi: enrollApi(mode, { trace }),
        mode,
        lock: alreadyLocked,
      },
      { url: 'https://r.example', rootPassword: 'pw' }
    );
    expect(result).toEqual({
      ok: false,
      code: 'KEY_LOG_FORK',
      readmit: { signed: 0, failed: 1 },
    });
    // 令牌没被换发：旧链路仍然可用，用户改完再来一次即可。
    expect(trace).toEqual(['readmit-prepare']);
    expect(appended.map((row) => decodeKeyLogRecord(decodeBase64url(row.bytes)).type)).toEqual([
      'readmit-node',
    ]);
  });

  test('prepare 失败：不碰远端 enroll', async () => {
    const appended: Appended[] = [];
    const trace: string[] = [];
    const relayApi = enrollApi(await modeOf(), {
      trace,
      readmitPrepare: () => Promise.reject(new RelayApiError('RELAY_NOT_CONFIGURED', 'x', 409)),
    });
    const result = await enrollRelay(
      { api: authApi(appended), relayApi, mode: await modeOf(), lock: alreadyLocked },
      { url: 'https://r.example', rootPassword: 'pw' }
    );
    expect(result).toEqual({
      ok: false,
      code: 'RELAY_NOT_CONFIGURED',
      readmit: { signed: 0, failed: 0 },
    });
    expect(trace).toEqual(['readmit-prepare']);
    expect(appended).toHaveLength(0);
  });

  test('enroll 事后仍报 readmitRequired：不提交 set-relays', async () => {
    const appended: Appended[] = [];
    const trace: string[] = [];
    const mode = await modeOf();
    const relayApi = enrollApi(mode, { trace, readmitRequired: 2 });
    const result = await enrollRelay(
      { api: authApi(appended), relayApi, mode, lock: alreadyLocked },
      { url: 'https://r.example', rootPassword: 'pw' }
    );
    expect(result).toEqual({
      ok: false,
      code: READMIT_PENDING,
      readmit: { signed: 1, failed: 2 },
    });
    expect(trace).toEqual(['readmit-prepare', 'proof-material', 'enroll']);
    expect(appended.map((row) => decodeKeyLogRecord(decodeBase64url(row.bytes)).type)).toEqual([
      'readmit-node',
    ]);
  });

  test('afterEnroll 不跑：卡在补签这一步时密封包也不刷新', async () => {
    const mode = await modeOf();
    let ran = 0;
    const result = await enrollRelay(
      {
        api: authApi([], { ok: false, code: 'KEY_LOG_FORK' }),
        relayApi: enrollApi(mode),
        mode,
        lock: alreadyLocked,
      },
      {
        url: 'https://r.example',
        rootPassword: 'pw',
        afterEnroll: () => {
          ran += 1;
        },
      }
    );
    expect(result.ok).toBe(false);
    expect(ran).toBe(0);
  });
});
