import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { encodeBase64url, normalizeFingerprint, parseSdpFingerprint } from '@tmex/shared/auth';
import { LinkMux } from '@tmex/shared/link';
import { createMigratedAuthDb } from '../../auth/test-db';
import { UserStore } from '../../auth/user-store';
import { createGatewaySession } from '../../ws/test-helpers';
import type { RtcSignalMessage } from '../mesh-deps';
import { seedNodeIdentity, seedUser } from '../test-support';
import { PeerHandshakeError } from '../types';
import { CarrierSwitchController, type DirectCarrier } from './carrier-switch';
import { DataChannelCarrier } from './data-channel-carrier';
import type { RtcSignaling } from './ice';
import type { NodeDatachannelModule, RtcIceConfig } from './native';
import { RtcPeerManager, type RtcPeerManagerOptions, SESS_CHANNEL_LABEL } from './rtc-peer-manager';
import { pairDataChannels } from './test-fakes';

const nativeDir = process.env.TMEX_NATIVE_DIR;
const addonPath = nativeDir ? join(nativeDir, 'node_datachannel.node') : null;

async function loadNativeFromEnv(): Promise<NodeDatachannelModule | null> {
  if (!nativeDir || !addonPath) {
    console.warn('skipping rtc-loopback.integration.ts: TMEX_NATIVE_DIR is unset');
    return null;
  }
  if (!existsSync(addonPath)) {
    console.warn(`skipping rtc-loopback.integration.ts: addon missing at ${addonPath}`);
    return null;
  }
  process.env.TMEX_NATIVE_DIR = nativeDir;
  const require = createRequire(import.meta.url);
  try {
    const binding = require(addonPath) as NodeDatachannelModule;
    if (!binding.PeerConnection) {
      console.warn('skipping rtc-loopback.integration.ts: addon missing PeerConnection');
      return null;
    }
    return {
      PeerConnection: binding.PeerConnection,
      cleanup: binding.cleanup ?? (() => {}),
      preload: binding.preload ?? (() => {}),
      initLogger: binding.initLogger ?? (() => {}),
      getLibraryVersion: binding.getLibraryVersion ?? (() => ''),
    };
  } catch (error) {
    console.warn(
      `skipping rtc-loopback.integration.ts: failed to require addon: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return null;
  }
}

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
  ): () => void {
    cbs.push(cb);
    while (inbox.length > 0) {
      const next = inbox.shift();
      if (next) cb(next);
    }
    return () => {
      const idx = cbs.indexOf(cb);
      if (idx >= 0) cbs.splice(idx, 1);
    };
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

function wrapMismatch(mod: NodeDatachannelModule): NodeDatachannelModule {
  return {
    ...mod,
    PeerConnection: function MismatchPeerConnection(name: string, config: RtcIceConfig) {
      const inner = new mod.PeerConnection(name, config);
      return new Proxy(inner, {
        get(target, prop, receiver) {
          if (prop === 'remoteFingerprint') {
            return () => ({ algorithm: 'sha-256', value: '00:11:22:33' });
          }
          const value = Reflect.get(target, prop, receiver);
          if (typeof value === 'function') {
            return value.bind(target);
          }
          return value;
        },
      });
    } as unknown as NodeDatachannelModule['PeerConnection'],
  };
}

const nativeMod = await loadNativeFromEnv();

describe('carrier switch with GatewaySession (no native)', () => {
  test('does not deliver frames out of order across the switch', () => {
    const session = createGatewaySession();
    const [local, remote] = pairDataChannels('sess');
    const direct = new DataChannelCarrier(local) as DirectCarrier;
    const delivered: string[] = [];
    const barrier = new CarrierSwitchController({
      sendControl() {
        return 'sent';
      },
      deliverInbound(_session, bytes) {
        delivered.push(new TextDecoder().decode(bytes));
      },
    });
    barrier.attachDirect(session, direct);
    expect(session.activeCarrier).toBe(direct);
    remote.sendMessageBinary(
      Buffer.from([0, 0, 0, 1, 0, 0, 1, 0, ...new TextEncoder().encode('one')])
    );
    expect(delivered).toEqual([]);
    barrier.handleAck(session, 1);
    expect(session.activeCarrier).toBe(direct);
    expect(delivered).toEqual(['one']);
  });
});

describe.skipIf(!nativeMod)('rtc loopback (node-datachannel)', () => {
  const fixtures: Array<{ close: () => void }> = [];
  afterEach(() => {
    while (fixtures.length) fixtures.pop()?.close();
  });

  function managers(mod: NodeDatachannelModule) {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const a = seedNodeIdentity(store, 'user-1');
    const b = seedNodeIdentity(store, 'user-1');
    const ice = () => ({ stun: ['stun:stun.l.google.com:19302'], turn: null });
    const opts = (identity: typeof a): RtcPeerManagerOptions => ({
      loadNative: async () => mod,
      iceConfigProvider: ice,
      identity,
      userStore: store,
      handshakeTimeoutMs: 15_000,
    });
    const left = new RtcPeerManager(opts(a));
    const right = new RtcPeerManager(opts(b));
    fixtures.push({ close: () => left.close() });
    fixtures.push({ close: () => right.close() });
    return { a, b, left, right, store };
  }

  test('node↔node DataChannelLink + LinkMux round-trip', async () => {
    const { a, b, left, right } = managers(nativeMod as NodeDatachannelModule);
    const [sigA, sigB] = loopbackSignaling();
    const [la, lb] = await Promise.all([
      left.connectToPeer(b.nodeId, sigA),
      right.connectToPeer(a.nodeId, sigB),
    ]);
    const muxA = new LinkMux(la.link, { role: la.role });
    const muxB = new LinkMux(lb.link, { role: lb.role });
    const incoming = new Promise<import('@tmex/shared/link').LinkStream>((resolve) =>
      muxB.onStream(resolve)
    );
    const open = new TextEncoder().encode('{"type":"loop"}');
    const out = await muxA.openStream(open);
    const inn = await incoming;
    expect(inn.openPayload).toEqual(open);
    const reader = inn.readable.getReader();
    await out.write(new Uint8Array([4, 5, 6]));
    expect((await reader.read()).value?.bytes).toEqual(new Uint8Array([4, 5, 6]));
    out.end();
    inn.end();
    la.pc.close();
    lb.pc.close();
  });

  test('fingerprint mismatch is rejected', async () => {
    const mod = wrapMismatch(nativeMod as NodeDatachannelModule);
    const { a, b, left, right } = managers(mod);
    const [sigA, sigB] = loopbackSignaling();
    const results = await Promise.allSettled([
      left.connectToPeer(b.nodeId, sigA),
      right.connectToPeer(a.nodeId, sigB),
    ]);
    expect(results.some((row) => row.status === 'rejected')).toBe(true);
    const rejected = results.find((row) => row.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(PeerHandshakeError);
  });

  test('browser-style sess nonce with two PeerConnections', async () => {
    const mod = nativeMod as NodeDatachannelModule;
    const { left } = managers(mod);
    await left.ready();
    const [sigNode, sigBrowser] = loopbackSignaling();
    const rtcSession = 'integ-sess';
    const browserPc = new mod.PeerConnection('browser', {
      iceServers: ['stun:stun.l.google.com:19302'],
    });
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
    const dc = browserPc.createDataChannel(SESS_CHANNEL_LABEL);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('browser local desc timeout')), 10_000);
      const tick = () => {
        const desc = browserPc.localDescription();
        if (desc?.sdp) {
          clearTimeout(timer);
          resolve();
          return;
        }
        setTimeout(tick, 20);
      };
      tick();
    });
    const parsedFp = parseSdpFingerprint(browserPc.localDescription()?.sdp ?? '');
    const fpBrowser = normalizeFingerprint(parsedFp ?? { algorithm: 'sha-256', value: '00' });
    const auth = await left.authorizeBrowser({
      rtcSession,
      uid: 'user-1',
      via: 'self',
      sid: 'sid-integ-1',
      fpBrowser,
    });
    if (!auth) throw new Error('authorizeBrowser returned null');
    const acceptP = left.acceptBrowser(rtcSession, sigNode);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('sess open timeout')), 15_000);
      dc.onOpen(() => {
        clearTimeout(timer);
        resolve();
      });
      if (dc.isOpen()) {
        clearTimeout(timer);
        resolve();
      }
    });
    dc.sendMessage(JSON.stringify({ nonce: encodeBase64url(auth.nonce) }));
    const accepted = await acceptP;
    expect(accepted.uid).toBe('user-1');
    expect(accepted.carrier.send(new Uint8Array([7]))).toBe('sent');
    accepted.pc.close();
  });
});
