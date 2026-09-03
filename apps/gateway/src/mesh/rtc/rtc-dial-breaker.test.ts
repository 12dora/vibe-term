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
  RTC_DIAL_BREAKER_BASE_MS_DEFAULT,
  RTC_DIAL_BREAKER_FAILS,
  RTC_DIAL_BREAKER_HEALTHY_MS,
  RTC_DIAL_BREAKER_MAX_MS,
  RtcDialBreaker,
  classifyRtcDialFailure,
  isIntentionalDcLoss,
} from './rtc-dial-breaker';
import type { RtcPeerManager } from './rtc-peer-manager';

describe('RtcDialBreaker', () => {
  test('trips after 3 consecutive failures with 30s → 60s exponential cooldown', () => {
    const trips: Array<{
      peer: string;
      fails: number;
      level: number;
      cooldownMs: number;
      until: number;
    }> = [];
    let now = 1_000;
    const breaker = new RtcDialBreaker({
      now: () => now,
      breakerMs: 30_000,
      onTrip: (event) => trips.push(event),
    });
    const peer = 'ec42f3';
    expect(breaker.noteFailure(peer, 'timeout', 'a1')).toEqual({
      counted: true,
      opened: false,
      open: false,
    });
    expect(breaker.shouldTry(peer).allow).toBe(true);
    expect(breaker.noteFailure(peer, 'ice', 'a2')).toEqual({
      counted: true,
      opened: false,
      open: false,
    });
    const opened = breaker.noteFailure(peer, 'channel-closed', 'a3');
    expect(opened).toEqual({
      counted: true,
      opened: true,
      open: true,
      until: 1_000 + 30_000,
    });
    expect(breaker.shouldTry(peer)).toMatchObject({
      allow: false,
      cooling: true,
      until: 1_000 + 30_000,
      failures: 3,
      level: 1,
    });
    expect(trips).toEqual([
      { peer, fails: 3, level: 0, cooldownMs: 30_000, until: 1_000 + 30_000 },
    ]);
    expect(breaker.noteFailure(peer, 'timeout', 'a4')).toEqual({
      counted: true,
      opened: false,
      open: true,
      until: 1_000 + 30_000,
    });
    expect(trips).toHaveLength(1);

    now = 1_000 + 30_000;
    expect(breaker.shouldTry(peer).allow).toBe(true);
    expect(breaker.shouldTry(peer).cooling).toBe(false);
    expect(breaker.shouldTry(peer).level).toBe(1);

    const second = breaker.noteFailure(peer, 'timeout', 'a5');
    expect(second.opened).toBe(true);
    expect(second.until).toBe(now + 60_000);
    expect(trips).toHaveLength(2);
    expect(trips[1]).toMatchObject({ level: 1, cooldownMs: 60_000, fails: 5 });
  });

  test('dedupes noteFailure by attempt id and forceProbe allows one cooling attempt', () => {
    const now = 0;
    const breaker = new RtcDialBreaker({ now: () => now, breakerMs: 30_000 });
    const peer = 'hub-a';
    for (let i = 0; i < RTC_DIAL_BREAKER_FAILS; i += 1) {
      breaker.noteFailure(peer, 'timeout', `t${i}`);
    }
    expect(breaker.shouldTry(peer).allow).toBe(false);
    expect(breaker.noteFailure(peer, 'timeout', 't2').counted).toBe(false);
    breaker.forceProbe(peer);
    expect(breaker.shouldTry(peer).allow).toBe(true);
    expect(breaker.shouldTry(peer).cooling).toBe(true);
    breaker.beginAttempt(peer, 'probe-1');
    expect(breaker.shouldTry(peer).allow).toBe(false);
    breaker.noteFailure(peer, 'ice', 'probe-1');
    expect(breaker.shouldTry(peer).allow).toBe(false);
    expect(breaker.snapshot(peer).failures).toBe(RTC_DIAL_BREAKER_FAILS + 1);
  });

  test('short-lived channel is a failure; healthy ≥ 60s resets level once', () => {
    const resets: number[] = [];
    let now = 10;
    const breaker = new RtcDialBreaker({
      now: () => now,
      breakerMs: 30_000,
      onReset: (event) => resets.push(event.healthyMs),
    });
    const peer = 'p';
    breaker.noteFailure(peer, 'timeout', '1');
    breaker.noteFailure(peer, 'timeout', '2');
    breaker.noteChannelEstablished(peer, '3');
    now = 10 + RTC_DIAL_BREAKER_HEALTHY_MS - 1;
    expect(breaker.noteHealthy(peer)).toBe(false);
    breaker.noteFailure(peer, 'liveness-timeout', '3');
    expect(breaker.shouldTry(peer).failures).toBe(3);
    expect(breaker.shouldTry(peer).cooling).toBe(true);
    expect(resets).toEqual([]);

    now = breaker.shouldTry(peer).until ?? now;
    expect(breaker.shouldTry(peer).allow).toBe(true);
    breaker.noteChannelEstablished(peer, '4');
    now += RTC_DIAL_BREAKER_HEALTHY_MS;
    expect(breaker.noteHealthy(peer)).toBe(true);
    expect(breaker.shouldTry(peer)).toMatchObject({
      allow: true,
      cooling: false,
      failures: 0,
      level: 0,
    });
    expect(resets).toEqual([RTC_DIAL_BREAKER_HEALTHY_MS]);
    expect(breaker.noteHealthy(peer)).toBe(false);
  });

  test('notePeerChanged does not reset cooling', () => {
    let now = 10;
    const breaker = new RtcDialBreaker({ now: () => now, breakerMs: 60_000 });
    const peer = 'hub-a';
    for (let i = 0; i < RTC_DIAL_BREAKER_FAILS; i += 1) breaker.noteFailure(peer, 'x', `f${i}`);
    expect(breaker.shouldTry(peer).allow).toBe(false);
    breaker.notePeerChanged(peer);
    expect(breaker.shouldTry(peer).allow).toBe(false);
    now = 10 + 60_000;
    expect(breaker.shouldTry(peer).allow).toBe(true);
  });

  test('cooldown is capped at 30 min and skip is per-peer', () => {
    const breaker = new RtcDialBreaker({ now: () => 0, breakerMs: 30_000 });
    for (let i = 0; i < 20; i += 1) breaker.noteFailure('a', 'timeout', `a${i}`);
    const until = breaker.shouldTry('a').until ?? 0;
    expect(until).toBeLessThanOrEqual(RTC_DIAL_BREAKER_MAX_MS);
    expect(breaker.shouldTry('b').allow).toBe(true);
  });

  test('classifies close reasons and ignores intentional drops', () => {
    expect(classifyRtcDialFailure('datachannel open timeout')).toBe('timeout');
    expect(classifyRtcDialFailure('ice failed')).toBe('ice');
    expect(classifyRtcDialFailure('liveness-timeout')).toBe('liveness-timeout');
    expect(classifyRtcDialFailure('missed-pong')).toBe('missed-pong');
    expect(classifyRtcDialFailure('channel-closed')).toBe('channel-closed');
    expect(classifyRtcDialFailure('fragment-protocol')).toBe('protocol');
    expect(isIntentionalDcLoss('stopped')).toBe(true);
    expect(isIntentionalDcLoss('revoked')).toBe(true);
    expect(isIntentionalDcLoss('idle')).toBe(true);
    expect(isIntentionalDcLoss('replaced')).toBe(true);
    expect(isIntentionalDcLoss('liveness-timeout')).toBe(false);
    expect(RTC_DIAL_BREAKER_BASE_MS_DEFAULT).toBe(30_000);
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

  test('3 consecutive DC failures stop RTC while ws-secure is still selected', async () => {
    const { manager, peer, dcCalls } = await setupManager();
    await tripBreaker(manager, peer.nodeId, dcCalls);
    expect(dcCalls()).toBeGreaterThanOrEqual(RTC_DIAL_BREAKER_FAILS);
    const frozen = dcCalls();
    const link = await manager.getLink(peer.nodeId);
    expect(dcCalls()).toBe(frozen);
    expect(manager.transportOf(peer.nodeId)).toBe('ws-secure');
    expect(link).toBeTruthy();
    const detail = manager.linkDetailOf(peer.nodeId);
    expect(detail.dcBreaker.cooling).toBe(true);
    expect(detail.dcBreaker.failures).toBeGreaterThanOrEqual(RTC_DIAL_BREAKER_FAILS);
    expect(detail.dcBreaker.level).toBeGreaterThanOrEqual(1);
  });

  test('short-lived DC does not reset the breaker; cooling keeps relay/ws-secure', async () => {
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
    const frozen = dcCalls();
    await manager.getLink(peer.nodeId);
    expect(dcCalls()).toBe(frozen);
    expect(manager.transportOf(peer.nodeId)).toBe('ws-secure');
    expect(manager.linkDetailOf(peer.nodeId).dcBreaker.cooling).toBe(true);
  });

  test('endpoint/direct-capable change does not reset the breaker', async () => {
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
    expect(dcCalls()).toBe(frozen);
  });

  test('forced probe allows exactly one DC attempt during cooldown', async () => {
    const { manager, peer, dcCalls } = await setupManager();
    await tripBreaker(manager, peer.nodeId, dcCalls);
    const frozen = dcCalls();
    await manager.getLink(peer.nodeId);
    expect(dcCalls()).toBe(frozen);
    manager.forceDcProbe(peer.nodeId);
    await waitUntil(() => dcCalls() > frozen);
    expect(dcCalls()).toBe(frozen + 1);
    await manager.getLink(peer.nodeId);
    expect(dcCalls()).toBe(frozen + 1);
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
