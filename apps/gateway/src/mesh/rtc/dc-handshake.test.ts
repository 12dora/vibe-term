import { afterEach, describe, expect, test } from 'bun:test';
import { createMigratedAuthDb } from '../../auth/test-db';
import { UserStore } from '../../auth/user-store';
import { seedNodeIdentity, seedUser } from '../test-support';
import { PeerHandshakeError } from '../types';
import {
  DC_HANDSHAKE_MAX_MESSAGE_BYTES,
  DC_HANDSHAKE_MAX_QUEUE,
  handshakeDataChannel,
} from './dc-handshake';
import { type FakePeerConnection, createFakeNativeModule, pairDataChannels } from './test-fakes';

describe('handshakeDataChannel', () => {
  const fixtures: Array<{ close: () => void }> = [];
  afterEach(() => {
    while (fixtures.length) fixtures.pop()?.close();
  });

  function setup() {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const identity = seedNodeIdentity(store, 'user-1');
    const fake = createFakeNativeModule();
    const pc = new fake.module.PeerConnection('hs', { iceServers: [] }) as FakePeerConnection;
    fixtures.push({ close: () => pc.close() });
    return { store, identity, pc };
  }

  test('aborts and closes the PC when a pre-auth message exceeds 4 KiB', async () => {
    const { store, identity, pc } = setup();
    const [local, remote] = pairDataChannels('peer');
    expect(DC_HANDSHAKE_MAX_MESSAGE_BYTES).toBe(4 * 1024);
    remote.onMessage(() => {
      remote.sendMessage('x'.repeat(DC_HANDSHAKE_MAX_MESSAGE_BYTES + 1));
    });
    const hs = handshakeDataChannel({
      channel: local,
      pc,
      identity,
      userStore: store,
      localFingerprint: pc.fingerprint,
      timeoutMs: 1_000,
    });
    await expect(hs).rejects.toBeInstanceOf(PeerHandshakeError);
    expect(pc.closed).toBe(true);
    expect(local.closed).toBe(true);
  });

  test('aborts and closes the PC when more than 8 pre-auth messages are queued', async () => {
    const { store, identity, pc } = setup();
    const [local, remote] = pairDataChannels('peer');
    expect(DC_HANDSHAKE_MAX_QUEUE).toBe(8);
    remote.onMessage(() => {
      for (let i = 0; i < DC_HANDSHAKE_MAX_QUEUE + 1; i++) {
        remote.sendMessage(JSON.stringify({ t: 'junk', i }));
      }
    });
    const hs = handshakeDataChannel({
      channel: local,
      pc,
      identity,
      userStore: store,
      localFingerprint: pc.fingerprint,
      timeoutMs: 1_000,
    });
    await expect(hs).rejects.toBeInstanceOf(PeerHandshakeError);
    expect(pc.closed).toBe(true);
    expect(local.closed).toBe(true);
  });

  test('aborts and closes the PC when the channel closes during handshake', async () => {
    const { store, identity, pc } = setup();
    const [local, remote] = pairDataChannels('peer');
    const hs = handshakeDataChannel({
      channel: local,
      pc,
      identity,
      userStore: store,
      localFingerprint: pc.fingerprint,
      timeoutMs: 1_000,
    });
    remote.close();
    await expect(hs).rejects.toBeInstanceOf(PeerHandshakeError);
    expect(pc.closed).toBe(true);
  });
});
