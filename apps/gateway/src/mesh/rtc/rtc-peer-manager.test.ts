import { afterEach, describe, expect, test } from 'bun:test';
import { encodeBase64url, normalizeFingerprint } from '@tmex/shared/auth';
import { LinkMux } from '@tmex/shared/link';
import { createMigratedAuthDb } from '../../auth/test-db';
import { UserStore } from '../../auth/user-store';
import type { RtcSignalMessage } from '../mesh-deps';
import { seedNodeIdentity, seedUser } from '../test-support';
import { PeerHandshakeError } from '../types';
import type { RtcSignaling } from './ice';
import { RTC_AUTHORIZE_MAX, RtcPeerManager, SESS_CHANNEL_LABEL } from './rtc-peer-manager';
import { type FakePeerConnection, createFakeNativeModule } from './test-fakes';

function loopbackSignaling(): [RtcSignaling, RtcSignaling] {
  const aCbs: Array<(msg: RtcSignalMessage) => void> = [];
  const bCbs: Array<(msg: RtcSignalMessage) => void> = [];
  const aInbox: RtcSignalMessage[] = [];
  const bInbox: RtcSignalMessage[] = [];

  function deliver(
    cbs: Array<(msg: RtcSignalMessage) => void>,
    inbox: RtcSignalMessage[],
    msg: RtcSignalMessage
  ): void {
    if (cbs.length === 0) {
      inbox.push(msg);
      return;
    }
    for (const cb of cbs) cb(msg);
  }

  function subscribe(
    cbs: Array<(msg: RtcSignalMessage) => void>,
    inbox: RtcSignalMessage[],
    cb: (msg: RtcSignalMessage) => void
  ): void {
    cbs.push(cb);
    while (inbox.length > 0) {
      const next = inbox.shift();
      if (next) cb(next);
    }
  }

  return [
    {
      send: (msg) => deliver(bCbs, bInbox, msg),
      onMessage: (cb) => subscribe(aCbs, aInbox, cb),
    },
    {
      send: (msg) => deliver(aCbs, aInbox, msg),
      onMessage: (cb) => subscribe(bCbs, bInbox, cb),
    },
  ];
}

