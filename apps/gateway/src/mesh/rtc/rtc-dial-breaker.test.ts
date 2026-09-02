import { afterEach, describe, expect, test } from 'bun:test';
import { createInMemoryLinkPair } from '@tmex/shared/link';
import { createMigratedAuthDb } from '../../auth/test-db';
import { UserStore } from '../../auth/user-store';
import { encodeJsonBytes } from '../ctl';
import { PeerManager } from '../peer-manager';
import { seedNodeIdentity, seedUser, waitUntil } from '../test-support';
import type { UplinkStatus } from '../types';
import { UplinkClient } from '../uplink-client';
import {
  RTC_DIAL_BREAKER_FAILS,
  RTC_DIAL_BREAKER_MS_DEFAULT,
  RtcDialBreaker,
} from './rtc-dial-breaker';
import type { RtcPeerManager } from './rtc-peer-manager';

describe('RtcDialBreaker', () => {
  test('opens after 8 consecutive DataChannel failures and skips until expiry', () => {
    const logs: Array<{ peer: string; fails: number; until: number }> = [];
    const breaker = new RtcDialBreaker({
      now: () => 1_000,
      breakerMs: 6 * 60 * 60 * 1000,
      onOpen: (event) => logs.push(event),
    });
    const peer = 'ec42f3';
    for (let i = 0; i < RTC_DIAL_BREAKER_FAILS - 1; i += 1) {
      expect(breaker.noteFailure(peer)).toEqual({ opened: false, open: false });
      expect(breaker.shouldSkip(peer)).toBe(false);
    }
    const opened = breaker.noteFailure(peer);
    expect(opened).toEqual({
      opened: true,
      open: true,
      until: 1_000 + RTC_DIAL_BREAKER_MS_DEFAULT,
    });
    expect(breaker.shouldSkip(peer)).toBe(true);
    expect(logs).toEqual([
      { peer, fails: RTC_DIAL_BREAKER_FAILS, until: 1_000 + RTC_DIAL_BREAKER_MS_DEFAULT },
    ]);
    expect(breaker.noteFailure(peer)).toEqual({
      opened: false,
      open: true,
      until: 1_000 + RTC_DIAL_BREAKER_MS_DEFAULT,
    });
    expect(logs).toHaveLength(1);
  });

  test('resets on success or advertised endpoint/capability change', () => {
    let now = 10;
    const breaker = new RtcDialBreaker({ now: () => now, breakerMs: 60_000 });
    const peer = 'hub-a';
    for (let i = 0; i < RTC_DIAL_BREAKER_FAILS; i += 1) breaker.noteFailure(peer);
    expect(breaker.shouldSkip(peer)).toBe(true);
    breaker.noteSuccess(peer);
    expect(breaker.shouldSkip(peer)).toBe(false);

    for (let i = 0; i < RTC_DIAL_BREAKER_FAILS; i += 1) breaker.noteFailure(peer);
    expect(breaker.shouldSkip(peer)).toBe(true);
    breaker.notePeerChanged(peer);
    expect(breaker.shouldSkip(peer)).toBe(false);

    for (let i = 0; i < RTC_DIAL_BREAKER_FAILS; i += 1) breaker.noteFailure(peer);
    now = 10 + 60_000;
    expect(breaker.shouldSkip(peer)).toBe(false);
  });

  test('does not skip ws-secure peers: skip is per-peer DataChannel only', () => {
    const breaker = new RtcDialBreaker({ now: () => 0 });
    for (let i = 0; i < RTC_DIAL_BREAKER_FAILS; i += 1) breaker.noteFailure('a');
    expect(breaker.shouldSkip('a')).toBe(true);
    expect(breaker.shouldSkip('b')).toBe(false);
  });
});

