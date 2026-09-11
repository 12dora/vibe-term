// admit 收尾（补发当前世代 K_meta）：先落欠账再签，签成才销账；node id 不明时改问服务端。

import { beforeEach, describe, expect, test } from 'bun:test';
import { forgetSigner, rememberSigner, resetSignerLeasesForTest } from '@/auth/credential-prompt';
import type { RecordSigner } from '@/auth/key-log-actions';
import type { AuthApi } from '@vibeterm/api-client/auth/index';
import type { RelayTenantApi } from '@vibeterm/api-client/relay/tenant-api';
import { encodeBase64url, rootKeyFromSeed } from '@vibeterm/shared/auth';
import type { RelayFlowDeps } from './relay-enroll';
import { catchUpMetaKeyLagging, distributeMetaKey } from './relay-meta-key-admit';
import { clearPendingMetaKeysForTest, listPendingMetaKeys } from './relay-meta-key-pending';

const NODE_A = 'aa'.repeat(16);
const NODE_B = 'bb'.repeat(16);

function signer(): RecordSigner {
  return { kind: 'root', rootKey: rootKeyFromSeed(new Uint8Array(32).fill(3)) };
}

function depsOf(options: { append?: unknown; alreadyCovered?: boolean } = {}): {
  deps: RelayFlowDeps;
  appended: { bytes: string; sig: string }[];
} {
  const appended: { bytes: string; sig: string }[] = [];
  const api = {
    keyLogHead: () =>
      Promise.resolve({ seq: 4, hash: encodeBase64url(new Uint8Array(32).fill(7)) }),
    appendKeyLog: (body: { bytes: string; sig: string }) => {
      appended.push(body);
      return Promise.resolve(options.append ?? { ok: true, hubAck: true, relayAck: true });
    },
  } as unknown as AuthApi;
  const relayApi = {
    metaKeyPrepare: () =>
      Promise.resolve(
        options.alreadyCovered
          ? { alreadyCovered: true, epoch: 6, payload: '', payloadHash: '' }
          : { payload: 'AQID', payloadHash: 'h' }
      ),
    // 密封包重封失败不该影响 meta-key 的结论
    status: () => Promise.resolve({ mode: 'relay', relays: [] }),
  } as unknown as RelayTenantApi;
  return {
    appended,
    deps: {
      api,
      relayApi,
      mode: {
        uid: 'u1',
        rootEpoch: 3,
        kdfParams: { salt: 'x', memory_kib: 64, iterations: 1, parallelism: 1 },
      },
      lock: (run) => run(),
    },
  };
}

describe('distributeMetaKey', () => {
  beforeEach(() => {
    clearPendingMetaKeysForTest();
    forgetSigner();
    resetSignerLeasesForTest();
  });

  test('复用窗口里没有签名者：欠账留下来，界面靠它挂告警条', async () => {
    const { deps, appended } = depsOf();
    const result = await distributeMetaKey(deps, NODE_A);
    expect(result.ok).toBe(false);
    expect(appended).toHaveLength(0);
    expect(listPendingMetaKeys()).toEqual([
      {
        id: `admit:${NODE_A}`,
        reason: 'admit',
        op: { op: 'admit', node_id: NODE_A },
        createdAt: expect.any(Number),
        record: null,
      },
    ]);
  });

  test('签成了才销账', async () => {
    const { deps, appended } = depsOf();
    const result = await distributeMetaKey(deps, NODE_A, signer());
    expect(result.ok).toBe(true);
    expect(appended).toHaveLength(1);
    expect(listPendingMetaKeys()).toEqual([]);
  });

  test('上级没确认：欠账留着，字节留给重试回路原样重发', async () => {
    const { deps } = depsOf({ append: { ok: true, hubAck: false, hubError: 'RELAY_OFFLINE' } });
    const result = await distributeMetaKey(deps, NODE_A, signer());
    expect(result.ok).toBe(false);
    const [pending] = listPendingMetaKeys();
    expect(pending?.id).toBe(`admit:${NODE_A}`);
    expect(pending?.record).not.toBeNull();
  });

  test('服务端答「已被当前世代封到」：按成功收尾，不签记录、不白换一代密钥', async () => {
    // 多个补发入口（收尾钩子、两处告警条、多个标签页 / PWA）会各读一次欠账名单并各签一条，
    // 同一台节点因此白换好几代 K_meta——服务端给幂等应答，这里必须当成已完成。
    const { deps, appended } = depsOf({ alreadyCovered: true });
    const result = await distributeMetaKey(deps, NODE_A, signer());
    expect(result.ok).toBe(true);
    expect(appended).toHaveLength(0);
    expect(listPendingMetaKeys()).toEqual([]);
  });

  test('复用窗口里的签名者会被自动取用（admit 之后不再问一次凭据）', async () => {
    const { deps, appended } = depsOf();
    rememberSigner(signer(), Date.now());
    const result = await distributeMetaKey(deps, NODE_A);
    expect(result.ok).toBe(true);
    expect(appended).toHaveLength(1);
  });
});

describe('catchUpMetaKeyLagging', () => {
  beforeEach(() => {
    clearPendingMetaKeysForTest();
    forgetSigner();
    resetSignerLeasesForTest();
  });

  test('按服务端名单逐台补发', async () => {
    const { deps, appended } = depsOf();
    const relayApi = {
      status: () =>
        Promise.resolve({
          metaKeyLagging: [{ nodeId: NODE_A }, { nodeId: NODE_B }],
        }),
    } as unknown as RelayTenantApi;
    const summary = await catchUpMetaKeyLagging(deps, signer(), relayApi);
    expect(summary).toEqual({ lagging: 2, delivered: 2, failedCode: null });
    expect(appended).toHaveLength(2);
    expect(listPendingMetaKeys()).toEqual([]);
  });

  test('中途失败继续往下走，欠账留给告警条', async () => {
    const { deps } = depsOf({ append: { ok: false, code: 'RELAY_OFFLINE' } });
    const relayApi = {
      status: () => Promise.resolve({ metaKeyLagging: [{ nodeId: NODE_A }, { nodeId: NODE_B }] }),
    } as unknown as RelayTenantApi;
    const summary = await catchUpMetaKeyLagging(deps, signer(), relayApi);
    expect(summary.delivered).toBe(0);
    expect(summary.failedCode).toBe('RELAY_OFFLINE');
    expect(listPendingMetaKeys()).toHaveLength(2);
  });

  test('状态拉不到时不编造欠账', async () => {
    const { deps } = depsOf();
    const relayApi = {
      status: () => Promise.reject(new Error('offline')),
    } as unknown as RelayTenantApi;
    expect(await catchUpMetaKeyLagging(deps, signer(), relayApi)).toEqual({
      lagging: 0,
      delivered: 0,
      failedCode: null,
    });
  });
});
