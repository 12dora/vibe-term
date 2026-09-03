import { describe, expect, test } from 'bun:test';
import type { LinkSession } from '@tmex/shared/link';
import {
  DcUpgradeCoordinator,
  type DcUpgradeLivePeer,
  type DcUpgradePorts,
} from './peer-dc-upgrade';
import { ImmediateScheduler } from './test-support';
import type { PeerTransportKind } from './types';

function fakeSession(): LinkSession {
  return { close() {} } as unknown as LinkSession;
}

function livePeer(nodeId: string, transport: PeerTransportKind = 'ws-secure'): DcUpgradeLivePeer {
  return {
    retiring: false,
    transport,
    peerNodeId: nodeId,
    quiesceCapable: true,
    session: fakeSession(),
    dcAttemptId: null,
  };
}

function makeCoordinator() {
  const scheduler = new ImmediateScheduler();
  const live = new Map<string, DcUpgradeLivePeer>();
  const pending = new Map<string, Promise<LinkSession>>();
  const upgrading = new Map<string, Promise<LinkSession>>();
  const lostDirect = new Set<string>();
  const stop = new AbortController();
  const dials: string[] = [];
  const ports: DcUpgradePorts = {
    scheduler,
    live: () => live,
    dialDc: async (nodeId) => {
      dials.push(nodeId);
      throw new Error('dc-fail');
    },
    shouldTryDc: (nodeId) => coordinator.dcBreaker.shouldTry(nodeId).allow,
    dcCapable: () => true,
    emitLinkInfo: () => {},
    log: () => {},
    stopped: () => stop.signal.aborted,
    stopSignal: () => stop.signal,
    isTrusted: () => true,
    pending: () => pending,
    upgrading: () => upgrading,
    probeQuiesce: () => {},
    hasWsSecureCandidate: () => true,
    lostDirect: () => lostDirect,
  };
  const coordinator = new DcUpgradeCoordinator(ports);
  return { coordinator, live, dials };
}

function disablePeer(coordinator: DcUpgradeCoordinator, peer: string): void {
  for (let i = 0; i < 10; i += 1) {
    coordinator.dcBreaker.noteFailure(peer, 'timeout', `f${i}-${peer}-${Math.random()}`);
  }
}

describe('DcUpgradeCoordinator disabled DC upgrade', () => {
  test('wake sources re-arm disabled peers and skip probes while disabled', () => {
    const { coordinator, live, dials } = makeCoordinator();
    const peer = 'peer-a';
    live.set(peer, livePeer(peer));
    disablePeer(coordinator, peer);
    expect(coordinator.dcBreaker.isDisabled(peer)).toBe(true);
    coordinator.armDcUpgradeRetry(peer);
    expect(dials).toEqual([]);

    coordinator.onLocalFingerprintChanged();
    expect(coordinator.dcBreaker.isDisabled(peer)).toBe(false);

    disablePeer(coordinator, peer);
    coordinator.onPeerEndpointChanged(peer);
    expect(coordinator.dcBreaker.isDisabled(peer)).toBe(false);

    disablePeer(coordinator, peer);
    coordinator.onHubSwitched();
    expect(coordinator.dcBreaker.isDisabled(peer)).toBe(false);

    disablePeer(coordinator, peer);
    coordinator.onPeerReconnected(peer);
    expect(coordinator.dcBreaker.isDisabled(peer)).toBe(false);

    disablePeer(coordinator, peer);
    coordinator.retryDcUpgrade(peer);
    expect(coordinator.dcBreaker.isDisabled(peer)).toBe(false);
  });

  test('disabled state does not drop a live ws-secure peer', () => {
    const { coordinator, live } = makeCoordinator();
    const peer = 'peer-b';
    const session = fakeSession();
    live.set(peer, { ...livePeer(peer), session });
    disablePeer(coordinator, peer);
    expect(coordinator.dcBreaker.isDisabled(peer)).toBe(true);
    expect(live.get(peer)?.transport).toBe('ws-secure');
    expect(live.get(peer)?.session).toBe(session);
    expect(coordinator.wantsUpgrade(live.get(peer)!)).toBe(false);
  });
});
