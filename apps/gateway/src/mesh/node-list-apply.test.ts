import { describe, expect, test } from 'bun:test';
import { createMigratedAuthDb } from '../auth/test-db';
import { UserStore } from '../auth/user-store';
import { NodeEventDedupe } from './node-event-dedupe';
import {
  type NodeListApplyDeps,
  applyUplinkNodeList,
  emitRenameNodeEvent,
  mergeAppliedNodeList,
  mergeListedRtc,
  overlayOnlineUnion,
} from './node-list-apply';
import type { UplinkNodeList } from './uplink-protocol';

const SELF = 'aa'.repeat(16);
const PEER = 'bb'.repeat(16);

function emptyList(over: Partial<UplinkNodeList> = {}): UplinkNodeList {
  return {
    t: 'node.list',
    version: 1,
    key_log_head: { seq: 0n, hash: new Uint8Array(32) },
    rtc: { stun: [], turn: null },
    nodes: [],
    ...over,
  };
}

function applyDeps(userStore: UserStore): NodeListApplyDeps {
  return {
    state: { lastNodeList: null, uplinkPresenceLive: false, uplinkGeneration: 0, lastRtc: null },
    identity: { nodeIdHex: SELF },
    scheduler: { now: () => 1_000 },
    userIdOf: () => '',
    userStore,
    peerHolder: { manager: null },
    emitListNodeEvent: () => {},
    opts: {},
  };
}

