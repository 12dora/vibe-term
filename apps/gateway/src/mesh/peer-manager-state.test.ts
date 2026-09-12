import { describe, expect, test } from 'bun:test';
import { DEFAULT_DIAL_RTT_MS } from '@vibeterm/shared/net';
import { PeerEndpointBackoff } from './peer-endpoint-backoff';
import {
  PEER_DC_IDLE_MS,
  PEER_IDLE_MS,
  PEER_RETIRE_STREAM_LEAK_MS,
  applyPeerRttSample,
  createPeerManagerState,
  lookupPeerRttMs,
  measurePingRttMs,
  parseEchoedSentAt,
} from './peer-manager-state';
import type { LivePeer } from './peer-reconnect-wake';
import { ImmediateScheduler } from './test-support';
import type { MeshIdentity } from './types';

function identity(nodeId = 'aa'.repeat(16)): MeshIdentity {
  return { nodeId, edSecretKey: new Uint8Array(64) } as MeshIdentity;
}

describe('peer RTT EWMA and lookup', () => {
  test('EWMA α 0.3 ignores one spike above 3× then accepts the next', () => {
    const live = { rttMs: null as number | null, rttSpikeIgnored: false };
    expect(applyPeerRttSample(live, 40)).toBe(40);
    expect(applyPeerRttSample(live, 50)).toBe(43);
    expect(applyPeerRttSample(live, 400)).toBe(43);
    expect(live.rttSpikeIgnored).toBe(true);
    expect(applyPeerRttSample(live, 400)).toBe(150);
    expect(live.rttSpikeIgnored).toBe(false);
  });

  test('lookupPeerRttMs(undefined) uses the median of live samples, not the max', () => {
    const scheduler = new ImmediateScheduler();
    const uplink = { rttMs: 90 } as unknown as import('./uplink-client').UplinkClient;
    const state = createPeerManagerState({
      identity: identity(),
      userStore: { getCert: () => null } as never,
      uplink,
      scheduler,
      endpointBackoff: new PeerEndpointBackoff({ now: () => scheduler.now() }),
    });
    const row = (rttMs: number): LivePeer =>
      ({ rttMs, pingSentAt: null, rttSpikeIgnored: false }) as LivePeer;
    state.live.set('a', row(20));
    state.live.set('b', row(40));
    state.live.set('c', row(1428));
    expect(lookupPeerRttMs('c', scheduler)).toBe(1428);
    expect(lookupPeerRttMs(undefined, scheduler)).toBe(40);
    state.live.clear();
    expect(lookupPeerRttMs(undefined, scheduler)).toBe(90);
    expect(lookupPeerRttMs()).toBe(DEFAULT_DIAL_RTT_MS);
  });

  test('DC idle is 30 min and relay idle stays 5 min', () => {
    expect(PEER_IDLE_MS).toBe(5 * 60 * 1000);
    expect(PEER_DC_IDLE_MS).toBe(30 * 60 * 1000);
    expect(PEER_RETIRE_STREAM_LEAK_MS).toBe(30 * 60 * 1000);
  });

  test('RTT is computed by the ping sender; a 1e6 ms peer clock offset does not leak', () => {
    const skew = 1_000_000;
    const trip = 42;
    const a = { now: 1_000, pingSentAt: null as number | null, rttMs: null as number | null };
    const b = {
      now: 1_000 + skew,
      pingSentAt: null as number | null,
      rttMs: null as number | null,
    };
    const onPing = (sentAt: unknown) => ({ t: 'pong' as const, sentAt });
    a.pingSentAt = a.now;
    const pingA = { t: 'ping' as const, sentAt: a.pingSentAt };
    const pongA = onPing(pingA.sentAt);
    expect(b.rttMs).toBeNull();
    a.now += trip;
    b.now += trip;
    const sampleA = measurePingRttMs(a.now, parseEchoedSentAt(pongA.sentAt), a.pingSentAt);
    expect(sampleA).toBe(trip);
    applyPeerRttSample(a, sampleA as number);
    expect(a.rttMs).toBe(trip);

    b.pingSentAt = b.now;
    const pingB = { t: 'ping' as const, sentAt: b.pingSentAt };
    const pongB = onPing(pingB.sentAt);
    a.now += trip;
    b.now += trip;
    const sampleB = measurePingRttMs(b.now, parseEchoedSentAt(pongB.sentAt), b.pingSentAt);
    expect(sampleB).toBe(trip);
    expect(sampleB).not.toBe(trip + skew);
  });

  test('measurePingRttMs ignores non-finite and future echoed sentAt', () => {
    expect(measurePingRttMs(100, Number.NaN, 90)).toBe(10);
    expect(measurePingRttMs(100, Number.POSITIVE_INFINITY, 90)).toBe(10);
    expect(measurePingRttMs(100, 200, 90)).toBe(10);
    expect(measurePingRttMs(100, 80, 90)).toBe(20);
    expect(measurePingRttMs(100, undefined, null)).toBeNull();
    expect(measurePingRttMs(100, 200, 200)).toBeNull();
    expect(parseEchoedSentAt('1')).toBeUndefined();
    expect(parseEchoedSentAt(Number.NaN)).toBeUndefined();
    expect(parseEchoedSentAt(12.5)).toBe(12.5);
  });
});
