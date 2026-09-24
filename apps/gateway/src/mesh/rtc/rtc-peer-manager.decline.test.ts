import { expect, test } from 'bun:test';
import { createMigratedAuthDb } from '../../auth/test-db';
import { UserStore } from '../../auth/user-store';
import type { RtcSignalMessage } from '../mesh-deps';
import { seedNodeIdentity, seedUser } from '../test-support';
import type { RtcSignaling } from './ice';
import { decodeSdpSignal } from './ice';
import { encodeDcOfferDecline } from './rtc-offer-decline';
import { RtcPeerManager } from './rtc-peer-manager';
import { createFakeNativeModule } from './test-fakes';

test('decline ends the dial: one offer, no re-offer loop, not a timeout', async () => {
  const { db, close } = createMigratedAuthDb();
  const store = new UserStore(db);
  seedUser(store);
  const a = seedNodeIdentity(store, 'user-1');
  const b = seedNodeIdentity(store, 'user-1');
  const [self, peer] = a.nodeId.toLowerCase() < b.nodeId.toLowerCase() ? [a, b] : [b, a];
  const fake = createFakeNativeModule();
  const mgr = new RtcPeerManager({
    loadNative: async () => fake.module,
    iceConfigProvider: () => ({ stun: [] as string[], turn: null }),
    identity: self,
    userStore: store,
    handshakeTimeoutMs: 1_000,
  });
  const listeners = new Set<(m: RtcSignalMessage) => void>();
  let offers = 0;
  const signaling: RtcSignaling = {
    send(msg) {
      const decoded = msg.sdp ? decodeSdpSignal(msg.sdp) : null;
      if (decoded?.type !== 'offer') return;
      offers += 1;
      setTimeout(() => {
        for (const cb of [...listeners]) {
          cb({
            rtcSession: msg.rtcSession,
            from: 'node',
            to: self.nodeId,
            sdp: encodeDcOfferDecline('disabled', { until: null, retryAfterMs: 60_000 }),
            candidate: null,
          });
        }
      }, 20);
    },
    onMessage(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  const started = performance.now();
  const err = await mgr.connectToPeer(peer.nodeId, signaling).catch((caught) => caught);
  const elapsed = performance.now() - started;
  mgr.close();
  close();
  expect(offers).toBe(1);
  expect(fake.connections.length).toBe(1);
  expect(elapsed).toBeLessThan(800);
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toBe('dc-declined');
  expect((err as { retryAfterMs?: number }).retryAfterMs).toBe(60_000);
});
