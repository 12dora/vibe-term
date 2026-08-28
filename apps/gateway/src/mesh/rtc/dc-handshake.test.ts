import { afterEach, describe, expect, test } from 'bun:test';
import { encodeBase64url } from '@tmex/shared/auth';
import { LinkMux } from '@tmex/shared/link';
import { createMigratedAuthDb } from '../../auth/test-db';
import { UserStore } from '../../auth/user-store';
import { seedNodeIdentity, seedUser } from '../test-support';
import { PeerHandshakeError } from '../types';
import { fanoutDataChannel } from './channel-fanout';
import { DataChannelLink } from './data-channel-link';
import {
  DC_HANDSHAKE_HELLO_INTERVAL_MS,
  DC_HANDSHAKE_MAX_MESSAGE_BYTES,
  DC_HANDSHAKE_MAX_QUEUE,
  handshakeDataChannel,
} from './dc-handshake';
import { fragmentFrame } from './fragmenter';
import type { DataChannelLike } from './native';
import { type FakePeerConnection, createFakeNativeModule, pairDataChannels } from './test-fakes';

function ctlType(msg: string | Buffer | ArrayBuffer | Uint8Array): string | null {
  try {
    const text = typeof msg === 'string' ? msg : new TextDecoder().decode(msg);
    const parsed = JSON.parse(text) as { t?: unknown };
    return typeof parsed.t === 'string' ? parsed.t : null;
  } catch {
    return null;
  }
}

