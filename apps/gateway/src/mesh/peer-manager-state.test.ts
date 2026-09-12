import { describe, expect, test } from 'bun:test';
import { DEFAULT_DIAL_RTT_MS } from '@vibeterm/shared/net';
import { PeerEndpointBackoff } from './peer-endpoint-backoff';
import {
  PEER_DC_IDLE_MS,
  PEER_IDLE_MS,
  applyPeerRttSample,
  createPeerManagerState,
  lookupPeerRttMs,
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
  });
});
