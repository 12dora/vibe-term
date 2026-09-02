import { describe, expect, test } from 'bun:test';
import type { HubRuntime } from '../hub';
import type { UplinkState } from './types';
import type { AttachedHub, UplinkPool } from './uplink-pool';
import { bindHubUplinkHooks, kickHubPeerDiscovery } from './uplink-pool-hooks';

describe('bindHubUplinkHooks', () => {
  test('wires attachedEpoch from the uplink attachment and refreshes cadence on attach/detach/state', () => {
    const cadence: string[] = [];
    const hooks: {
      attachedHubId?: () => string | undefined;
      attachedEpoch?: () => number | null | undefined;
      onWriterLearned?: () => void;
    } = {};
    const hubId = 'aa'.repeat(16);
    let attached: AttachedHub | null = {
      hubNodeId: hubId,
      publicUrl: 'https://writer.example',
      mode: 'active',
      writerEpoch: 7,
      since: 1,
    };
    const attachedListeners: Array<(hub: AttachedHub) => void> = [];
    const detachedListeners: Array<() => void> = [];
    const stateListeners: Array<(state: UplinkState) => void> = [];
    let probes = 0;
    const hub = {
      bindWriterBridge() {},
      onWriterUplinkOnline() {},
      onWriterUplinkOffline() {},
      pollPeersNow() {
        return Promise.resolve();
      },
      peerPoller: {
        setDiscoveryHooks(next: typeof hooks) {
          Object.assign(hooks, next);
        },
        refreshCadence() {
          cadence.push('refresh');
        },
        scheduleImmediatePoll() {
          cadence.push('immediate');
        },
      },
    };
    const uplink = {
      state: 'online' as UplinkState,
      attachedHub: () => attached,
      requestProbeNow() {
        probes += 1;
      },
      liveClient: () => null,
      sendCtl() {},
      appendAndAck: async () => null,
      onAttached(cb: (hub: AttachedHub) => void) {
        attachedListeners.push(cb);
        return () => {};
      },
      onDetached(cb: () => void) {
        detachedListeners.push(cb);
        return () => {};
      },
      onStateChange(cb: (state: UplinkState) => void) {
        stateListeners.push(cb);
        return () => {};
      },
    };
    bindHubUplinkHooks(hub as unknown as HubRuntime, uplink as unknown as UplinkPool);

    expect(hooks.attachedHubId?.()).toBe(hubId);
    expect(hooks.attachedEpoch?.()).toBe(7);
    hooks.onWriterLearned?.();
    expect(probes).toBe(1);

    expect(attachedListeners).toHaveLength(1);
    expect(detachedListeners).toHaveLength(1);
    expect(stateListeners.length).toBeGreaterThanOrEqual(1);

    attachedListeners[0]?.(attached as AttachedHub);
    expect(cadence).toEqual(['refresh']);
    detachedListeners[0]?.();
    expect(cadence).toEqual(['refresh', 'refresh']);
    stateListeners[0]?.('offline');
    expect(cadence).toEqual(['refresh', 'refresh', 'refresh']);

    attached = { ...attached, writerEpoch: 9 };
    expect(hooks.attachedEpoch?.()).toBe(9);
    attached = null;
    expect(hooks.attachedEpoch?.() ?? 0).toBe(0);
  });
});

describe('kickHubPeerDiscovery', () => {
  test('schedules a jittered immediate poll rather than polling inline', () => {
    const calls: string[] = [];
    const hub = {
      pollPeersNow() {
        calls.push('pollNow');
        return Promise.resolve();
      },
      peerPoller: {
        scheduleImmediatePoll() {
          calls.push('immediate');
        },
      },
    };
    const uplink = {
      requestProbeNow() {
        calls.push('probe');
      },
    };
    kickHubPeerDiscovery(hub as unknown as HubRuntime, uplink as unknown as UplinkPool);
    expect(calls).toEqual(['immediate', 'probe']);
  });
});
