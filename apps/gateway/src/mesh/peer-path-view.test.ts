import { afterEach, describe, expect, test } from 'bun:test';
import { createInMemoryLinkPair } from '@vibeterm/shared/link';
import { createMigratedAuthDb } from '../auth/test-db';
import { UserStore } from '../auth/user-store';
import { PeerManager } from './peer-manager';
import { peerLinkDetailOf, relayPresenceOfIndex, viaRelayOfLive } from './peer-path-view';
import type { LivePeer } from './peer-reconnect-wake';
import { dummyUplink } from './peer-test-fixtures';
import type { RelayPresenceIndex } from './relay-presence-types';
import { ImmediateScheduler, seedNodeIdentity, seedUser } from './test-support';

function live(partial: Partial<LivePeer> & Pick<LivePeer, 'transport'>): LivePeer {
  return {
    session: createInMemoryLinkPair()[0],
    peerNodeId: 'aa'.repeat(16),
    initiatedBy: 'bb'.repeat(16),
    generation: 1,
    streams: 0,
    lastStreamAt: 0,
    idleTimer: null,
    pingTimer: null,
    missedPongs: 0,
    lastInboundFrameAt: 0,
    retiring: false,
    retireReason: '',
    retiredAt: 0,
    zeroStreamsSince: 0,
    gotQuiesceAck: false,
    gotPeerQuiesce: false,
    retireTimer: null,
    finishRetired: false,
    lastAdvertisedStatusJson: '',
    unsubRtc: null,
    quiesceCapable: false,
    helloReplied: false,
    probeSent: false,
    remoteAddress: null,
    rttMs: null,
    pingSentAt: null,
    lastRttEmitAt: 0,
    lastEmittedRttMs: null,
    linkSinceAt: 1,
    dcAttemptId: null,
    ...partial,
  };
}

describe('peer path view', () => {
  test('viaRelayOfLive is only set for live relay sessions', () => {
    expect(viaRelayOfLive(undefined)).toBeNull();
    expect(viaRelayOfLive(live({ transport: 'dc', viaRelay: 'https://x' }))).toBeNull();
    expect(viaRelayOfLive(live({ transport: 'relay' }))).toBeNull();
    expect(viaRelayOfLive(live({ transport: 'relay', viaRelay: 'https://sh.example' }))).toBe(
      'https://sh.example'
    );
  });

  test('relayPresenceOfIndex omits the field when the index is missing', () => {
    expect(relayPresenceOfIndex(undefined, 'aa'.repeat(16))).toBeUndefined();
    const index: RelayPresenceIndex = {
      snapshot: () => [],
      primaryUrl: () => 'https://sh.example',
      relaysFor: (id) =>
        id === 'aa'.repeat(16) ? ['https://sh.example', 'https://ty.example'] : [],
      chooseRelay: () => null,
      onlineUnion: () => new Set(),
    };
    expect(relayPresenceOfIndex(index, 'aa'.repeat(16))).toEqual([
      'https://sh.example',
      'https://ty.example',
    ]);
    expect(relayPresenceOfIndex(index, 'cc'.repeat(16))).toEqual([]);
  });

  test('peerLinkDetailOf copies viaRelay and relayPresence', () => {
    const detail = peerLinkDetailOf({
      live: live({ transport: 'relay', viaRelay: 'https://ty.example' }),
      hubHost: 'hub.example',
      lastDirectAttempt: undefined,
      dcBreaker: {
        cooling: false,
        until: null,
        failures: 0,
        level: 0,
        lastFailureKind: null,
        disabled: false,
      },
      relayPresence: {
        snapshot: () => [],
        primaryUrl: () => 'https://sh.example',
        relaysFor: () => ['https://ty.example'],
        chooseRelay: () => null,
        onlineUnion: () => new Set(),
      },
      nodeId: 'aa'.repeat(16),
    });
    expect(detail.viaRelay).toBe('https://ty.example');
    expect(detail.relayPresence).toEqual(['https://ty.example']);
    expect(detail.peerAddress).toBe('hub.example');
  });
});

describe('PeerManager viaRelayOf / relayPresenceOf', () => {
  const fixtures: Array<{ close: () => void; stop?: () => Promise<void> }> = [];
  afterEach(async () => {
    while (fixtures.length) {
      const item = fixtures.pop();
      await item?.stop?.();
      item?.close();
    }
  });

  test('siblings of transportOf read live.viaRelay and the presence index', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const peer = seedNodeIdentity(store, 'user-1');
    store.upsertPeer({
      nodeId: peer.nodeId,
      name: 'peer',
      endpointsJson: '[]',
      inventoryJson: '{}',
      directCapable: false,
      lastSeenAt: Date.now(),
      listVersion: 1,
    });
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store),
      peerPort: 0,
      startServer: false,
      scheduler: new ImmediateScheduler(),
    });
    fixtures.push({ close, stop: () => manager.stop() });
    const [local] = createInMemoryLinkPair();
    expect(manager.adoptLink(peer.nodeId, local, 'relay', self.nodeId)).toBe(local);
    expect(manager.viaRelayOf(peer.nodeId)).toBeNull();
    expect(manager.relayPresenceOf(peer.nodeId)).toBeUndefined();

    const state = (
      manager as unknown as {
        state: { live: Map<string, LivePeer>; relayPresence?: RelayPresenceIndex };
      }
    ).state;
    const row = state.live.get(peer.nodeId);
    if (!row) throw new Error('missing live');
    row.viaRelay = 'https://sh.example';
    expect(manager.viaRelayOf(peer.nodeId)).toBe('https://sh.example');
    expect(manager.linkDetailOf(peer.nodeId).viaRelay).toBe('https://sh.example');

    state.relayPresence = {
      snapshot: () => [],
      primaryUrl: () => 'https://sh.example',
      relaysFor: () => ['https://sh.example', 'https://ty.example'],
      chooseRelay: () => null,
      onlineUnion: () => new Set(),
    };
    expect(manager.relayPresenceOf(peer.nodeId)).toEqual([
      'https://sh.example',
      'https://ty.example',
    ]);
    expect(manager.linkDetailOf(peer.nodeId).relayPresence).toEqual([
      'https://sh.example',
      'https://ty.example',
    ]);
  });
});