describe('RtcPeerManager', () => {
  const fixtures: Array<{ close: () => void }> = [];
  afterEach(() => {
    while (fixtures.length) fixtures.pop()?.close();
  });

  function setup(opts?: { mismatch?: boolean }) {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const a = seedNodeIdentity(store, 'user-1');
    const b = seedNodeIdentity(store, 'user-1');
    const fake = createFakeNativeModule(
      opts?.mismatch
        ? { remoteFingerprintOverride: { algorithm: 'sha-256', value: 'DE:AD:BE:EF' } }
        : undefined
    );
    const ice = () => ({ stun: [] as string[], turn: null });
    const left = new RtcPeerManager({
      loadNative: async () => fake.module,
      iceConfigProvider: ice,
      identity: a,
      userStore: store,
      handshakeTimeoutMs: 2_000,
    });
    const right = new RtcPeerManager({
      loadNative: async () => fake.module,
      iceConfigProvider: ice,
      identity: b,
      userStore: store,
      handshakeTimeoutMs: 2_000,
    });
    fixtures.push({ close: () => left.close() });
    fixtures.push({ close: () => right.close() });
    return { store, a, b, left, right, fake };
  }

  test('available is true after native loads', async () => {
    const { left } = setup();
    expect(left.available).toBe(false);
    expect(await left.ready()).toBe(true);
    expect(left.available).toBe(true);
  });

  test('createPeerConnection parses local fingerprint from SDP', async () => {
    const { left } = setup();
    const created = await left.createPeerConnection('offerer');
    expect(created.fingerprint.algorithm).toBe('sha-256');
    expect(created.fingerprint.value.length).toBeGreaterThan(8);
    expect(created.channel).not.toBeNull();
    created.pc.close();
  });

  test('node↔node DataChannelLink + LinkMux round-trip', async () => {
    const { left, right, a, b } = setup();
    const [sigA, sigB] = loopbackSignaling();
    const [la, lb] = await Promise.all([
      left.connectToPeer(b.nodeId, sigA),
      right.connectToPeer(a.nodeId, sigB),
    ]);
    expect(la.peerNodeId).toBe(b.nodeId);
    expect(lb.peerNodeId).toBe(a.nodeId);
    const offererIsLeft = a.nodeId.toLowerCase() < b.nodeId.toLowerCase();
    expect(la.role).toBe(offererIsLeft ? 'initiator' : 'acceptor');

    const muxA = new LinkMux(la.link, { role: la.role });
    const muxB = new LinkMux(lb.link, { role: lb.role });
    const incoming = new Promise<import('@tmex/shared/link').LinkStream>((resolve) =>
      muxB.onStream(resolve)
    );
    const open = new TextEncoder().encode('{"type":"ping"}');
    const out = await muxA.openStream(open);
    const inn = await incoming;
    expect(inn.openPayload).toEqual(open);
    const reader = inn.readable.getReader();
    await out.write(new Uint8Array([9, 9]));
    expect((await reader.read()).value?.bytes).toEqual(new Uint8Array([9, 9]));
    out.end();
    inn.end();
  });

  test('rejects fingerprint mismatch', async () => {
    const { left, right, a, b } = setup({ mismatch: true });
    const [sigA, sigB] = loopbackSignaling();
    const results = await Promise.allSettled([
      left.connectToPeer(b.nodeId, sigA),
      right.connectToPeer(a.nodeId, sigB),
    ]);
    expect(results.some((row) => row.status === 'rejected')).toBe(true);
    const rejected = results.find((row) => row.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(PeerHandshakeError);
    expect(String(rejected.reason)).toContain('fingerprint');
  });

  test('browser sess nonce path with two PeerConnections', async () => {
    const { left, fake } = setup();
    await left.ready();
    const [sigNode, sigBrowser] = loopbackSignaling();
    const rtcSession = 'browser-sess-1';
    const native = fake.module;
    const browserPc = new native.PeerConnection('browser', {
      iceServers: [],
    }) as FakePeerConnection;
    fixtures.push({ close: () => browserPc.close() });

    sigBrowser.onMessage((msg) => {
      if (msg.sdp) {
        const parsed = JSON.parse(msg.sdp) as { type: string; sdp: string };
        browserPc.setRemoteDescription(parsed.sdp, parsed.type);
      }
      if (msg.candidate) {
        const parsed = JSON.parse(msg.candidate) as { candidate: string; mid: string };
        if (parsed.candidate) browserPc.addRemoteCandidate(parsed.candidate, parsed.mid);
      }
    });
    browserPc.onLocalDescription((sdp, type) => {
      sigBrowser.send({
        rtcSession,
        from: 'browser',
        to: left.identity.nodeId,
        sdp: JSON.stringify({ type, sdp }),
      });
    });
    browserPc.onLocalCandidate((candidate, mid) => {
      if (!candidate) return;
      sigBrowser.send({
        rtcSession,
        from: 'browser',
        to: left.identity.nodeId,
        candidate: JSON.stringify({ candidate, mid }),
      });
    });
    const fpBrowser = normalizeFingerprint(browserPc.fingerprint);
    const auth = await left.authorizeBrowser({
      rtcSession,
      uid: 'user-1',
      via: 'self',
      sid: 'sid-browser-1',
      fpBrowser,
    });
    expect(auth).not.toBeNull();
    expect(auth?.fpNode.algorithm).toBe('sha-256');
    expect(auth?.nonce.byteLength).toBe(32);
    expect(left.authorizationOf(rtcSession)?.sid).toBe('sid-browser-1');
    const acceptP = left.acceptBrowser(rtcSession, sigNode);
    const dc = browserPc.createDataChannel(SESS_CHANNEL_LABEL);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('sess open timeout')), 2000);
      dc.onOpen(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    dc.sendMessage(JSON.stringify({ nonce: encodeBase64url(auth?.nonce ?? new Uint8Array()) }));
    const accepted = await acceptP;
    expect(accepted.uid).toBe('user-1');
    expect(accepted.sid).toBe('sid-browser-1');
    expect(accepted.via).toBe('self');
    expect(left.authorizationOf(rtcSession)).toBeNull();
    expect(accepted.carrier.send(new Uint8Array([1]))).toBe('sent');
    accepted.carrier.close(1000, 'done');
    expect((accepted.pc as FakePeerConnection).closed).toBe(true);
  });

  test('browser sess rejects a bad nonce', async () => {
    const { left, fake } = setup();
    await left.ready();
    const [sigNode, sigBrowser] = loopbackSignaling();
    const rtcSession = 'browser-sess-bad';
    const native = fake.module;
    const browserPc = new native.PeerConnection('browser', {
      iceServers: [],
    }) as FakePeerConnection;
    fixtures.push({ close: () => browserPc.close() });
    sigBrowser.onMessage((msg) => {
      if (msg.sdp) {
        const parsed = JSON.parse(msg.sdp) as { type: string; sdp: string };
        browserPc.setRemoteDescription(parsed.sdp, parsed.type);
      }
    });
    browserPc.onLocalDescription((sdp, type) => {
      sigBrowser.send({
        rtcSession,
        from: 'browser',
        to: left.identity.nodeId,
        sdp: JSON.stringify({ type, sdp }),
      });
    });
    await left.authorizeBrowser({
      rtcSession,
      uid: 'user-1',
      via: 'self',
      fpBrowser: normalizeFingerprint(browserPc.fingerprint),
    });
    const acceptP = left.acceptBrowser(rtcSession, sigNode);
    const dc = browserPc.createDataChannel(SESS_CHANNEL_LABEL);
    await new Promise<void>((resolve) => dc.onOpen(() => resolve()));
    dc.sendMessage(JSON.stringify({ nonce: encodeBase64url(new Uint8Array(32)) }));
    await expect(acceptP).rejects.toBeInstanceOf(PeerHandshakeError);
  });

  test('acceptBrowser rejects sessions that were never authorized', async () => {
    const { left, fake } = setup();
    await left.ready();
    const [sigNode] = loopbackSignaling();
    const before = fake.connections.length;
    await expect(left.acceptBrowser('no-such-session', sigNode)).rejects.toBeInstanceOf(
      PeerHandshakeError
    );
    expect(fake.connections.length).toBe(before);
  });

  test('authorizeBrowser refuses more than the global registry cap', async () => {
    const { left } = setup();
    await left.ready();
    expect(RTC_AUTHORIZE_MAX).toBe(64);
    const fp = { algorithm: 'sha-256', value: 'AA' };
    const first = await left.authorizeBrowser({
      rtcSession: 'cap-0',
      uid: 'user-1',
      via: 'self',
      fpBrowser: fp,
    });
    expect(first).not.toBeNull();
    for (let i = 1; i < RTC_AUTHORIZE_MAX; i++) {
      const auth = await left.authorizeBrowser({
        rtcSession: `cap-${i}`,
        uid: 'user-1',
        via: 'self',
        fpBrowser: fp,
      });
      expect(auth).not.toBeNull();
    }
    const overflow = await left.authorizeBrowser({
      rtcSession: 'cap-overflow',
      uid: 'user-1',
      via: 'self',
      fpBrowser: fp,
    });
    expect(overflow).toBeNull();
    const refresh = await left.authorizeBrowser({
      rtcSession: 'cap-0',
      uid: 'user-1',
      via: 'self',
      fpBrowser: fp,
    });
    expect(refresh).not.toBeNull();
  });

  test('TTL sweep timer closes expired unused records', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const identity = seedNodeIdentity(store, 'user-1');
    const fake = createFakeNativeModule();
    let now = 1_000;
    const mgr = new RtcPeerManager({
      loadNative: async () => fake.module,
      iceConfigProvider: () => ({ stun: [], turn: null }),
      identity,
      userStore: store,
      now: () => now,
      authorizeTtlMs: 50,
      sweepIntervalMs: 15,
    });
    fixtures.push({ close: () => mgr.close() });
    await mgr.ready();
    const auth = await mgr.authorizeBrowser({
      rtcSession: 'ttl-sess',
      uid: 'user-1',
      via: 'self',
      fpBrowser: { algorithm: 'sha-256', value: 'AA' },
    });
    expect(auth).not.toBeNull();
    const pc = fake.connections.find((row) => row.name.includes('ttl-sess'));
    expect(pc).toBeTruthy();
    now = 1_200;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(pc?.closed).toBe(true);
    const [sigNode] = loopbackSignaling();
    await expect(mgr.acceptBrowser('ttl-sess', sigNode)).rejects.toBeInstanceOf(PeerHandshakeError);
  });

  test('successful nonce consume removes the authorize record', async () => {
    const { left, fake } = setup();
    await left.ready();
    const [sigNode, sigBrowser] = loopbackSignaling();
    const rtcSession = 'consume-once';
    const native = fake.module;
    const browserPc = new native.PeerConnection('browser', {
      iceServers: [],
    }) as FakePeerConnection;
    fixtures.push({ close: () => browserPc.close() });
    sigBrowser.onMessage((msg) => {
      if (msg.sdp) {
        const parsed = JSON.parse(msg.sdp) as { type: string; sdp: string };
        browserPc.setRemoteDescription(parsed.sdp, parsed.type);
      }
    });
    browserPc.onLocalDescription((sdp, type) => {
      sigBrowser.send({
        rtcSession,
        from: 'browser',
        to: left.identity.nodeId,
        sdp: JSON.stringify({ type, sdp }),
      });
    });
    const auth = await left.authorizeBrowser({
      rtcSession,
      uid: 'user-1',
      via: 'self',
      fpBrowser: normalizeFingerprint(browserPc.fingerprint),
    });
    const acceptP = left.acceptBrowser(rtcSession, sigNode);
    const dc = browserPc.createDataChannel(SESS_CHANNEL_LABEL);
    await new Promise<void>((resolve) => dc.onOpen(() => resolve()));
    dc.sendMessage(JSON.stringify({ nonce: encodeBase64url(auth?.nonce ?? new Uint8Array()) }));
    await acceptP;
    await expect(left.acceptBrowser(rtcSession, sigNode)).rejects.toBeInstanceOf(
      PeerHandshakeError
    );
  });
});
