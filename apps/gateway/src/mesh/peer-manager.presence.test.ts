import { describe, expect, test } from 'bun:test';
import { createInMemoryLinkPair } from '@vibeterm/shared/link';
import { createMigratedAuthDb } from '../auth/test-db';
import { UserStore } from '../auth/user-store';
import { encodeJsonBytes } from './ctl';
import { type NodeListApplyDeps, applyUplinkNodeList } from './node-list-apply';
import { PeerManager } from './peer-manager';
import { DC_PRESENCE_ABSENCE_MS } from './peer-reconnect-wake';
import { dummyUplink, echoQuiesceCaps } from './peer-test-fixtures';
import { RTC_DIAL_BREAKER_FAILS } from './rtc/rtc-dial-breaker';
import { ImmediateScheduler, seedNodeIdentity, seedUser, waitUntil } from './test-support';
import type { UplinkNodeList } from './uplink-protocol';

type UpgradeHandle = {
  dcBreaker: {
    noteFailure: (peer: string, kind: string, attemptId: string) => unknown;
    snapshot: (peer: string) => { until: number | null };
  };
  onPeerReconnected: (nodeId: string) => void;
};

function upgradeOf(manager: PeerManager): UpgradeHandle {
  return (manager as unknown as { dcUpgrade: UpgradeHandle }).dcUpgrade;
}

function climbDisabled(manager: PeerManager, scheduler: ImmediateScheduler, peer: string): void {
  const breaker = upgradeOf(manager).dcBreaker;
  for (let round = 0; round < 5; round += 1) {
    const until = breaker.snapshot(peer).until;
    if (until != null && until > scheduler.now()) scheduler.nowMs = until;
    for (let i = 0; i < RTC_DIAL_BREAKER_FAILS; i += 1) {
      breaker.noteFailure(peer, 'timeout', `c${round}-${i}`);
    }
  }
}

function listed(id: string, online: boolean, version = '2.8.0'): UplinkNodeList['nodes'][number] {
  return {
    id,
    name: 'peer',
    online,
    endpoints: [],
    inventory: {},
    direct_capable: false,
    version,
  };
}

function applyList(d: NodeListApplyDeps, nodes: UplinkNodeList['nodes']): void {
  applyUplinkNodeList(
    d,
    {
      t: 'node.list',
      version: 1,
      key_log_head: { seq: 0n, hash: new Uint8Array(32) },
      rtc: { stun: [], turn: null },
      nodes,
    },
    () => false
  );
}

function harness() {
  const opened = createMigratedAuthDb();
  const scheduler = new ImmediateScheduler();
  const store = new UserStore(opened.db);
  seedUser(store);
  const self = seedNodeIdentity(store, 'user-1');
  const peer = seedNodeIdentity(store, 'user-1');
  const manager = new PeerManager({
    identity: self,
    userStore: store,
    uplink: dummyUplink(self, store),
    peerPort: 0,
    startServer: false,
    scheduler,
  });
  const state: NodeListApplyDeps['state'] = {
    lastNodeList: null,
    uplinkPresenceLive: false,
    uplinkGeneration: 0,
    lastRtc: null,
  };
  const deps: NodeListApplyDeps = {
    state,
    identity: { nodeIdHex: self.nodeId },
    scheduler,
    userIdOf: () => 'user-1',
    userStore: store,
    peerHolder: { manager },
    emitListNodeEvent: () => undefined,
    opts: {},
  };
  return {
    scheduler,
    store,
    self,
    peer,
    manager,
    deps,
    async close() {
      await manager.stop();
      opened.close();
    },
  };
}

