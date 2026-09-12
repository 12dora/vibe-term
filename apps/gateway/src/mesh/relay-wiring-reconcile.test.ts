import { describe, expect, test } from 'bun:test';
import type { AuthDb } from '../auth/types';
import type { RelayMultiAttach } from './relay-multi-attach';
import type { RelayReconcileResult, RelaySecrets } from './relay-secrets';
import { bindRelayMultiAttach, bindRelayReconcile, createRelayWiring } from './relay-wiring';
import { waitUntil } from './test-support';
import type { UplinkPool } from './uplink-pool';

const PRIMARY_URL = 'https://relay-a.example';
const SECONDARY_URL = 'https://relay-b.example';

type Calls = {
  drain: number;
  poolStop: number;
  poolStart: number;
  refresh: number;
  attachStop: number;
  attachStart: number;
  attachReconcile: number;
};

function harness(result: RelayReconcileResult) {
  const calls: Calls = {
    drain: 0,
    poolStop: 0,
    poolStart: 0,
    refresh: 0,
    attachStop: 0,
    attachStart: 0,
    attachReconcile: 0,
  };
  const pool = {
    waitForRelayStreamsToDrain: async () => {
      calls.drain += 1;
    },
    stop: async () => {
      calls.poolStop += 1;
    },
    start: () => {
      calls.poolStart += 1;
    },
    refreshCandidates: () => {
      calls.refresh += 1;
    },
    attachedHub: () => ({ publicUrl: PRIMARY_URL }),
    liveClient: () => null,
  } as unknown as UplinkPool;
  const attach = {
    stop: async () => {
      calls.attachStop += 1;
    },
    start: () => {
      calls.attachStart += 1;
    },
    reconcile: async () => {
      calls.attachReconcile += 1;
    },
    sendStatusAll: () => {},
  } as unknown as RelayMultiAttach;

  const wiring = createRelayWiring({
    db: {} as AuthDb,
    identity: { nodeIdHex: 'aa'.repeat(16), x25519PrivateKey: new Uint8Array(32) },
    userIdOf: () => 'user-1',
  });
  wiring.secrets = {
    currentMetaEpoch: () => result.metaEpoch,
    reconcile: async () => result,
    relayRows: () => [
      { url: PRIMARY_URL, tenantId: 'ab'.repeat(16), priority: 0, kicked: false },
      { url: SECONDARY_URL, tenantId: 'ab'.repeat(16), priority: 1, kicked: false },
    ],
  } as unknown as RelaySecrets;
  bindRelayReconcile(wiring, pool, { replaceAll() {} });
  bindRelayMultiAttach(wiring, attach);
  return { wiring, calls };
}

function reconcileResult(patch: Partial<RelayReconcileResult>): RelayReconcileResult {
  const primaryChanged = patch.primaryChanged ?? false;
  const rowsChanged = patch.rowsChanged ?? false;
  return {
    kind: 'relay',
    primaryChanged,
    rowsChanged,
    targetsChanged: primaryChanged || rowsChanged,
    metaEpoch: patch.metaEpoch ?? 1,
  };
}

describe('runReconcile 的重启粒度', () => {
  test('只增删 secondary：刷新候选 + attach.reconcile，不排空重启主链路', async () => {
    const { wiring, calls } = harness(reconcileResult({ rowsChanged: true }));
    wiring.notifyIfRelayRecord('set-relays');
    await waitUntil(() => calls.attachReconcile > 0);
    expect(calls.refresh).toBe(1);
    expect(calls.drain).toBe(0);
    expect(calls.poolStop).toBe(0);
    expect(calls.poolStart).toBe(0);
    expect(calls.attachStop).toBe(0);
  });

  test('主中继变化：仍走排空 + 重建池 + attach 重挂', async () => {
    const { wiring, calls } = harness(reconcileResult({ primaryChanged: true, rowsChanged: true }));
    wiring.notifyIfRelayRecord('set-relays');
    await waitUntil(() => calls.poolStart > 0);
    expect(calls.drain).toBe(1);
    expect(calls.poolStop).toBe(1);
    expect(calls.attachStop).toBe(1);
    expect(calls.attachStart).toBe(1);
    expect(calls.refresh).toBe(0);
  });

  test('目标没变：既不重启也不刷新候选', async () => {
    const { wiring, calls } = harness(reconcileResult({}));
    wiring.notifyIfRelayRecord('set-relays');
    await Bun.sleep(20);
    expect(calls.refresh).toBe(0);
    expect(calls.drain).toBe(0);
    expect(calls.attachReconcile).toBe(0);
  });

  test('非中继类记录不触发任何动作', async () => {
    const { wiring, calls } = harness(reconcileResult({ primaryChanged: true }));
    wiring.notifyIfRelayRecord('admit-node');
    await Bun.sleep(20);
    expect(calls.drain).toBe(0);
    expect(calls.refresh).toBe(0);
  });
});
