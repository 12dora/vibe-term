import { afterEach, describe, expect, test } from 'bun:test';
import { generateEd25519KeyPair } from '@tmex/shared/auth';
import { createInMemoryLinkPair } from '@tmex/shared/link';
import { createMigratedAuthDb } from '../auth/test-db';
import { UserStore } from '../auth/user-store';
import { handshakeRelay, handshakeWsDirect } from './peer-protocol';
import { fakeSocketPair, seedNodeIdentity, seedUser } from './test-support';
import { PeerHandshakeError } from './types';

describe('peer handshake', () => {
  const fixtures: Array<{ close: () => void }> = [];
  afterEach(() => {
    while (fixtures.length) fixtures.pop()?.close();
  });

  function setup() {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const a = seedNodeIdentity(store, 'user-1');
    const b = seedNodeIdentity(store, 'user-1');
    return { store, a, b };
  }

  test('ws-secure handshake encrypts the mux like relay', async () => {
    const { store, a, b } = setup();
    const [wsA, wsB] = fakeSocketPair();
    const [ha, hb] = await Promise.all([
      handshakeWsDirect({ socket: wsA, role: 'initiator', identity: a, userStore: store }),
      handshakeWsDirect({ socket: wsB, role: 'acceptor', identity: b, userStore: store }),
    ]);
    expect(ha.transport).toBe('ws-secure');
    expect(hb.transport).toBe('ws-secure');
    expect(ha.peerNodeId).toBe(b.nodeId);
    expect(hb.peerNodeId).toBe(a.nodeId);
    expect(ha.sendKey).toEqual(hb.recvKey);
    expect(ha.recvKey).toEqual(hb.sendKey);

    const incoming = new Promise((resolve) => hb.session.onStream(resolve));
    const stream = await ha.session.openStream(new TextEncoder().encode('{"type":"ctl-test"}'));
    const got = await incoming;
    expect((got as { openPayload: Uint8Array }).openPayload).toEqual(stream.openPayload);
    stream.end();
  });

  test('rejects unknown peer certificate', async () => {
    const { store, a } = setup();
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const empty = new UserStore(db);
    seedUser(empty, 'user-1');
    const stranger = seedNodeIdentity(empty, 'user-1');
    const [wsA, wsB] = fakeSocketPair();
    const results = await Promise.allSettled([
      handshakeWsDirect({ socket: wsA, role: 'initiator', identity: a, userStore: store }),
      handshakeWsDirect({
        socket: wsB,
        role: 'acceptor',
        identity: stranger,
        userStore: store,
      }),
    ]);
    expect(results.some((row) => row.status === 'rejected')).toBe(true);
    const rejected = results.find((row) => row.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(PeerHandshakeError);
    expect((rejected.reason as PeerHandshakeError).code).toBe('unknown');
  });

  test('rejects revoked peer', async () => {
    const { store, a, b } = setup();
    store.markCertRevoked(b.nodeId, 9);
    const [wsA, wsB] = fakeSocketPair();
    const results = await Promise.allSettled([
      handshakeWsDirect({ socket: wsA, role: 'initiator', identity: a, userStore: store }),
      handshakeWsDirect({ socket: wsB, role: 'acceptor', identity: b, userStore: store }),
    ]);
    const rejected = results.filter((row) => row.status === 'rejected');
    expect(rejected.length).toBeGreaterThan(0);
    expect(
      rejected.some(
        (row) => row.status === 'rejected' && (row.reason as PeerHandshakeError).code === 'revoked'
      )
    ).toBe(true);
  });

  test('rejects wrong signing key / tampered transcript', async () => {
    const { store, a, b } = setup();
    const wrong = generateEd25519KeyPair();
    const [wsA, wsB] = fakeSocketPair();
    const results = await Promise.allSettled([
      handshakeWsDirect({
        socket: wsA,
        role: 'initiator',
        identity: a,
        userStore: store,
      }),
      handshakeWsDirect({
        socket: wsB,
        role: 'acceptor',
        identity: { nodeId: b.nodeId, edSecretKey: wrong.secretKey },
        userStore: store,
      }),
    ]);
    expect(
      results.some(
        (row) =>
          row.status === 'rejected' && (row.reason as PeerHandshakeError).code === 'bad_signature'
      )
    ).toBe(true);
  });

  test('relay handshake derives matching keys and carries a mux stream', async () => {
    const { store, a, b } = setup();
    const [outerA, outerB] = createInMemoryLinkPair();
    const incoming = new Promise<import('@tmex/shared/link').LinkStream>((resolve) =>
      outerB.onStream(resolve)
    );
    const out = await outerA.openStream(new TextEncoder().encode(JSON.stringify({ to: b.nodeId })));
    const inn = await incoming;
    const [ha, hb] = await Promise.all([
      handshakeRelay({ stream: out, role: 'initiator', identity: a, userStore: store }),
      handshakeRelay({ stream: inn, role: 'acceptor', identity: b, userStore: store }),
    ]);
    expect(ha.transport).toBe('relay');
    expect(hb.transport).toBe('relay');
    expect(ha.sendKey).toEqual(hb.recvKey);
    expect(ha.recvKey).toEqual(hb.sendKey);

    const got = new Promise<import('@tmex/shared/link').LinkStream>((resolve) =>
      hb.session.onStream(resolve)
    );
    const stream = await ha.session.openStream(new TextEncoder().encode('{"type":"http"}'));
    const peerStream = await got;
    await stream.write(new TextEncoder().encode('hello-relay'));
    stream.end();
    const reader = peerStream.readable.getReader();
    const chunk = await reader.read();
    expect(new TextDecoder().decode(chunk.value?.bytes)).toBe('hello-relay');
    peerStream.end();
  });
});