describe('PeerManager DataChannel breaker', () => {
  const fixtures: Array<{ close: () => void; stop?: () => Promise<void> }> = [];
  afterEach(async () => {
    while (fixtures.length) {
      const item = fixtures.pop();
      await item?.stop?.();
      item?.close();
    }
    delete process.env.TMEX_RTC_DIAL_BREAKER_MS;
  });

  function dummyUplink(
    identity: { nodeId: string; edSecretKey: Uint8Array },
    userStore: UserStore
  ): UplinkClient {
    return new UplinkClient({
      hubUrl: 'https://hub.example.com',
      identity,
      userId: 'user-1',
      keyLogApplier: {
        async head() {
          return { seq: 0n, hash: new Uint8Array(32) };
        },
        async applyMany() {
          return { applied: 0 };
        },
      },
      userStore,
      statusProvider: (): UplinkStatus => ({
        version: '1',
        tmux: false,
        direct_capable: false,
        inventory: {},
        endpoints: [],
      }),
      wsFactory: () => {
        throw new Error('no-ws');
      },
    });
  }

  function echoQuiesceCaps(session: import('@tmex/shared/link').LinkSession): void {
    let helloReplied = false;
    session.ctl.onMessage((bytes) => {
      let msg: { t?: string };
      try {
        msg = JSON.parse(new TextDecoder().decode(bytes)) as { t?: string };
      } catch {
        return;
      }
      if (msg.t === 'link.hello' && !helloReplied) {
        helloReplied = true;
        session.ctl.send(
          new TextEncoder().encode(JSON.stringify({ t: 'link.hello', caps: ['quiesce'] }))
        );
      }
      if (msg.t === 'link.quiesce.probe') {
        session.ctl.send(new TextEncoder().encode(JSON.stringify({ t: 'link.quiesce.probe.ack' })));
      }
    });
  }

  async function setupManager(opts?: { breakerMs?: string }) {
    if (opts?.breakerMs) process.env.TMEX_RTC_DIAL_BREAKER_MS = opts.breakerMs;
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
      directCapable: true,
      lastSeenAt: Date.now(),
      listVersion: 1,
    });
    let dcCalls = 0;
    const rtc = {
      available: true,
      connectToPeer: async () => {
        dcCalls += 1;
        throw new Error('dc-fail');
      },
    } as unknown as RtcPeerManager;
    const remotes: Array<import('@tmex/shared/link').LinkSession> = [];
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store),
      peerPort: 0,
      startServer: false,
      rtc,
      linkFactory: async () => {
        const [local, remote] = createInMemoryLinkPair();
        echoQuiesceCaps(remote);
        remotes.push(remote);
        return local;
      },
    });
    fixtures.push({ close, stop: () => manager.stop() });
    return { manager, peer, store, dcCalls: () => dcCalls, remotes };
  }

  async function dropLive(manager: PeerManager, peerNodeId: string): Promise<void> {
    if (!manager.transportOf(peerNodeId)) return;
    const link = await manager.getLink(peerNodeId);
    link.close('drop');
    await waitUntil(() => manager.transportOf(peerNodeId) === null);
  }

  async function tripBreaker(
    manager: PeerManager,
    peerNodeId: string,
    dcCalls: () => number
  ): Promise<void> {
    await dropLive(manager, peerNodeId);
    const start = dcCalls();
    while (dcCalls() - start < RTC_DIAL_BREAKER_FAILS) {
      const link = await manager.getLink(peerNodeId);
      expect(manager.transportOf(peerNodeId)).toBe('ws-secure');
      link.close('drop');
      await waitUntil(() => manager.transportOf(peerNodeId) === null);
    }
  }

  test('8 consecutive DC failures stop RTC while ws-secure is still selected', async () => {
    const { manager, peer, dcCalls } = await setupManager();
    await tripBreaker(manager, peer.nodeId, dcCalls);
    expect(dcCalls()).toBeGreaterThanOrEqual(RTC_DIAL_BREAKER_FAILS);
    const frozen = dcCalls();
    const link = await manager.getLink(peer.nodeId);
    expect(dcCalls()).toBe(frozen);
    expect(manager.transportOf(peer.nodeId)).toBe('ws-secure');
    expect(link).toBeTruthy();
  });

  test('recovers RTC dials after a successful DC session', async () => {
    const { manager, peer, dcCalls } = await setupManager();
    await tripBreaker(manager, peer.nodeId, dcCalls);
    const afterTrip = dcCalls();
    await manager.getLink(peer.nodeId);
    expect(dcCalls()).toBe(afterTrip);
    const [dcLocal, dcRemote] = createInMemoryLinkPair();
    echoQuiesceCaps(dcRemote);
    expect(manager.adoptLink(peer.nodeId, dcLocal, 'dc', peer.nodeId)).toBe(dcLocal);
    dcLocal.close('drop-dc');
    await waitUntil(() => manager.transportOf(peer.nodeId) !== 'dc');
    await manager.getLink(peer.nodeId);
    await waitUntil(() => dcCalls() > afterTrip);
  });

  test('recovers RTC dials after advertised endpoint/direct-capable change', async () => {
    const { manager, peer, remotes, dcCalls, store } = await setupManager();
    await tripBreaker(manager, peer.nodeId, dcCalls);
    const frozen = dcCalls();
    await manager.getLink(peer.nodeId);
    expect(dcCalls()).toBe(frozen);
    await waitUntil(() => manager.quiesceCapableOf(peer.nodeId));
    const liveRemote = remotes.at(-1);
    expect(liveRemote).toBeTruthy();
    liveRemote?.ctl.send(
      encodeJsonBytes({
        t: 'node.status',
        endpoints: ['ws://127.0.0.1:9/peer'],
        inventory: {},
        direct_capable: true,
      })
    );
    await waitUntil(() => {
      const cached = store.listPeers().find((row) => row.nodeId === peer.nodeId);
      return Boolean(cached?.endpointsJson && cached.endpointsJson !== '[]');
    });
    await dropLive(manager, peer.nodeId);
    await manager.getLink(peer.nodeId);
    expect(dcCalls()).toBeGreaterThan(frozen);
  });

  test('recovers RTC dials after breaker expiry', async () => {
    const { manager, peer, dcCalls } = await setupManager({ breakerMs: '40' });
    await tripBreaker(manager, peer.nodeId, dcCalls);
    const frozen = dcCalls();
    await dropLive(manager, peer.nodeId);
    await Bun.sleep(50);
    await manager.getLink(peer.nodeId);
    expect(dcCalls()).toBeGreaterThan(frozen);
  });
});