function holdCtlType(
  inner: DataChannelLike,
  type: string
): DataChannelLike & { release: () => void } {
  let holding = true;
  const held: Array<string | Buffer | ArrayBuffer> = [];
  const listeners: Array<(msg: string | Buffer | ArrayBuffer) => void> = [];
  inner.onMessage((msg) => {
    if (holding && ctlType(msg) === type) {
      held.push(msg);
      return;
    }
    for (const cb of [...listeners]) cb(msg);
  });
  return {
    close: () => inner.close(),
    sendMessage: (msg) => inner.sendMessage(msg),
    sendMessageBinary: (buffer) => inner.sendMessageBinary(buffer),
    isOpen: () => inner.isOpen(),
    bufferedAmount: () => inner.bufferedAmount(),
    maxMessageSize: () => inner.maxMessageSize(),
    setBufferedAmountLowThreshold: (bytes) => inner.setBufferedAmountLowThreshold(bytes),
    onBufferedAmountLow: (cb) => inner.onBufferedAmountLow(cb),
    onOpen: (cb) => inner.onOpen(cb),
    onClosed: (cb) => inner.onClosed(cb),
    onError: (cb) => inner.onError(cb),
    onMessage: (cb) => {
      listeners.push(cb);
      return () => {
        const idx = listeners.indexOf(cb);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    },
    getLabel: inner.getLabel ? () => inner.getLabel?.() ?? '' : undefined,
    release() {
      holding = false;
      const queued = held.splice(0);
      for (const msg of queued) {
        for (const cb of [...listeners]) cb(msg);
      }
    },
  };
}

function holdSigMessages(inner: DataChannelLike): DataChannelLike & { release: () => void } {
  return holdCtlType(inner, 'sig');
}

function holdDoneMessages(inner: DataChannelLike): DataChannelLike & { release: () => void } {
  return holdCtlType(inner, 'done');
}

function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('waitUntil timed out'));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

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

  test('aborts and closes the PC when a pre-auth handshake message exceeds 4 KiB', async () => {
    const { store, identity, pc } = setup();
    const [local, remote] = pairDataChannels('peer');
    expect(DC_HANDSHAKE_MAX_MESSAGE_BYTES).toBe(4 * 1024);
    remote.onMessage(() => {
      remote.sendMessage(
        JSON.stringify({
          t: 'hello',
          node_id: identity.nodeId,
          nonce: encodeBase64url(new Uint8Array(32)),
          dtls_fingerprint: { algorithm: 'sha-256', value: '00' },
          pad: 'x'.repeat(DC_HANDSHAKE_MAX_MESSAGE_BYTES),
        })
      );
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

  test('aborts and closes the PC when more than 8 handshake messages are queued', async () => {
    const { store, identity, pc } = setup();
    const [local, remote] = pairDataChannels('peer');
    expect(DC_HANDSHAKE_MAX_QUEUE).toBe(8);
    remote.onMessage(() => {
      for (let i = 0; i < DC_HANDSHAKE_MAX_QUEUE + 1; i++) {
        remote.sendMessage(
          JSON.stringify({
            t: 'hello',
            node_id: identity.nodeId,
            nonce: encodeBase64url(new Uint8Array(32)),
            dtls_fingerprint: { algorithm: 'sha-256', value: '00' },
            i,
          })
        );
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
      dcA,
      dcB,
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

  test('delayed sig then immediate OPEN is handed back to the later-attached link', async () => {
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
    const heldB = holdSigMessages(dcB);
    const fanA = fanoutDataChannel(dcA);
    const fanB = fanoutDataChannel(heldB);

    const hsA = handshakeDataChannel({
      channel: fanA,
      pc: pcA,
      identity: a,
      userStore: store,
      localFingerprint: pcA.fingerprint,
      timeoutMs: 1_000,
    });
    const hsB = handshakeDataChannel({
      channel: fanB,
      pc: pcB,
      identity: b,
      userStore: store,
      localFingerprint: pcB.fingerprint,
      timeoutMs: 1_000,
    });

    await waitUntil(() => dcA.sent.some((chunk) => ctlType(chunk) === 'done'));
    const openPayload = new Uint8Array(64).fill(3);
    for (const part of fragmentFrame(1, openPayload)) {
      fanA.sendMessageBinary(Buffer.from(part));
    }
    heldB.release();
    await Promise.all([hsA, hsB]);

    const linkB = new DataChannelLink(fanB, { liveness: false });
    const got = new Promise<Uint8Array>((resolve) => linkB.onData(resolve));
    expect(await got).toEqual(openPayload);
    expect(fanB.isOpen()).toBe(true);
    linkB.close();
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

  test('late hello after Link is installed does not close the channel', async () => {
    const pair = setupPair();
    await handshakePair(pair);
    const linkA = new DataChannelLink(pair.fanA, { liveness: false });
    let linkClosedReason: string | undefined;
    linkA.onClose((reason) => {
      linkClosedReason = reason;
    });
    const lateHello = JSON.stringify({
      t: 'hello',
      node_id: pair.b.nodeId,
      nonce: encodeBase64url(new Uint8Array(32)),
      dtls_fingerprint: pair.pcB.fingerprint,
    });
    pair.fanB.sendMessage(lateHello);
    pair.dcB.emitMessage(lateHello);
    await Bun.sleep(DC_HANDSHAKE_HELLO_INTERVAL_MS * 2);
    expect({ linkClosedReason, channelOpen: pair.fanA.isOpen() }).toEqual({
      linkClosedReason: undefined,
      channelOpen: true,
    });
    const got = new Promise<Uint8Array>((resolve) => linkA.onData(resolve));
    const linkB = new DataChannelLink(pair.fanB, { liveness: false });
    await linkB.send(new Uint8Array([1, 2, 3]));
    expect(await got).toEqual(new Uint8Array([1, 2, 3]));
    linkA.close();
    linkB.close();
  });

  test('hello retransmit after one side installs Link does not fragment-protocol the DC', async () => {
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
    const heldB = holdSigMessages(dcB);
    const fanA = fanoutDataChannel(dcA);
    const fanB = fanoutDataChannel(heldB);

    const hsA = handshakeDataChannel({
      channel: fanA,
      pc: pcA,
      identity: a,
      userStore: store,
      localFingerprint: pcA.fingerprint,
      timeoutMs: 1_000,
    });
    const hsB = handshakeDataChannel({
      channel: fanB,
      pc: pcB,
      identity: b,
      userStore: store,
      localFingerprint: pcB.fingerprint,
      timeoutMs: 1_000,
    });
    await waitUntil(() => dcA.sent.some((chunk) => ctlType(chunk) === 'done'));

    const linkA = new DataChannelLink(fanA, { liveness: false });
    let linkClosedReason: string | undefined;
    linkA.onClose((reason) => {
      linkClosedReason = reason;
    });
    await Bun.sleep(DC_HANDSHAKE_HELLO_INTERVAL_MS * 3);
    expect({ linkClosedReason, channelOpen: fanA.isOpen() }).toEqual({
      linkClosedReason: undefined,
      channelOpen: true,
    });
    expect(dcB.sent.filter((chunk) => ctlType(chunk) === 'hello').length).toBeGreaterThan(1);

    heldB.release();
    await Promise.all([hsA, hsB]);
    expect({ linkClosedReason, channelOpen: fanA.isOpen() }).toEqual({
      linkClosedReason: undefined,
      channelOpen: true,
    });
    linkA.close();
  });

  test('LinkMux DATA larger than 4 KiB during handshake is buffered, not rejected', async () => {
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
    const heldB = holdDoneMessages(dcB);
    const fanA = fanoutDataChannel(dcA);
    const fanB = fanoutDataChannel(heldB);

    const hsA = handshakeDataChannel({
      channel: fanA,
      pc: pcA,
      identity: a,
      userStore: store,
      localFingerprint: pcA.fingerprint,
      timeoutMs: 1_000,
    });
    const hsB = handshakeDataChannel({
      channel: fanB,
      pc: pcB,
      identity: b,
      userStore: store,
      localFingerprint: pcB.fingerprint,
      timeoutMs: 1_000,
    });
    await hsA;

    const linkA = new DataChannelLink(fanA, { liveness: false });
    const payload = new Uint8Array(DC_HANDSHAKE_MAX_MESSAGE_BYTES + 64).fill(7);
    const sent = linkA.send(payload);
    for (let i = 0; i < DC_HANDSHAKE_MAX_QUEUE + 1; i++) {
      fanA.sendMessageBinary(Buffer.from(fragmentFrame(100 + i, new Uint8Array([i]))[0] ?? []));
    }
    await sent;

    let bHandshake: { ok: boolean; error?: string };
    heldB.release();
    try {
      await hsB;
      bHandshake = { ok: true };
    } catch (err) {
      bHandshake = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    expect({ bHandshake, channelOpen: fanB.isOpen() }).toEqual({
      bHandshake: { ok: true },
      channelOpen: true,
    });

    const linkB = new DataChannelLink(fanB, { liveness: false });
    const frames: Uint8Array[] = [];
    const gotLarge = new Promise<void>((resolve) => {
      linkB.onData((bytes) => {
        frames.push(bytes);
        if (frames.some((row) => row.byteLength === payload.byteLength)) resolve();
      });
    });
    await gotLarge;
    expect(frames.some((row) => row.byteLength === payload.byteLength && row[0] === 7)).toBe(true);
    linkA.close();
    linkB.close();
  });

  test('stops hello retransmission on the first inbound sig', async () => {
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
    const heldB = holdDoneMessages(dcB);
    const fanA = fanoutDataChannel(dcA);
    const fanB = fanoutDataChannel(heldB);

    const hsA = handshakeDataChannel({
      channel: fanA,
      pc: pcA,
      identity: a,
      userStore: store,
      localFingerprint: pcA.fingerprint,
      timeoutMs: 1_000,
    });
    const hsB = handshakeDataChannel({
      channel: fanB,
      pc: pcB,
      identity: b,
      userStore: store,
      localFingerprint: pcB.fingerprint,
      timeoutMs: 1_000,
    });
    await hsA;
    const hellos = dcA.sent.filter((chunk) => ctlType(chunk) === 'hello').length;
    expect(hellos).toBeGreaterThanOrEqual(1);
    await Bun.sleep(DC_HANDSHAKE_HELLO_INTERVAL_MS * 3);
    expect(dcA.sent.filter((chunk) => ctlType(chunk) === 'hello').length).toBe(hellos);
    heldB.release();
    await hsB;
  });
});
