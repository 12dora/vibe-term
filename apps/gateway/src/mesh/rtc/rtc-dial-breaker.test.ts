import { afterEach, describe, expect, test } from 'bun:test';
import { createInMemoryLinkPair } from '@vibeterm/shared/link';
import { createMigratedAuthDb } from '../../auth/test-db';
import { UserStore } from '../../auth/user-store';
import { encodeJsonBytes } from '../ctl';
import { settleAbandonedDcDial } from '../peer-dial-race';
import { PeerManager } from '../peer-manager';
import { dummyUplink, echoQuiesceCaps } from '../peer-test-fixtures';
import { seedNodeIdentity, seedUser, waitUntil } from '../test-support';
import {
  ANSWERER_COOLDOWN_MS,
  ANSWERER_TIMEOUT_LIMIT,
  DC_REARM_SOURCES,
  RTC_DIAL_BREAKER_BASE_MS_DEFAULT,
  RTC_DIAL_BREAKER_FAILS,
  RTC_DIAL_BREAKER_HEALTHY_MS,
  RTC_DIAL_BREAKER_MAX_MS,
  RTC_DIAL_DISABLE_AFTER_DEFAULT,
  RTC_DIAL_FORCE_PROBE_MS,
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

  test('beginAttempt and noteFailure are idempotent per peer+attemptId', () => {
    const breaker = new RtcDialBreaker({ now: () => 0 });
    const peer = 'p';
    breaker.beginAttempt(peer, 'dc:1');
    breaker.beginAttempt(peer, 'dc:1');
    expect(breaker.noteFailure(peer, 'timeout', 'dc:1').counted).toBe(true);
    expect(breaker.noteFailure(peer, 'timeout', 'dc:1').counted).toBe(false);
    expect(breaker.snapshot(peer).failures).toBe(1);
  });

  test('settleAbandonedDcDial cannot double-charge the same attempt', async () => {
    const breaker = new RtcDialBreaker({ now: () => 0 });
    const peer = 'p';
    breaker.beginAttempt(peer, 'dc:1');
    const note = (reason: string) => {
      breaker.noteFailure(peer, classifyRtcDialFailure(reason), 'dc:1');
    };
    const failed = Promise.reject(new Error('timeout'));
    failed.catch(() => undefined);
    await settleAbandonedDcDial(failed, note);
    await settleAbandonedDcDial(failed, note);
    expect(breaker.noteFailure(peer, 'timeout', 'dc:1').counted).toBe(false);
    expect(breaker.snapshot(peer).failures).toBe(1);

    breaker.beginAttempt(peer, 'dc:2');
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const aborted = Promise.reject(abort);
    aborted.catch(() => undefined);
    await settleAbandonedDcDial(aborted, (reason) => {
      breaker.noteFailure(peer, classifyRtcDialFailure(reason), 'dc:2');
    });
    expect(breaker.snapshot(peer).failures).toBe(1);
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
    expect(
      classifyRtcDialFailure('Unexpected remote answer description in signaling state stable')
    ).toBe('signaling-state');
    expect(classifyRtcDialFailure('signal dropped: duplicate answer')).toBe('signal-dropped');
    expect(isIntentionalDcLoss('stopped')).toBe(true);
    expect(isIntentionalDcLoss('revoked')).toBe(true);
    expect(isIntentionalDcLoss('idle')).toBe(true);
    expect(isIntentionalDcLoss('replaced')).toBe(true);
    expect(isIntentionalDcLoss('superseded')).toBe(true);
    expect(isIntentionalDcLoss('liveness-timeout')).toBe(false);
    expect(RTC_DIAL_BREAKER_BASE_MS_DEFAULT).toBe(30_000);
    expect(RTC_DIAL_DISABLE_AFTER_DEFAULT).toBe(10);
    expect(RTC_DIAL_FORCE_PROBE_MS).toBe(600_000);
  });

  test('peer-initiated timeout is uncounted only when no remote SDP was applied', () => {
    const trips: Array<{ level: number }> = [];
    const breaker = new RtcDialBreaker({
      now: () => 1_000,
      breakerMs: 30_000,
      onTrip: (event) => trips.push({ level: event.level }),
    });
    const peer = 'answerer';
    const noRemote = breaker.noteFailure(peer, 'timeout', 'no-sdp', undefined, {
      peerInitiated: true,
      stage: 'no-remote-sdp',
      remoteSdpApplied: false,
    });
    expect(noRemote.counted).toBe(false);
    expect(noRemote.opened).toBe(false);
    expect(breaker.shouldTry(peer)).toMatchObject({
      allow: true,
      cooling: false,
      failures: 0,
      level: 0,
    });
    expect(breaker.snapshot(peer).lastFailureKind).toBe('timeout');
    expect(trips).toEqual([]);

    const dtls = breaker.noteFailure(peer, 'timeout', 'dtls', undefined, {
      peerInitiated: true,
      stage: 'dtls',
      remoteSdpApplied: true,
    });
    expect(dtls.counted).toBe(true);
    const handshake = breaker.noteFailure(peer, 'timeout', 'handshake', undefined, {
      peerInitiated: true,
      stage: 'handshake',
      remoteSdpApplied: true,
    });
    expect(handshake.counted).toBe(true);
    expect(breaker.shouldTry(peer).failures).toBe(2);
    expect(breaker.shouldTry(peer).cooling).toBe(false);

    const third = breaker.noteFailure(peer, 'timeout', 'handshake-2', undefined, {
      peerInitiated: true,
      stage: 'handshake',
      remoteSdpApplied: true,
    });
    expect(third.counted).toBe(true);
    expect(third.opened).toBe(true);
    expect(breaker.shouldTry(peer).cooling).toBe(true);
    expect(trips).toHaveLength(1);
  });

  test('peer-initiated timeouts trip answerer backoff without opening the offerer breaker', () => {
    let now = 5_000;
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    const breaker = new RtcDialBreaker({ now: () => now, breakerMs: 30_000 });
    const peer = 'ec42f364';
    try {
      for (let i = 0; i < ANSWERER_TIMEOUT_LIMIT - 1; i += 1) {
        const result = breaker.noteFailure(peer, 'datachannel open timeout', `a${i}`, undefined, {
          peerInitiated: true,
          stage: 'checking',
          remoteSdpApplied: true,
        });
        expect(result.counted).toBe(true);
        expect(breaker.shouldAcceptAnswer(peer)).toBe(true);
      }
      const third = breaker.noteFailure(peer, 'datachannel open timeout', 'a2', undefined, {
        peerInitiated: true,
        stage: 'checking',
        remoteSdpApplied: true,
      });
      expect(third.counted).toBe(true);
      expect(breaker.shouldAcceptAnswer(peer)).toBe(false);
      expect(breaker.shouldTry(peer).cooling).toBe(true);
      expect(
        lines.filter((row) => row.includes('answerer_backoff') && row.includes(`peer=${peer}`))
      ).toHaveLength(1);

      const uncounted = new RtcDialBreaker({ now: () => now });
      const other = 'dead-hub';
      for (let i = 0; i < ANSWERER_TIMEOUT_LIMIT; i += 1) {
        expect(
          uncounted.noteFailure(other, 'timeout', `n${i}`, undefined, {
            peerInitiated: true,
            stage: 'no-remote-sdp',
            remoteSdpApplied: false,
          }).counted
        ).toBe(false);
      }
      expect(uncounted.shouldTry(other)).toMatchObject({
        allow: true,
        cooling: false,
        failures: 0,
      });
      expect(uncounted.shouldAcceptAnswer(other)).toBe(false);
      now += ANSWERER_COOLDOWN_MS[0];
      expect(uncounted.shouldAcceptAnswer(other)).toBe(true);
      uncounted.noteChannelEstablished(other, 'ok');
      expect(uncounted.shouldAcceptAnswer(other)).toBe(true);
    } finally {
      console.log = orig;
    }
  });

  test('peer-initiated ice failures still count toward the trip', () => {
    const breaker = new RtcDialBreaker({ now: () => 0, breakerMs: 30_000 });
    const peer = 'p';
    expect(
      breaker.noteFailure(peer, 'ice failed', 'a1', undefined, { peerInitiated: true }).counted
    ).toBe(true);
    expect(
      breaker.noteFailure(peer, 'ice failed', 'a2', undefined, { peerInitiated: true }).counted
    ).toBe(true);
    const third = breaker.noteFailure(peer, 'ice failed', 'a3', undefined, { peerInitiated: true });
    expect(third.counted).toBe(true);
    expect(third.opened).toBe(true);
    expect(breaker.shouldTry(peer).cooling).toBe(true);
  });

  test('does not count local signaling-state failures', () => {
    const breaker = new RtcDialBreaker({ now: () => 0, disableAfter: 1 });
    const peer = 'p';
    expect(
      breaker.noteFailure(
        peer,
        'Unexpected remote answer description in signaling state stable',
        'a1'
      )
    ).toEqual({ counted: false, opened: false, open: false });
    expect(breaker.noteFailure(peer, 'signal dropped', 'a2')).toEqual({
      counted: false,
      opened: false,
      open: false,
    });
    expect(breaker.snapshot(peer)).toMatchObject({ failures: 0, disabled: false });
  });

  test('enters disabled after N consecutive fully-failed rounds', () => {
    const disables: Array<{ peer: string; fails: number }> = [];
    const breaker = new RtcDialBreaker({
      now: () => 1,
      disableAfter: 4,
      failLimit: 10,
      onDisable: (event) => disables.push({ peer: event.peer, fails: event.fails }),
    });
    const peer = 'ec42f3';
    for (let i = 0; i < 3; i += 1) {
      breaker.noteFailure(peer, 'timeout', `f${i}`);
      expect(breaker.isDisabled(peer)).toBe(false);
      expect(breaker.shouldTry(peer).allow).toBe(true);
    }
    breaker.noteFailure(peer, 'timeout', 'f3');
    expect(breaker.isDisabled(peer)).toBe(true);
    expect(breaker.shouldTry(peer)).toMatchObject({ allow: false, disabled: true, failures: 4 });
    expect(breaker.snapshot(peer).disabled).toBe(true);
    expect(disables).toEqual([{ peer, fails: 4 }]);
    expect(breaker.shouldTry('other').allow).toBe(true);
  });

  test('disabled stays off after cooldown until a wake source re-arms', () => {
    let now = 10;
    const rearms: string[] = [];
    const breaker = new RtcDialBreaker({
      now: () => now,
      breakerMs: 30_000,
      disableAfter: 3,
      onRearm: (event) => rearms.push(event.source),
    });
    const peer = 'hub-a';
    for (let i = 0; i < 3; i += 1) breaker.noteFailure(peer, 'timeout', `f${i}`);
    expect(breaker.isDisabled(peer)).toBe(true);
    now = 10 + 30_000;
    expect(breaker.shouldTry(peer).allow).toBe(false);
    expect(breaker.shouldTry(peer).disabled).toBe(true);

    expect(breaker.rearmDisabled(peer, 'local-fingerprint')).toBe(true);
    expect(breaker.isDisabled(peer)).toBe(false);
    expect(breaker.shouldTry(peer).allow).toBe(true);
    expect(breaker.shouldTry(peer).failures).toBe(0);
    expect(breaker.rearmDisabled(peer, 'peer-endpoint')).toBe(false);

    for (const source of DC_REARM_SOURCES) {
      for (let i = 0; i < 3; i += 1) breaker.noteFailure(peer, 'timeout', `${source}-${i}`);
      expect(breaker.isDisabled(peer)).toBe(true);
      if (source === 'local-fingerprint' || source === 'hub-switch') {
        expect(breaker.rearmAllDisabled(source)).toEqual([peer]);
      } else {
        expect(breaker.rearmDisabled(peer, source)).toBe(true);
      }
      expect(breaker.isDisabled(peer)).toBe(false);
      expect(breaker.shouldTry(peer).allow).toBe(true);
    }
    expect(rearms).toEqual([
      'local-fingerprint',
      'local-fingerprint',
      'peer-endpoint',
      'hub-switch',
      'peer-reconnect',
      'manual',
    ]);
  });

  test('forceProbe rearms disabled and notePeerChanged does not', () => {
    const breaker = new RtcDialBreaker({ now: () => 0, disableAfter: 3, breakerMs: 30_000 });
    const peer = 'p';
    for (let i = 0; i < 3; i += 1) breaker.noteFailure(peer, 'x', `f${i}`);
    expect(breaker.shouldTry(peer).allow).toBe(false);
    breaker.notePeerChanged(peer);
    expect(breaker.isDisabled(peer)).toBe(true);
    expect(breaker.shouldTry(peer).allow).toBe(false);
    breaker.forceProbe(peer);
    expect(breaker.isDisabled(peer)).toBe(false);
    expect(breaker.shouldTry(peer).allow).toBe(true);
  });

  test('allows one automatic force probe every 10 minutes while disabled', () => {
    let now = 0;
    const breaker = new RtcDialBreaker({
      now: () => now,
      disableAfter: 1,
      breakerMs: 30_000,
    });
    const peer = 'p';
    breaker.noteFailure(peer, 'timeout', 'f1');
    expect(breaker.shouldTry(peer)).toMatchObject({ allow: false, disabled: true });

    now = RTC_DIAL_FORCE_PROBE_MS - 1;
    expect(breaker.shouldTry(peer)).toMatchObject({ allow: false, disabled: true });
    now += 1;
    expect(breaker.shouldTry(peer)).toMatchObject({ allow: true, disabled: true });
    expect(breaker.shouldTry(peer)).toMatchObject({ allow: true, disabled: true });
    expect(breaker.isDisabled(peer)).toBe(true);

    breaker.beginAttempt(peer, 'probe-1');
    expect(breaker.shouldTry(peer)).toMatchObject({ allow: false, disabled: true });
    breaker.noteFailure(peer, 'ice', 'probe-1');
    now += RTC_DIAL_FORCE_PROBE_MS - 1;
    expect(breaker.shouldTry(peer).allow).toBe(false);
    now += 1;
    expect(breaker.shouldTry(peer)).toMatchObject({ allow: true, disabled: true });
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
    delete process.env.VIBETERM_RTC_DIAL_BREAKER_MS;
    delete process.env.VIBETERM_RTC_DIAL_DISABLE_AFTER;
  });

  async function setupManager(opts?: { breakerMs?: string; disableAfter?: string }) {
    if (opts?.breakerMs) process.env.VIBETERM_RTC_DIAL_BREAKER_MS = opts.breakerMs;
    if (opts?.disableAfter) process.env.VIBETERM_RTC_DIAL_DISABLE_AFTER = opts.disableAfter;
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
    const remotes: Array<import('@vibeterm/shared/link').LinkSession> = [];
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store, undefined, {
        wsFactory: () => {
          throw new Error('no-ws');
        },
      }),
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
    dcCalls: () => number,
    opts: { keepFinalLive?: boolean } = {}
  ): Promise<void> {
    await dropLive(manager, peerNodeId);
    const start = dcCalls();
    while (dcCalls() - start < RTC_DIAL_BREAKER_FAILS) {
      const link = await manager.getLink(peerNodeId);
      expect(manager.transportOf(peerNodeId)).toBe('ws-secure');
      if (opts.keepFinalLive && dcCalls() - start >= RTC_DIAL_BREAKER_FAILS) return;
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
    await waitUntil(() => manager.quiesceCapableOf(peer.nodeId));
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

  test('disabled DC upgrade keeps ws-secure and does not redial after cooldown', async () => {
    const { manager, peer, dcCalls } = await setupManager({
      breakerMs: '40',
      disableAfter: String(RTC_DIAL_BREAKER_FAILS),
    });
    await tripBreaker(manager, peer.nodeId, dcCalls, { keepFinalLive: true });
    expect(manager.linkDetailOf(peer.nodeId).dcBreaker.disabled).toBe(true);
    const frozen = dcCalls();
    await Bun.sleep(50);
    const link = await manager.getLink(peer.nodeId);
    expect(dcCalls()).toBe(frozen);
    expect(manager.transportOf(peer.nodeId)).toBe('ws-secure');
    expect(link).toBeTruthy();
    manager.forceDcProbe(peer.nodeId);
    await waitUntil(() => dcCalls() > frozen);
    expect(dcCalls()).toBe(frozen + 1);
    expect(manager.transportOf(peer.nodeId)).toBe('ws-secure');
  });

  test('disabled DC upgrade retries immediately after the same endpoint reconnects', async () => {
    const { manager, peer, dcCalls } = await setupManager({
      breakerMs: '60000',
      disableAfter: String(RTC_DIAL_BREAKER_FAILS),
    });
    await tripBreaker(manager, peer.nodeId, dcCalls, { keepFinalLive: true });
    expect(manager.linkDetailOf(peer.nodeId).dcBreaker.disabled).toBe(true);
    const frozen = dcCalls();

    await dropLive(manager, peer.nodeId);
    const link = await manager.getLink(peer.nodeId);
    await waitUntil(() => dcCalls() > frozen);

    expect(dcCalls()).toBe(frozen + 1);
    expect(manager.linkDetailOf(peer.nodeId).dcBreaker.disabled).toBe(false);
    expect(manager.transportOf(peer.nodeId)).toBe('ws-secure');
    expect(link).toBeTruthy();
  });

  test('a second DC dial joins or skips the in-flight attempt instead of opening another PC', async () => {
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
    const rejectors: Array<(err: Error) => void> = [];
    const rtc = {
      available: true,
      currentIceConfig: () => ({ stun: [] as string[], turn: null }),
      connectToPeer: () => {
        dcCalls += 1;
        return new Promise((_resolve, reject) => {
          rejectors.push((err) => reject(err));
        });
      },
    } as unknown as RtcPeerManager;
    const remotes: Array<import('@vibeterm/shared/link').LinkSession> = [];
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store, undefined, {
        wsFactory: () => {
          throw new Error('no-ws');
        },
      }),
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
    const first = manager.getLink(peer.nodeId);
    await waitUntil(() => dcCalls === 1);
    manager.forceDcProbe(peer.nodeId);
    await Bun.sleep(20);
    expect(dcCalls).toBe(1);
    rejectors[0]?.(new Error('dc-fail'));
    await first;
    expect(manager.transportOf(peer.nodeId)).toBe('ws-secure');
  });

  test('an aborted DC dial releases the single-flight slot so forceDcProbe can start another', async () => {
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
      currentIceConfig: () => ({ stun: [] as string[], turn: null }),
      ready: async () => true,
      connectToPeer: (_id: string, _signaling: unknown, opts?: { signal?: AbortSignal }) => {
        dcCalls += 1;
        return new Promise((_resolve, reject) => {
          const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          if (opts?.signal?.aborted) fail();
          else opts?.signal?.addEventListener('abort', fail, { once: true });
        });
      },
    } as unknown as RtcPeerManager;
    const remotes: Array<import('@vibeterm/shared/link').LinkSession> = [];
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store, undefined, {
        wsFactory: () => {
          throw new Error('no-ws');
        },
      }),
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
    const first = manager.getLink(peer.nodeId);
    await waitUntil(() => dcCalls === 1);
    await first;
    expect(manager.transportOf(peer.nodeId)).toBe('ws-secure');
    await waitUntil(() => manager.quiesceCapableOf(peer.nodeId));
    manager.forceDcProbe(peer.nodeId);
    await waitUntil(() => dcCalls === 2, 1_000);
    expect(dcCalls).toBe(2);
  });
});