describe('emitRenameNodeEvent', () => {
  test('emits name and syncs local site name for self', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const userStore = new UserStore(db);
      const events: Array<{ nodeId: string; name?: string; status: string }> = [];
      const names: string[] = [];
      const d = applyDeps(userStore);
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

describe('uplink presence generation', () => {
  test('offline → online → offline emits synthetic offline twice', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const userStore = new UserStore(db);
      const d = applyDeps(userStore);
      const dedupe = new NodeEventDedupe();
      const emitted: string[] = [];
      applyUplinkNodeList(d, emptyList(), () => false);
      expect(d.state.uplinkGeneration).toBe(1);
      expect(d.state.uplinkPresenceLive).toBe(true);
      expect(dedupe.shouldEmitSyntheticOffline(PEER, d.state.uplinkGeneration)).toBe(true);
      emitted.push('offline-1');
      expect(dedupe.shouldEmitSyntheticOffline(PEER, d.state.uplinkGeneration)).toBe(false);

      applyUplinkNodeList(
        d,
        emptyList({
          nodes: [
            {
              id: PEER,
              name: 'peer',
              online: true,
              endpoints: [],
              inventory: {},
              direct_capable: false,
              version: null,
            },
          ],
        }),
        () => false
      );
      expect(d.state.uplinkGeneration).toBe(1);
      expect(dedupe.shouldEmitList({ nodeId: PEER, status: 'online' })).toBe(true);

      d.state.uplinkPresenceLive = false;
      applyUplinkNodeList(d, emptyList(), () => false);
      expect(d.state.uplinkGeneration).toBe(2);
      expect(d.state.uplinkPresenceLive).toBe(true);
      expect(dedupe.shouldEmitSyntheticOffline(PEER, d.state.uplinkGeneration)).toBe(true);
      emitted.push('offline-2');
      expect(emitted).toEqual(['offline-1', 'offline-2']);
    } finally {
      close();
    }
  });
});

describe('applyUplinkNodeList STUN distribution', () => {
  test('empty STUN list stores empty distributed stun (no fallback to previous)', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const userStore = new UserStore(db);
      const d = applyDeps(userStore);
      d.state.lastRtc = { stun: ['stun:local:3478'], turn: null };
      applyUplinkNodeList(d, emptyList(), () => false);
      expect(d.state.lastRtc).toEqual({ stun: [], turn: null });
      applyUplinkNodeList(
        d,
        emptyList({ rtc: { stun: ['stun:relay:3478'], turn: null } }),
        () => false
      );
      expect(d.state.lastRtc).toEqual({ stun: ['stun:relay:3478'], turn: null });
    } finally {
      close();
    }
  });

  test('empty STUN with TURN adopts TURN and empty distributed STUN', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const userStore = new UserStore(db);
      const d = applyDeps(userStore);
      d.state.lastRtc = { stun: ['stun:local:3478'], turn: null };
      const turn = { urls: ['turn:relay:3478'], username: 'u', credential: 'p' };
      applyUplinkNodeList(d, emptyList({ rtc: { stun: [], turn } }), () => false);
      expect(d.state.lastRtc).toEqual({ stun: [], turn });

      const fresh = applyDeps(userStore);
      applyUplinkNodeList(fresh, emptyList({ rtc: { stun: [], turn } }), () => false);
      expect(fresh.state.lastRtc).toEqual({ stun: [], turn });
    } finally {
      close();
    }
  });

  test('多中继 TURN 按 URL 合并为数组，null 只撤回本行', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const userStore = new UserStore(db);
      const d = applyDeps(userStore);
      d.rtcSourceUrl = 'https://sh.example';
      const shTurn = { url: 'turn:sh:3478', username: 'a', credential: 'a' };
      applyUplinkNodeList(d, emptyList({ rtc: { stun: ['stun:sh'], turn: shTurn } }), () => false);
      expect(d.state.lastRtc).toEqual({ stun: ['stun:sh'], turn: [shTurn] });

      d.rtcSourceUrl = undefined;
      d.state.lastRtc = mergeListedRtc(
        d.state.lastRtc,
        {
          stun: ['stun:tk'],
          turn: { url: 'turn:tk:3478', username: 'b', credential: 'b' },
        },
        { sourceUrl: 'https://tk.example', primary: false }
      );
      expect(d.state.lastRtc?.stun).toEqual(['stun:sh', 'stun:tk']);
      expect(d.state.lastRtc?.turn).toEqual([
        shTurn,
        { url: 'turn:tk:3478', username: 'b', credential: 'b' },
      ]);

      d.state.lastRtc = mergeListedRtc(
        d.state.lastRtc,
        { stun: ['stun:tk'], turn: null },
        {
          sourceUrl: 'https://tk.example',
          primary: false,
        }
      );
      expect(d.state.lastRtc).toEqual({ stun: ['stun:sh', 'stun:tk'], turn: [shTurn] });
    } finally {
      close();
    }
  });

  test('三中继 TURN 主中继在前，其余保持插入序（ICE 并列回落用）', () => {
    const sh = { url: 'turn:sh:3478', username: 'a', credential: 'a' };
    const tk = { url: 'turn:tk:3478', username: 'b', credential: 'b' };
    const jp = { url: 'turn:jp:3478', username: 'c', credential: 'c' };
    let rtc = mergeListedRtc(
      null,
      { stun: ['stun:sh'], turn: sh },
      {
        sourceUrl: 'https://sh.example',
        primary: true,
      }
    );
    rtc = mergeListedRtc(
      rtc,
      { stun: ['stun:tk'], turn: tk },
      {
        sourceUrl: 'https://tk.example',
        primary: false,
      }
    );
    rtc = mergeListedRtc(
      rtc,
      { stun: ['stun:jp'], turn: jp },
      {
        sourceUrl: 'https://jp.example',
        primary: false,
      }
    );
    expect(rtc.turn).toEqual([sh, tk, jp]);

    rtc = mergeListedRtc(
      rtc,
      { stun: ['stun:jp'], turn: jp },
      {
        sourceUrl: 'https://jp.example',
        primary: true,
      }
    );
    expect(rtc.turn).toEqual([jp, sh, tk]);
  });

  test('primary 清单不剪掉只出现在 secondary 的 peer', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const userStore = new UserStore(db);
      userStore.upsertPeer({
        nodeId: PEER,
        name: 'tokyo-only',
        endpointsJson: '[]',
        inventoryJson: '{}',
        directCapable: false,
        lastSeenAt: 1,
        listVersion: 1,
        version: '2.2.4',
      });
      const d = applyDeps(userStore);
      d.retainPeerIds = () => [PEER];
      d.extraListedNodes = () => [
        {
          id: PEER,
          name: 'tokyo-only',
          online: true,
          endpoints: [],
          inventory: {},
          direct_capable: false,
          version: '2.2.4',
        },
      ];
      applyUplinkNodeList(d, emptyList(), () => false);
      expect(userStore.getPeer(PEER)?.name).toBe('tokyo-only');
      expect(d.state.lastNodeList?.nodes.some((node) => node.id === PEER)).toBe(true);
    } finally {
      close();
    }
  });

  test('清单事件带上 viaRelay / relayPresence，仅中继选择变化也会发出', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const userStore = new UserStore(db);
      const events: Array<{ viaRelay?: string | null; relayPresence?: string[] }> = [];
      const d = applyDeps(userStore);
      d.peerHolder.manager = {
        listReach: () => new Map(),
        transportOf: () => 'relay',
        rttOf: () => 12,
        viaRelayOf: () => 'https://sh.example',
        relayPresenceOf: () => ['https://sh.example', 'https://tk.example'],
        notifyPeerEndpointsChanged: () => {},
      };
      d.emitListNodeEvent = (event) => {
        events.push({
          viaRelay: event.viaRelay,
          relayPresence: event.relayPresence ?? undefined,
        });
      };
      applyUplinkNodeList(
        d,
        emptyList({
          nodes: [
            {
              id: PEER,
              name: 'peer',
              online: true,
              endpoints: [],
              inventory: {},
              direct_capable: false,
              version: '2.2.4',
            },
          ],
        }),
        () => false
      );
      expect(events).toEqual([
        {
          viaRelay: 'https://sh.example',
          relayPresence: ['https://sh.example', 'https://tk.example'],
        },
      ]);
    } finally {
      close();
    }
  });

  test('primary 标 offline、secondary 仍在线时不发 offline，节点按 online 应用', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const userStore = new UserStore(db);
      const events: Array<{ status: string; relayPresence?: string[] }> = [];
      const d = applyDeps(userStore);
      d.onlineUnionIds = () => [PEER];
      d.peerHolder.manager = {
        listReach: () => new Map(),
        transportOf: () => 'relay',
        rttOf: () => 8,
        viaRelayOf: () => 'https://tk.example',
        relayPresenceOf: () => ['https://tk.example'],
        notifyPeerEndpointsChanged: () => {},
      };
      d.emitListNodeEvent = (event) => {
        events.push({
          status: event.status,
          relayPresence: event.relayPresence ?? undefined,
        });
      };
      applyUplinkNodeList(
        d,
        emptyList({
          nodes: [
            {
              id: PEER,
              name: 'peer',
              online: false,
              endpoints: [],
              inventory: {},
              direct_capable: false,
              version: '2.2.4',
            },
          ],
        }),
        () => false
      );
      expect(d.state.lastNodeList?.nodes.find((node) => node.id === PEER)?.online).toBe(true);
      expect(events).toEqual([{ status: 'online', relayPresence: ['https://tk.example'] }]);
    } finally {
      close();
    }
  });

  test('secondary-only retained 节点不在并集时 overlay 为 offline，primary 清单保留自身标志', () => {
    const extra = listedNode(PEER, true, 'tokyo-only');
    const primaryPeer = listedNode(SELF, true, 'self');
    const overlaid = overlayOnlineUnion([primaryPeer, extra], [], [SELF]);
    expect(overlaid.find((node) => node.id === PEER)?.online).toBe(false);
    expect(overlaid.find((node) => node.id === SELF)?.online).toBe(true);
  });

  test('并集报 online 时 primary 标 offline 的节点仍升为 online', () => {
    const listed = listedNode(PEER, false);
    expect(overlayOnlineUnion([listed], [PEER], [PEER])[0]?.online).toBe(true);
  });

  test('extraListedNodes 陈旧 online 不会在并集为空时复活', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const userStore = new UserStore(db);
      const events: string[] = [];
      const d = applyDeps(userStore);
      d.retainPeerIds = () => [PEER];
      d.extraListedNodes = () => [listedNode(PEER, true, 'tokyo-only')];
      d.onlineUnionIds = () => [];
      d.emitListNodeEvent = (event) => {
        events.push(`${event.nodeId}:${event.status}`);
      };
      const incoming = emptyList();
      const merged = mergeAppliedNodeList(incoming, d.extraListedNodes(), d.onlineUnionIds());
      expect(merged.nodes.find((node) => node.id === PEER)?.online).toBe(false);
      applyUplinkNodeList(d, incoming, () => false);
      expect(d.state.lastNodeList?.nodes.find((node) => node.id === PEER)?.online).toBe(false);
      expect(events).toEqual([`${PEER}:offline`]);
    } finally {
      close();
    }
  });
});

function listedNode(id: string, online: boolean, name = 'peer'): UplinkNodeList['nodes'][number] {
  return {
    id,
    name,
    online,
    endpoints: [],
    inventory: {},
    direct_capable: false,
    version: '2.2.4',
  };
}
