// 加入的第二步（中继模式下发成员密钥）：只签一条 `meta-key`，成败如实回给引擎。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { RecordSigner } from '@/auth/key-log-actions';
import type { RelayFlowDeps } from '@/node/relay-enroll';
import type { AuthApi } from '@vibeterm/api-client/auth/index';
import type { RelayTenantApi } from '@vibeterm/api-client/relay/tenant-api';
import { installWindowStorage } from '@vibeterm/stores/test-utils';

installWindowStorage();

const { encodeBase64url, rootKeyFromSeed } = await import('@vibeterm/shared/auth');
const { forgetSigner, resetSignerLeasesForTest } = await import('@/auth/credential-prompt');
const { resetMeshRelayStateForTest } = await import('@/node/mesh-relay');
const { RELAY_META_KEY_NEEDS_SIGNER } = await import('@/node/relay-meta-key-admit');
const { clearPendingMetaKeysForTest } = await import('@/node/relay-meta-key-pending');
const { admitModeOnceRelayKnown, relayAdmitFollowUp } = await import('./use-relay-admit-follow-up');

const NODE_A = 'aa'.repeat(16);
const NODE_B = 'bb'.repeat(16);

function signer(): RecordSigner {
  return { kind: 'root', rootKey: rootKeyFromSeed(new Uint8Array(32).fill(3)) };
}

function depsOf(lagging: string[] = []) {
  const appended: { bytes: string; sig: string }[] = [];
  const prepared: unknown[] = [];
  let statusCalls = 0;
  const api = {
    keyLogHead: () =>
      Promise.resolve({ seq: 4, hash: encodeBase64url(new Uint8Array(32).fill(7)) }),
    appendKeyLog: (body: { bytes: string; sig: string }) => {
      appended.push(body);
      return Promise.resolve({ ok: true, hubAck: true, relayAck: true });
    },
  } as unknown as AuthApi;
  const relayApi = {
    metaKeyPrepare: (op: unknown) => {
      prepared.push(op);
      return Promise.resolve({ payload: 'AQID', payloadHash: 'h' });
    },
    status: () => {
      statusCalls += 1;
      return Promise.resolve({
        mode: 'relay',
        relays: [],
        metaKeyLagging: lagging.map((nodeId) => ({ nodeId })),
      });
    },
  } as unknown as RelayTenantApi;
  const deps: RelayFlowDeps = {
    api,
    relayApi,
    mode: {
      uid: 'u1',
      rootEpoch: 3,
      kdfParams: { salt: 'x', memory_kib: 64, iterations: 1, parallelism: 1 },
    },
    lock: (run) => run(),
  };
  return { deps, appended, prepared, statusCalls: () => statusCalls };
}

beforeEach(() => {
  clearPendingMetaKeysForTest();
  forgetSigner();
  resetSignerLeasesForTest();
});

afterEach(() => {
  resetMeshRelayStateForTest();
});

describe('relayAdmitFollowUp', () => {
  test('给了 node id 与签名者：只签一条 meta-key，并刷新一次中继状态', async () => {
    const { deps, appended, prepared, statusCalls } = depsOf();
    const result = await relayAdmitFollowUp(deps)(NODE_A, signer());

    expect(result).toEqual({ ok: true });
    expect(prepared).toEqual([{ op: 'admit', node_id: NODE_A }]);
    expect(appended).toHaveLength(1);
    expect(statusCalls()).toBeGreaterThan(0);
  });

  test('没有可用签名者：不硬签，如实回失败码', async () => {
    const { deps, appended } = depsOf();
    const result = await relayAdmitFollowUp(deps)(NODE_A, null);

    expect(result).toEqual({ ok: false, code: RELAY_META_KEY_NEEDS_SIGNER });
    expect(appended).toHaveLength(0);
  });

  test('node id 不明：按服务端的欠账名单逐台补', async () => {
    const { deps, prepared } = depsOf([NODE_A, NODE_B]);
    const result = await relayAdmitFollowUp(deps)(null, signer());

    expect(result).toEqual({ ok: true });
    expect(prepared).toEqual([
      { op: 'admit', node_id: NODE_A },
      { op: 'admit', node_id: NODE_B },
    ]);
  });

  test('node id 不明且欠账名单拉不到：如实回失败，不当作已补齐', async () => {
    const { deps, prepared } = depsOf();
    let statusCalls = 0;
    const relayApi = {
      ...deps.relayApi,
      status: () => {
        statusCalls += 1;
        return Promise.reject(new Error('offline'));
      },
    } as unknown as RelayTenantApi;
    const result = await relayAdmitFollowUp({ ...deps, relayApi })(null, signer());

    expect(result).toEqual({ ok: false, code: 'offline' });
    expect(prepared).toEqual([]);
    expect(statusCalls).toBeGreaterThan(0);
  });
});

describe('admitModeOnceRelayKnown', () => {
  const mode = { uid: 'u1' };

  test('中继状态还没拉到：不把签名身份交给引擎（有没有第二步还不知道）', () => {
    expect(admitModeOnceRelayKnown({ loadedAt: null }, mode)).toBeNull();
  });

  test('拉到之后原样交出；本来就没有身份的仍是 null', () => {
    expect(admitModeOnceRelayKnown({ loadedAt: 1 }, mode)).toBe(mode);
    expect(admitModeOnceRelayKnown({ loadedAt: 1 }, null)).toBeNull();
  });
});
