import { describe, expect, test } from 'bun:test';
import type { HubEndpointInfo } from '@tmex/shared/uplink';
import { MeshHubStore, pickWriterHub } from '../auth/mesh-hub-store';
import { createMigratedAuthDb } from '../auth/test-db';
import { UserStore } from '../auth/user-store';
import {
  type NodeListApplyDeps,
  emitRenameNodeEvent,
  reconcileHubStoreFromNodeList,
} from './node-list-apply';
import type { UplinkNodeList } from './uplink-protocol';

const SELF = 'aa'.repeat(16);
const PEER = 'bb'.repeat(16);

function endpoint(nodeId: string, over: Partial<HubEndpointInfo> = {}): HubEndpointInfo {
  return {
    nodeId,
    publicUrl: `http://${nodeId.slice(0, 8)}.test`,
    mode: 'standby',
    priority: 200,
    writerEpoch: 1,
    online: true,
    ...over,
  };
}

function listOf(hubs: HubEndpointInfo[]): UplinkNodeList {
  const writer = hubs.find((hub) => hub.mode === 'active');
  return {
    t: 'node.list',
    version: 1,
    key_log_head: { seq: 0n, hash: new Uint8Array(32) },
    rtc: { stun: [], turn: null },
    nodes: [],
    hubs,
    ...(writer ? { writerHubId: writer.nodeId, writerEpoch: writer.writerEpoch } : {}),
  };
}

function applyDeps(hubStore: MeshHubStore, userStore: UserStore): NodeListApplyDeps {
  return {
    state: { lastNodeList: null, hubPresenceLive: false, hubGeneration: 0, lastRtc: null },
    identity: { nodeIdHex: SELF },
    hubStore,
    scheduler: { now: () => 1_000 },
    userIdOf: () => '',
    userStore,
    peerHolder: { manager: null },
    emitListNodeEvent: () => {},
    opts: {},
  };
}

describe('reconcileHubStoreFromNodeList', () => {
  test('stale node.list does not downgrade a locally promoted writer row', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const hubStore = new MeshHubStore(db);
      const userStore = new UserStore(db);
      hubStore.upsert(
        {
          hubNodeId: SELF,
          publicUrl: 'http://aaaaaaaa.test',
          name: 'self',
          mode: 'active',
          priority: 200,
          writerEpoch: 2,
          caFingerprint: null,
          online: true,
          lastSeenAt: 1,
        },
        10
      );
      hubStore.upsert(
        {
          hubNodeId: PEER,
          publicUrl: 'http://bbbbbbbb.test',
          name: 'peer',
          mode: 'active',
          priority: 100,
          writerEpoch: 1,
          caFingerprint: null,
          online: true,
          lastSeenAt: 1,
        },
        10
      );

      reconcileHubStoreFromNodeList(
        applyDeps(hubStore, userStore),
        listOf([
          endpoint(PEER, { mode: 'active', priority: 100, writerEpoch: 1 }),
          endpoint(SELF, { mode: 'standby', priority: 200, writerEpoch: 1 }),
        ])
      );

      const self = hubStore.get(SELF);
      expect(self?.mode).toBe('active');
      expect(self?.writerEpoch).toBe(2);
      expect(pickWriterHub(hubStore.list())).toBe(SELF);
    } finally {
      close();
    }
  });

  test('plain node still takes the writer hub set from node.list', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const hubStore = new MeshHubStore(db);
      const userStore = new UserStore(db);
      hubStore.upsert(
        {
          hubNodeId: PEER,
          publicUrl: 'http://bbbbbbbb.test',
          name: 'peer',
          mode: 'active',
          priority: 100,
          writerEpoch: 1,
          caFingerprint: null,
          online: true,
          lastSeenAt: 1,
        },
        10
      );

      reconcileHubStoreFromNodeList(
        applyDeps(hubStore, userStore),
        listOf([
          endpoint(PEER, {
            mode: 'standby',
            priority: 100,
            writerEpoch: 1,
            publicUrl: 'http://bbbbbbbb.test',
          }),
          endpoint('cc'.repeat(16), { mode: 'active', priority: 50, writerEpoch: 3 }),
        ])
      );

      expect(hubStore.get(PEER)?.mode).toBe('standby');
      expect(pickWriterHub(hubStore.list())).toBe('cc'.repeat(16));
    } finally {
      close();
    }
  });
});

describe('emitRenameNodeEvent', () => {
  test('emits name and syncs local site name for self', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const hubStore = new MeshHubStore(db);
      const userStore = new UserStore(db);
      const events: Array<{ nodeId: string; name?: string; status: string }> = [];
      const names: string[] = [];
      const d = applyDeps(hubStore, userStore);
      d.identity = { nodeIdHex: SELF };
      d.emitListNodeEvent = (event) => {
        events.push({ nodeId: event.nodeId, name: event.name, status: event.status });
      };
      d.opts = { onLocalNodeName: (name) => names.push(name) };
      emitRenameNodeEvent(d, SELF, 'studio');
      expect(events).toEqual([{ nodeId: SELF, name: 'studio', status: 'online' }]);
      expect(names).toEqual(['studio']);
      emitRenameNodeEvent(d, PEER, 'peer');
      expect(events[1]).toEqual({ nodeId: PEER, name: 'peer', status: 'offline' });
      expect(names).toEqual(['studio']);
    } finally {
      close();
    }
  });
});
