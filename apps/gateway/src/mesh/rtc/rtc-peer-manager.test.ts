import { afterEach, describe, expect, test } from 'bun:test';

// 真实 node-datachannel 的 ICE/DC 用例需要可用的本地网络候选；CI runner 没有，用环境变量跳过。
const describeRtc = process.env.TMEX_SKIP_RTC_TESTS === '1' ? describe.skip : describe;
import { wsBorsh } from '@tmex/shared';
import { encodeBase64url, normalizeFingerprint } from '@tmex/shared/auth';
import { LinkMux } from '@tmex/shared/link';
import { createMigratedAuthDb } from '../../auth/test-db';
import { UserStore } from '../../auth/user-store';
import { createGatewaySession } from '../../ws/test-helpers';
import { seedNodeIdentity, seedUser } from '../test-support';
import { PeerHandshakeError } from '../types';
import { DataChannelCarrier } from './data-channel-carrier';
import { fragmentFrame } from './fragmenter';
import type { RtcSignaling } from './ice';
import { RtcDialBreaker } from './rtc-dial-breaker';
import { RTC_AUTHORIZE_MAX, RtcPeerManager, SESS_CHANNEL_LABEL } from './rtc-peer-manager';
import { loopbackSignaling } from './rtc-test-fixtures';
import { type FakePeerConnection, createFakeNativeModule, pairDataChannels } from './test-fakes';

