import { afterEach, describe, expect, test } from 'bun:test';
import { encodeBase64url, normalizeFingerprint } from '@vibeterm/shared/auth';
import {
  fingerprintsEqual,
  parseSdpFingerprint,
} from '../../../../../packages/ws-client/src/direct/fingerprint';
import { createMigratedAuthDb } from '../../auth/test-db';
import { UserStore } from '../../auth/user-store';
import { seedNodeIdentity, seedUser } from '../test-support';
import { PeerHandshakeError } from '../types';
import {
  AuthorizeBusyError,
  BROWSER_FP_PROBE_LABEL,
  RTC_AUTHORIZE_MAX_PER_SESSION,
  RTC_AUTHORIZE_MAX_PER_USER,
  RTC_AUTHORIZE_PENDING_TTL_MS,
} from './browser-authorize';
import { SESS_CHANNEL_LABEL } from './rtc-peer-helpers';
import { RtcPeerManager } from './rtc-peer-manager';
import { loopbackSignaling } from './rtc-test-fixtures';
import { FakeDataChannel, FakePeerConnection, createFakeNativeModule } from './test-fakes';

class SilentPeer extends FakePeerConnection {
  override createDataChannel(label: string): FakeDataChannel {
    const dc = new FakeDataChannel(label);
    this.created.push(dc);
    return dc;
  }
}

