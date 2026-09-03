// 元数据密钥换代的欠账：记账 / 覆盖 / 重发 / 重签。

import { beforeEach, describe, expect, test } from 'bun:test';
import type { AuthApi } from '@tmex/api-client/auth/index';
import type { RelayTenantApi } from '@tmex/api-client/relay/tenant-api';
import { encodeBase64url } from '@tmex/shared/auth';
import type { RelayFlowDeps } from './relay-enroll';
import {
  clearPendingMetaKeysForTest,
  forgetPendingMetaKey,
  listPendingMetaKeys,
  rememberPendingMetaKey,
  retryPendingMetaKey,
  retryPendingMetaKeys,
} from './relay-meta-key-pending';

type Appended = { bytes: string; sig: string };

function depsOf(
  appended: Appended[],
  options: { result?: unknown; preparePayload?: string } = {}
): RelayFlowDeps {
  const api = {
    keyLogHead: () =>
      Promise.resolve({ seq: 4, hash: encodeBase64url(new Uint8Array(32).fill(7)) }),
    appendKeyLog: (body: Appended) => {
      appended.push(body);
      return Promise.resolve(options.result ?? { ok: true, hubAck: true });
    },
  } as unknown as AuthApi;
  const relayApi = {
    metaKeyPrepare: () =>
      Promise.resolve({ payload: options.preparePayload ?? 'AQID', payloadHash: 'h' }),
  } as unknown as RelayTenantApi;
  return {
    api,
    relayApi,
    mode: {
      uid: 'u1',
      rootEpoch: 3,
      kdfParams: { salt: 'x', memory_kib: 64, iterations: 1, parallelism: 1 },
    },
    lock: (run) => run(),
  };
}

const RECORD = { type: 'meta-key' as const, bytes: 'YWJj', sig: 'ZGVm' };

describe('relay meta-key 欠账', () => {
  beforeEach(() => clearPendingMetaKeysForTest());

  test('同 id 覆盖，不会堆出两条', () => {
    rememberPendingMetaKey({ id: 'revoke:a', reason: 'revoke', op: { op: 'rotate' } });
    rememberPendingMetaKey({
      id: 'revoke:a',
      reason: 'revoke',
      op: { op: 'rotate' },
      record: RECORD,
    });
    expect(listPendingMetaKeys()).toHaveLength(1);
    expect(listPendingMetaKeys()[0]?.record).toEqual(RECORD);
    forgetPendingMetaKey('revoke:a');
    expect(listPendingMetaKeys()).toHaveLength(0);
  });

  test('有已签字节时原样重发，落账后销账', async () => {
    rememberPendingMetaKey({
      id: 'revoke:a',
      reason: 'revoke',
      op: { op: 'rotate' },
      record: RECORD,
    });
    const appended: Appended[] = [];
    const result = await retryPendingMetaKeys(depsOf(appended));
    expect(result).toBe(0);
    expect(appended).toEqual([{ bytes: 'YWJj', sig: 'ZGVm' }]);
    expect(listPendingMetaKeys()).toHaveLength(0);
  });

  test('重发被判定为过期时丢掉字节，等下次带凭据重签', async () => {
    rememberPendingMetaKey({
      id: 'revoke:a',
      reason: 'revoke',
      op: { op: 'rotate' },
      record: RECORD,
    });
    const left = await retryPendingMetaKeys(depsOf([], { result: { ok: false, code: 'seq_gap' } }));
    expect(left).toBe(1);
    expect(listPendingMetaKeys()[0]?.record).toBeNull();
  });

  test('没有字节又没有签名者时原样留着，一条请求都不发', async () => {
    rememberPendingMetaKey({ id: 'admit:b', reason: 'admit', op: { op: 'rotate' } });
    const appended: Appended[] = [];
    const entry = listPendingMetaKeys()[0];
    if (!entry) throw new Error('missing entry');
    const result = await retryPendingMetaKey(depsOf(appended), entry);
    expect(result).toEqual({ ok: false, code: 'RELAY_META_KEY_NEEDS_SIGNER' });
    expect(appended).toHaveLength(0);
    expect(listPendingMetaKeys()).toHaveLength(1);
  });
});