describeRtc('RtcPeerManager', () => {
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
    expect(left.available).toBe(true);
    expect(await left.ready()).toBe(true);
    expect(left.available).toBe(true);
  });

  test('constructor does not load native; first dial loads once; disabled never loads', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const a = seedNodeIdentity(store, 'user-1');
    const b = seedNodeIdentity(store, 'user-1');
    const fake = createFakeNativeModule();
    const ice = () => ({ stun: [] as string[], turn: null });
    let loads = 0;
    const breaker = new RtcDialBreaker({ now: () => 0, disableAfter: 1 });
    breaker.noteFailure(b.nodeId, 'timeout', 'pre');
    expect(breaker.isDisabled(b.nodeId)).toBe(true);

    const disabled = new RtcPeerManager({
      loadNative: async () => {
        loads += 1;
        return fake.module;
      },
      canLoadNative: () => !breaker.isDisabled(b.nodeId),
      iceConfigProvider: ice,
      identity: a,
      userStore: store,
      handshakeTimeoutMs: 200,
    });
    fixtures.push({ close: () => disabled.close() });
    expect(loads).toBe(0);
    const [sigA] = loopbackSignaling();
    await expect(disabled.connectToPeer(b.nodeId, sigA)).rejects.toBeInstanceOf(PeerHandshakeError);
    expect(loads).toBe(0);
    expect(await disabled.ready()).toBe(false);
    expect(loads).toBe(0);

    let dialLoads = 0;
    const left = new RtcPeerManager({
      loadNative: async () => {
        dialLoads += 1;
        return fake.module;
      },
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
    expect(dialLoads).toBe(0);
    const [sigLeft, sigRight] = loopbackSignaling();
    await Promise.all([
      left.connectToPeer(b.nodeId, sigLeft),
      right.connectToPeer(a.nodeId, sigRight),
    ]);
    expect(dialLoads).toBe(1);
    await left.createPeerConnection('offerer');
    expect(dialLoads).toBe(1);
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

  test('late hello after both links are up does not fragment-protocol the DC', async () => {
    const { left, right, a, b } = setup();
    const [sigA, sigB] = loopbackSignaling();
    const [la, lb] = await Promise.all([
      left.connectToPeer(b.nodeId, sigA),
      right.connectToPeer(a.nodeId, sigB),
    ]);
    let linkClosedReason: string | undefined;
    la.link.onClose((reason) => {
      linkClosedReason = reason;
    });
    lb.link.channel.sendMessage(
      JSON.stringify({
        t: 'hello',
        node_id: b.nodeId,
        nonce: encodeBase64url(new Uint8Array(32)),
        dtls_fingerprint: { algorithm: 'sha-256', value: '00' },
      })
    );
    await Promise.resolve();
    expect({ linkClosedReason, channelOpen: la.link.channel.isOpen() }).toEqual({
      linkClosedReason: undefined,
      channelOpen: true,
    });
    const muxA = new LinkMux(la.link, { role: la.role });
    const muxB = new LinkMux(lb.link, { role: lb.role });
    const incoming = new Promise<import('@tmex/shared/link').LinkStream>((resolve) =>
      muxB.onStream(resolve)
    );
    const out = await muxA.openStream(new Uint8Array([1]));
    const inn = await incoming;
    const reader = inn.readable.getReader();
    await out.write(new Uint8Array([2, 3]));
    expect((await reader.read()).value?.bytes).toEqual(new Uint8Array([2, 3]));
    out.end();
    inn.end();
  });

  test('datachannel diagnostics and DataChannelLink both observe open and close', async () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      const { left, right, a, b } = setup();
      const [sigA, sigB] = loopbackSignaling();
      const [la] = await Promise.all([
        left.connectToPeer(b.nodeId, sigA),
        right.connectToPeer(a.nodeId, sigB),
      ]);
      expect(lines.some((line) => line.includes('datachannel open'))).toBe(true);
      let closeCount = 0;
      const closed = new Promise<string | undefined>((resolve) =>
        la.link.onClose((reason) => {
          closeCount += 1;
          resolve(reason);
        })
      );
      la.link.close('bye');
      expect(await closed).toBe('bye');
      la.link.close('bye-again');
      expect(closeCount).toBe(1);
      expect(
        lines.filter((line) => line.includes('datachannel closed')).length
      ).toBeGreaterThanOrEqual(1);
    } finally {
      console.log = orig;
    }
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

  test('browser sess nonce plus the first carrier frame back-to-back reaches the carrier', async () => {
    const { left, fake } = setup();
    await left.ready();
    const [sigNode, sigBrowser] = loopbackSignaling();
    const rtcSession = 'browser-sess-handoff';
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
    const auth = await left.authorizeBrowser({
      rtcSession,
      uid: 'user-1',
      via: 'self',
      sid: 'sid-browser-handoff',
      fpBrowser: normalizeFingerprint(browserPc.fingerprint),
    });
    expect(auth).not.toBeNull();
    const acceptP = left.acceptBrowser(rtcSession, sigNode);
    const dc = browserPc.createDataChannel(SESS_CHANNEL_LABEL);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('sess open timeout')), 2000);
      dc.onOpen(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    const firstFrame = new Uint8Array([7, 8, 9]);
    dc.sendMessage(JSON.stringify({ nonce: encodeBase64url(auth?.nonce ?? new Uint8Array()) }));
    for (const part of fragmentFrame(1, firstFrame)) {
      dc.sendMessageBinary(Buffer.from(part));
    }
    const accepted = await acceptP;
    const got = new Promise<Uint8Array>((resolve) => accepted.carrier.onMessage(resolve));
    expect(await got).toEqual(firstFrame);
    accepted.carrier.close(1000, 'done');
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
      sid: 'sid-bad-nonce',
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
      sid: 'sid-cap-0',
      fpBrowser: fp,
    });
    expect(first).not.toBeNull();
    for (let i = 1; i < RTC_AUTHORIZE_MAX; i++) {
      const auth = await left.authorizeBrowser({
        rtcSession: `cap-${i}`,
        uid: 'user-1',
        via: 'self',
        sid: `sid-cap-${i}`,
        fpBrowser: fp,
      });
      expect(auth).not.toBeNull();
    }
    const overflow = await left.authorizeBrowser({
      rtcSession: 'cap-overflow',
      uid: 'user-1',
      via: 'self',
      sid: 'sid-overflow',
      fpBrowser: fp,
    });
    expect(overflow).toBeNull();
    const refresh = await left.authorizeBrowser({
      rtcSession: 'cap-0',
      uid: 'user-1',
      via: 'self',
      sid: 'sid-cap-0',
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
      sid: 'sid-ttl',
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
      sid: 'sid-consume',
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

  test('authorizeBrowser requires sid and does not create a PC without it', async () => {
    const { left, fake } = setup();
    await left.ready();
    const before = fake.connections.length;
    const missing = await left.authorizeBrowser({
      rtcSession: 'no-sid',
      uid: 'user-1',
      via: 'self',
      fpBrowser: { algorithm: 'sha-256', value: 'AA' },
    });
    expect(missing).toBeNull();
    expect(fake.connections.length).toBe(before);
    const empty = await left.authorizeBrowser({
      rtcSession: 'empty-sid',
      uid: 'user-1',
      via: 'self',
      sid: '',
      fpBrowser: { algorithm: 'sha-256', value: 'AA' },
    });
    expect(empty).toBeNull();
    expect(fake.connections.length).toBe(before);
  });

  test('attachDirect forwards rtcSession into CARRIER_SWITCH and ACK matching', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const identity = seedNodeIdentity(store, 'user-1');
    const fake = createFakeNativeModule();
    const controls: Array<{ epoch: number; rtcSession: string }> = [];
    const mgr = new RtcPeerManager({
      loadNative: async () => fake.module,
      iceConfigProvider: () => ({ stun: [], turn: null }),
      identity,
      userStore: store,
      sendControl(_session, kind, payload) {
        if (kind === wsBorsh.KIND_CARRIER_SWITCH) {
          const decoded = wsBorsh.decodePayload(wsBorsh.schema.CarrierSwitchSchema, payload);
          controls.push({ epoch: decoded.epoch, rtcSession: decoded.rtcSession });
        }
        return 'sent';
      },
      deliverInbound() {},
    });
    fixtures.push({ close: () => mgr.close() });
    await mgr.ready();
    const session = createGatewaySession();
    const [local, remote] = pairDataChannels('sess');
    const carrier = new DataChannelCarrier(local);
    mgr.attachDirect(session, carrier, { rtcSession: 'br:from-accept' });
    expect(controls).toEqual([{ epoch: 1, rtcSession: 'br:from-accept' }]);
    remote.sendMessageBinary(
      Buffer.from([0, 0, 0, 1, 0, 0, 1, 0, ...new TextEncoder().encode('A')])
    );
    mgr.handleCarrierSwitchAck(session, 1, 'br:stale');
    mgr.handleCarrierSwitchAck(session, 1, 'br:from-accept');
  });

  test('connectToPeer emits structured rtc logs without SDP or credentials', async () => {
    const { left, right, a, b } = setup();
    const lines: string[] = [];
    const orig = console.log;
    const prevLevel = process.env.TMEX_LOG_LEVEL;
    process.env.TMEX_LOG_LEVEL = 'debug';
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      const [sigA, sigB] = loopbackSignaling();
      await Promise.all([left.connectToPeer(b.nodeId, sigA), right.connectToPeer(a.nodeId, sigB)]);
    } finally {
      console.log = orig;
      if (prevLevel === undefined) delete process.env.TMEX_LOG_LEVEL;
      else process.env.TMEX_LOG_LEVEL = prevLevel;
    }
    const rtc = lines.filter((line) => line.includes('[mesh][rtc]'));
    expect(rtc.some((line) => line.includes('dial start'))).toBe(true);
    expect(
      rtc.some((line) => line.includes('role=offerer') || line.includes('role=answerer'))
    ).toBe(true);
    expect(rtc.some((line) => line.includes('signal send') && line.includes('kind=sdp'))).toBe(
      true
    );
    expect(rtc.some((line) => line.includes('datachannel open'))).toBe(true);
    expect(rtc.join('\n')).not.toContain('ice-pwd');
    expect(rtc.join('\n')).not.toMatch(/a=fingerprint:/);
  });

  test('ice failed summary lists local and remote candidate types', async () => {
    const { left, a, b, fake } = setup();
    await left.ready();
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      const signaling: RtcSignaling = {
        send() {},
        onMessage(cb) {
          cb({
            rtcSession: `dc:${a.nodeId}:${b.nodeId}`,
            from: 'node',
            to: a.nodeId,
            candidate: JSON.stringify({
              candidate: 'candidate:2 1 UDP 1 203.0.113.44 9 typ srflx',
              mid: '0',
            }),
          });
          return () => {};
        },
      };
      const connect = left.connectToPeer(b.nodeId, signaling);
      await Bun.sleep(20);
      const pc = fake.connections.find((row) => row.name.includes(b.nodeId.toLowerCase()));
      expect(pc).toBeTruthy();
      pc?.emitLocalCandidate('candidate:1 1 UDP 1 10.0.1.55 9 typ host', '0');
      pc?.emitIceState('failed');
      await expect(connect).rejects.toBeTruthy();
    } finally {
      console.log = orig;
    }
    const summary = lines.find((line) => line.includes('ice failed'));
    expect(summary).toBeTruthy();
    expect(summary).toContain(`peer=${b.nodeId}`);
    expect(summary).toMatch(/local_types=\[.*host.*\]/);
    expect(summary).toMatch(/remote_types=\[.*srflx.*\]/);
    expect(summary).not.toContain('203.0.113.44');
  });
});
