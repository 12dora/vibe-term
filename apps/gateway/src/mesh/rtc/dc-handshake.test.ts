import { afterEach, describe, expect, test } from 'bun:test';
import { LinkMux } from '@tmex/shared/link';
import { createMigratedAuthDb } from '../../auth/test-db';
import { UserStore } from '../../auth/user-store';
import { seedNodeIdentity, seedUser } from '../test-support';
import { PeerHandshakeError } from '../types';
import { fanoutDataChannel } from './channel-fanout';
import { DataChannelLink } from './data-channel-link';
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

  function setupPair() {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const a = seedNodeIdentity(store, 'user-1');
    const b = seedNodeIdentity(store, 'user-1');
    const fake = createFakeNativeModule();
    const pcA = new fake.module.PeerConnection('hs-a', { iceServers: [] }) as FakePeerConnection;
    const pcB = new fake.module.PeerConnection('hs-b', { iceServers: [] }) as FakePeerConnection;
    pcA.remoteFp = pcB.fingerprint;
    pcB.remoteFp = pcA.fingerprint;
    fixtures.push({ close: () => pcA.close() });
    fixtures.push({ close: () => pcB.close() });
    const [dcA, dcB] = pairDataChannels('peer');
    return {
      store,
      a,
      b,
      pcA,
      pcB,
      fanA: fanoutDataChannel(dcA),
      fanB: fanoutDataChannel(dcB),
    };
  }

  async function handshakePair(pair: ReturnType<typeof setupPair>) {
    await Promise.all([
      handshakeDataChannel({
        channel: pair.fanA,
        pc: pair.pcA,
        identity: pair.a,
        userStore: pair.store,
        localFingerprint: pair.pcA.fingerprint,
        timeoutMs: 1_000,
      }),
      handshakeDataChannel({
        channel: pair.fanB,
        pc: pair.pcB,
        identity: pair.b,
        userStore: pair.store,
        localFingerprint: pair.pcB.fingerprint,
        timeoutMs: 1_000,
      }),
    ]);
  }

  test('LinkMux frame sent after A finishes handshake reaches B that attaches its link later', async () => {
    const pair = setupPair();
    await handshakePair(pair);
    const initiator = pair.a.nodeId.toLowerCase() < pair.b.nodeId.toLowerCase();
    const linkA = new DataChannelLink(pair.fanA);
    const muxA = new LinkMux(linkA, { role: initiator ? 'initiator' : 'acceptor' });
    const open = new TextEncoder().encode('{"type":"http"}');
    const opened = muxA.openStream(open);
    const payload = new Uint8Array([9, 8, 7]);
    const linkB = new DataChannelLink(pair.fanB);
    let linkClosed = 0;
    linkB.onClose(() => {
      linkClosed += 1;
    });
    const muxB = new LinkMux(linkB, { role: initiator ? 'acceptor' : 'initiator' });
    const incoming = new Promise<import('@tmex/shared/link').LinkStream>((resolve) =>
      muxB.onStream(resolve)
    );
    const out = await opened;
    const inn = await incoming;
    expect(inn.openPayload).toEqual(open);
    const reader = inn.readable.getReader();
    await out.write(payload);
    expect((await reader.read()).value?.bytes).toEqual(payload);
    expect(linkClosed).toBe(0);
    expect(pair.fanB.isOpen()).toBe(true);
    out.end();
    inn.end();
  });

  test('close during the handshake-to-link window is delivered to the later-registered link', async () => {
    const pair = setupPair();
    await handshakePair(pair);
    const linkA = new DataChannelLink(pair.fanA);
    linkA.close('bye');
    let linkMessages = 0;
    let linkClosed = 0;
    const linkB = new DataChannelLink(pair.fanB);
    linkB.onData(() => {
      linkMessages += 1;
    });
    linkB.onClose(() => {
      linkClosed += 1;
    });
    expect({ linkMessages, linkClosed, isOpen: pair.fanB.isOpen() }).toEqual({
      linkMessages: 0,
      linkClosed: 1,
      isOpen: false,
    });
  });
});