describe('PeerManager presence and capabilities', () => {
  test('a listed gap under 90s does nothing and 90s decays one level; a relay flap does not', async () => {
    expect(DC_PRESENCE_ABSENCE_MS).toBe(90_000);
    const h = harness();
    try {
      climbDisabled(h.manager, h.scheduler, h.peer.nodeId);
      const before = h.manager.linkDetailOf(h.peer.nodeId).dcBreaker;
      expect(before).toMatchObject({ disabled: true, level: 5 });
      applyList(h.deps, [listed(h.peer.nodeId, true)]);
      applyList(h.deps, [listed(h.peer.nodeId, true)]);
      upgradeOf(h.manager).onPeerReconnected(h.peer.nodeId);
      h.scheduler.nowMs += 60 * 60 * 1000;
      upgradeOf(h.manager).onPeerReconnected(h.peer.nodeId);
      expect(h.manager.linkDetailOf(h.peer.nodeId).dcBreaker).toMatchObject({
        disabled: true,
        level: before.level,
        failures: before.failures,
      });

      applyList(h.deps, [listed(h.peer.nodeId, false)]);
      h.scheduler.nowMs += DC_PRESENCE_ABSENCE_MS - 1;
      applyList(h.deps, [listed(h.peer.nodeId, true)]);
      expect(h.manager.linkDetailOf(h.peer.nodeId).dcBreaker).toMatchObject({
        disabled: true,
        level: before.level,
        failures: before.failures,
      });

      applyList(h.deps, [listed(h.peer.nodeId, false)]);
      h.scheduler.nowMs += DC_PRESENCE_ABSENCE_MS;
      applyList(h.deps, [listed(h.peer.nodeId, true)]);
      expect(h.manager.linkDetailOf(h.peer.nodeId).dcBreaker).toMatchObject({
        disabled: false,
        level: before.level - 1,
        failures: before.failures,
      });
    } finally {
      await h.close();
    }
  });

  test('a node that vanishes from the list and returns after 90s decays one level', async () => {
    const h = harness();
    try {
      climbDisabled(h.manager, h.scheduler, h.peer.nodeId);
      const before = h.manager.linkDetailOf(h.peer.nodeId).dcBreaker;
      expect(before.disabled).toBe(true);
      applyList(h.deps, [listed(h.peer.nodeId, true)]);
      applyList(h.deps, []);
      h.scheduler.nowMs += DC_PRESENCE_ABSENCE_MS - 1;
      applyList(h.deps, [listed(h.peer.nodeId, true)]);
      expect(h.manager.linkDetailOf(h.peer.nodeId).dcBreaker).toMatchObject({
        disabled: true,
        level: before.level,
      });
      applyList(h.deps, []);
      h.scheduler.nowMs += DC_PRESENCE_ABSENCE_MS;
      applyList(h.deps, [listed(h.peer.nodeId, true)]);
      expect(h.manager.linkDetailOf(h.peer.nodeId).dcBreaker).toMatchObject({
        disabled: false,
        level: before.level - 1,
        failures: before.failures,
      });
    } finally {
      await h.close();
    }
  });

  test('a node.list version change full-resets a disabled breaker; the same version does not', async () => {
    const h = harness();
    try {
      applyList(h.deps, [listed(h.peer.nodeId, true, '2.8.0')]);
      climbDisabled(h.manager, h.scheduler, h.peer.nodeId);
      expect(h.manager.linkDetailOf(h.peer.nodeId).dcBreaker.disabled).toBe(true);
      applyList(h.deps, [listed(h.peer.nodeId, true, '2.8.0')]);
      expect(h.manager.linkDetailOf(h.peer.nodeId).dcBreaker).toMatchObject({
        disabled: true,
        level: 5,
      });
      applyList(h.deps, [listed(h.peer.nodeId, true, '2.9.0')]);
      expect(h.store.getPeer(h.peer.nodeId)?.version).toBe('2.9.0');
      expect(h.manager.linkDetailOf(h.peer.nodeId).dcBreaker).toMatchObject({
        disabled: false,
        level: 0,
      });
    } finally {
      await h.close();
    }
  });

  test('node.status version change full-resets once and a repeat does not', async () => {
    const h = harness();
    try {
      h.store.upsertPeer({
        nodeId: h.peer.nodeId,
        name: 'peer',
        endpointsJson: '[]',
        inventoryJson: '{}',
        directCapable: false,
        lastSeenAt: 1,
        listVersion: 1,
        version: '2.8.0',
      });
      const [local, remote] = createInMemoryLinkPair();
      echoQuiesceCaps(remote);
      expect(h.manager.adoptLink(h.peer.nodeId, local, 'ws-secure', h.self.nodeId)).toBe(local);
      await waitUntil(() => h.manager.quiesceCapableOf(h.peer.nodeId));
      climbDisabled(h.manager, h.scheduler, h.peer.nodeId);
      expect(h.manager.linkDetailOf(h.peer.nodeId).dcBreaker.disabled).toBe(true);
      const status = {
        t: 'node.status',
        version: '2.9.0',
        endpoints: [],
        inventory: {},
        direct_capable: false,
      };
      remote.ctl.send(encodeJsonBytes(status));
      await waitUntil(() => h.store.getPeer(h.peer.nodeId)?.version === '2.9.0');
      expect(h.manager.linkDetailOf(h.peer.nodeId).dcBreaker).toMatchObject({
        disabled: false,
        level: 0,
      });

      climbDisabled(h.manager, h.scheduler, h.peer.nodeId);
      expect(h.manager.linkDetailOf(h.peer.nodeId).dcBreaker.disabled).toBe(true);
      h.scheduler.nowMs += 20;
      remote.ctl.send(encodeJsonBytes(status));
      await waitUntil(() => h.store.getPeer(h.peer.nodeId)?.lastSeenAt === h.scheduler.now());
      expect(h.manager.linkDetailOf(h.peer.nodeId).dcBreaker).toMatchObject({
        disabled: true,
        level: 5,
      });
    } finally {
      await h.close();
    }
  });
});