describe('browser authorize fingerprint', () => {
  const fixtures: Array<{ close: () => void }> = [];
  const originalLog = console.log;
  afterEach(() => {
    console.log = originalLog;
    while (fixtures.length) fixtures.pop()?.close();
  });

  function setup(opts?: { handshakeTimeoutMs?: number }) {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const identity = seedNodeIdentity(store, 'user-1');
    const fake = createFakeNativeModule();
    const mgr = new RtcPeerManager({
      loadNative: async () => fake.module,
      iceConfigProvider: () => ({ stun: [], turn: null }),
      identity,
      userStore: store,
      handshakeTimeoutMs: opts?.handshakeTimeoutMs ?? 2_000,
      sweepIntervalMs: 0,
    });
    fixtures.push({ close: () => mgr.close() });
    return { mgr, fake, identity };
  }

  function captureLogs(): string[] {
    const lines: string[] = [];
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    return lines;
  }

  test('fresh peer connection has no local description until a channel is created', () => {
    const { fake } = setup();
    const pc = new fake.module.PeerConnection('bare', { iceServers: [] }) as FakePeerConnection;
    fixtures.push({ close: () => pc.close() });
    expect(pc.localDescription()).toBeNull();
    expect(pc.signalingState()).toBe('stable');
  });

  test('authorize primes a stable answerer whose answer fingerprint matches fp_node', async () => {
    const { mgr, fake, identity } = setup();
    await mgr.ready();
    const logs = captureLogs();
    const [sigNode, sigBrowser] = loopbackSignaling();
    const rtcSession = 'auth-fp';
    const browser = new fake.module.PeerConnection('browser', {
      iceServers: [],
    }) as FakePeerConnection;
    fixtures.push({ close: () => browser.close() });
    let answerSdp = '';
    const applied: string[] = [];
    sigBrowser.onMessage((msg) => {
      if (!msg.sdp) return;
      const parsed = JSON.parse(msg.sdp) as { type: string; sdp: string };
      applied.push(parsed.type);
      if (parsed.type === 'answer') answerSdp = parsed.sdp;
      browser.setRemoteDescription(parsed.sdp, parsed.type);
    });
    browser.onLocalDescription((sdp, type) => {
      sigBrowser.send({
        rtcSession,
        from: 'browser',
        to: identity.nodeId,
        sdp: JSON.stringify({ type, sdp }),
      });
    });
    const dc = browser.createDataChannel(SESS_CHANNEL_LABEL);
    const started = Date.now();
    const auth = await mgr.authorizeBrowser({
      rtcSession,
      uid: 'user-1',
      via: 'entry-1',
      sid: 'sid-1',
      fpBrowser: normalizeFingerprint(browser.fingerprint),
    });
    expect(Date.now() - started).toBeLessThan(500);
    expect(auth?.fpNode.algorithm).toBe('sha-256');
    const node = fake.connections.find((row) => row.name.includes(rtcSession));
    expect(node?.signalingState()).toBe('stable');
    // libdatachannel 回滚后 signaling 回到 stable，但第一次 pending offer 仍留在 localDescription。
    expect(node?.localDescription()?.type).toBe('offer');
    if (node) {
      node.sdpSuffix = [
        'a=candidate:1 1 UDP 1 198.18.0.1 9 typ host',
        'a=candidate:2 1 UDP 1 192.168.1.9 9 typ host',
      ].join('\r\n');
    }
    const probes = node?.created.filter((row) => row.label === BROWSER_FP_PROBE_LABEL) ?? [];
    expect(probes.length).toBe(1);
    expect(probes.every((row) => row.closed)).toBe(true);
    expect(
      logs.some((line) => line.includes('[mesh][rtc] authorize') && line.includes('via=entry-1'))
    ).toBe(true);
    expect(logs.some((line) => line.includes(auth?.fpNode.value ?? 'missing-fp'))).toBe(false);

    const acceptP = mgr.acceptBrowser(rtcSession, sigNode);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('sess open timeout')), 1_000);
      dc.onOpen(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    dc.sendMessage(JSON.stringify({ nonce: encodeBase64url(auth?.nonce ?? new Uint8Array()) }));
    const accepted = await acceptP;
    expect(accepted.sid).toBe('sid-1');
    expect(applied).toEqual(['answer']);
    expect(answerSdp).not.toContain('198.18.0.1');
    expect(answerSdp).toContain('192.168.1.9');
    expect(fingerprintsEqual(parseSdpFingerprint(answerSdp), auth?.fpNode)).toBe(true);
    accepted.pc.close();
  });

  test('aborted authorize closes the peer connection', async () => {
    const { mgr, fake } = setup();
    await mgr.ready();
    const logs = captureLogs();
    const signal = AbortSignal.abort();
    await expect(
      mgr.authorizeBrowser(
        {
          rtcSession: 'aborted',
          uid: 'user-1',
          via: 'entry-1',
          sid: 'sid-abort',
          fpBrowser: { algorithm: 'sha-256', value: 'AA' },
        },
        { signal }
      )
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(mgr.authorizationOf('aborted')).toBeNull();
    expect(fake.connections.find((row) => row.name.includes('aborted'))?.closed).toBe(true);
    expect(
      logs.some((line) => line.includes('authorize failed') && line.includes('reason=aborted'))
    ).toBe(true);
  });

  test('fingerprint timeout closes the record instead of hanging for the handshake budget', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const identity = seedNodeIdentity(store, 'user-1');
    const pcs: SilentPeer[] = [];
    const mgr = new RtcPeerManager({
      loadNative: async () => ({
        PeerConnection: function SilentNative(name: string, config: { iceServers: string[] }) {
          const pc = new SilentPeer(name, config);
          pcs.push(pc);
          return pc;
        } as unknown as ReturnType<typeof createFakeNativeModule>['module']['PeerConnection'],
        cleanup() {},
        preload() {},
        initLogger() {},
        getLibraryVersion: () => 'fake',
      }),
      iceConfigProvider: () => ({ stun: [], turn: null }),
      identity,
      userStore: store,
      handshakeTimeoutMs: 40,
      sweepIntervalMs: 0,
    });
    fixtures.push({ close: () => mgr.close() });
    await mgr.ready();
    const logs = captureLogs();
    const started = Date.now();
    await expect(
      mgr.authorizeBrowser({
        rtcSession: 'slow',
        uid: 'user-1',
        via: 'entry-1',
        sid: 'sid-slow',
        fpBrowser: { algorithm: 'sha-256', value: 'AA' },
      })
    ).rejects.toBeInstanceOf(PeerHandshakeError);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(mgr.authorizationOf('slow')).toBeNull();
    expect(pcs.find((row) => row.name.includes('slow'))?.closed).toBe(true);
    expect(logs.some((line) => line.includes('reason=timeout'))).toBe(true);
  });

  test('createPeerConnection answerer never calls bare setLocalDescription', async () => {
    const { mgr, fake } = setup();
    await mgr.ready();
    const before = fake.connections.length;
    await expect(mgr.createPeerConnection('answerer')).rejects.toBeInstanceOf(PeerHandshakeError);
    expect(fake.connections.length).toBe(before);
  });

  test('one session cannot fill the node authorize cap', async () => {
    const { mgr, fake } = setup();
    await mgr.ready();
    const fp = { algorithm: 'sha-256', value: 'AA' };
    for (let i = 0; i < RTC_AUTHORIZE_MAX_PER_SESSION; i++) {
      const auth = await mgr.authorizeBrowser({
        rtcSession: `sess-${i}`,
        uid: 'user-1',
        via: 'self',
        sid: 'sid-same',
        fpBrowser: fp,
      });
      expect(auth).not.toBeNull();
    }
    const before = fake.connections.length;
    await expect(
      mgr.authorizeBrowser({
        rtcSession: 'sess-overflow',
        uid: 'user-1',
        via: 'self',
        sid: 'sid-same',
        fpBrowser: fp,
      })
    ).rejects.toBeInstanceOf(AuthorizeBusyError);
    expect(fake.connections.length).toBe(before);
    const otherSession = await mgr.authorizeBrowser({
      rtcSession: 'other-tab',
      uid: 'user-1',
      via: 'self',
      sid: 'sid-other',
      fpBrowser: fp,
    });
    expect(otherSession).not.toBeNull();
    const refreshed = await mgr.authorizeBrowser({
      rtcSession: 'sess-0',
      uid: 'user-1',
      via: 'self',
      sid: 'sid-same',
      fpBrowser: fp,
    });
    expect(refreshed).not.toBeNull();
  });

  test('one user cannot fill the node authorize cap across sessions', async () => {
    const { mgr } = setup();
    await mgr.ready();
    const fp = { algorithm: 'sha-256', value: 'AA' };
    for (let i = 0; i < RTC_AUTHORIZE_MAX_PER_USER; i++) {
      const auth = await mgr.authorizeBrowser({
        rtcSession: `user-sess-${i}`,
        uid: 'user-1',
        via: 'self',
        sid: `sid-${i}`,
        fpBrowser: fp,
      });
      expect(auth).not.toBeNull();
    }
    await expect(
      mgr.authorizeBrowser({
        rtcSession: 'user-overflow',
        uid: 'user-1',
        via: 'self',
        sid: 'sid-overflow',
        fpBrowser: fp,
      })
    ).rejects.toBeInstanceOf(AuthorizeBusyError);
    const otherUser = await mgr.authorizeBrowser({
      rtcSession: 'user-2-sess',
      uid: 'user-2',
      via: 'self',
      sid: 'sid-user-2',
      fpBrowser: fp,
    });
    expect(otherUser).not.toBeNull();
  });

  test('an authorized record with no offer expires at the pending TTL and is closed', async () => {
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
      authorizeTtlMs: 120_000,
      sweepIntervalMs: 0,
    });
    fixtures.push({ close: () => mgr.close() });
    await mgr.ready();
    const auth = await mgr.authorizeBrowser({
      rtcSession: 'pending',
      uid: 'user-1',
      via: 'self',
      sid: 'sid-pending',
      fpBrowser: { algorithm: 'sha-256', value: 'AA' },
    });
    expect(auth).not.toBeNull();
    const pc = fake.connections.find((row) => row.name.includes('pending'));
    now = 1_000 + RTC_AUTHORIZE_PENDING_TTL_MS - 1;
    expect(mgr.authorizationOf('pending')?.sid).toBe('sid-pending');
    now = 1_000 + RTC_AUTHORIZE_PENDING_TTL_MS;
    const [sigNode] = loopbackSignaling();
    await expect(mgr.acceptBrowser('pending', sigNode)).rejects.toBeInstanceOf(PeerHandshakeError);
    expect(pc?.closed).toBe(true);
    expect(mgr.authorizationOf('pending')).toBeNull();
  });

  test('accept extends the record past the pending TTL', async () => {
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
      authorizeTtlMs: 120_000,
      handshakeTimeoutMs: 50,
      sweepIntervalMs: 0,
    });
    fixtures.push({ close: () => mgr.close() });
    await mgr.ready();
    await mgr.authorizeBrowser({
      rtcSession: 'hold',
      uid: 'user-1',
      via: 'self',
      sid: 'sid-hold',
      fpBrowser: { algorithm: 'sha-256', value: 'AA' },
    });
    now = 1_000 + 20_000;
    const [sigNode] = loopbackSignaling();
    const pending = mgr.acceptBrowser('hold', sigNode);
    pending.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    now = 1_000 + RTC_AUTHORIZE_PENDING_TTL_MS;
    expect(mgr.authorizationOf('hold')?.sid).toBe('sid-hold');
    expect(fake.connections.find((row) => row.name.includes('hold'))?.closed).toBe(false);
  });
});
