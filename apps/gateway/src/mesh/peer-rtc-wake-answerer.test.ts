import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createMigratedAuthDb } from '../auth/test-db';
import { UserStore } from '../auth/user-store';
import { PeerManager } from './peer-manager';
import { dummyUplink } from './peer-test-fixtures';
import type { RtcPeerManager } from './rtc';
import { encodeCandidateSignal, encodeSdpSignal, peerRtcSession } from './rtc/ice';
import { resetRtcLogStateForTest } from './rtc/rtc-log';
import { RTC_OFFER_EPOCH_TTL_MS } from './rtc/rtc-offer-epoch';
import { createFakeNativeModule } from './rtc/test-fakes';
import { seedNodeIdentity, seedUser, waitUntil } from './test-support';

const OFFERER_NODE_ID = new Uint8Array(16).fill(0x11);
const ANSWERER_NODE_ID = new Uint8Array(16).fill(0xee);

type OutgoingSignal = { sdp: string | null; candidate: string | null };

async function setupAnswerer(
  fixtures: Array<{ close: () => void; stop?: () => Promise<void> }>,
  opts?: { handshakeTimeoutMs?: number }
) {
  const clock = { ms: Date.now() };
  const { db, close } = createMigratedAuthDb();
  fixtures.push({ close });
  const store = new UserStore(db);
  seedUser(store);
  const offerer = seedNodeIdentity(store, 'user-1', { nodeId: OFFERER_NODE_ID });
  const self = seedNodeIdentity(store, 'user-1', { nodeId: ANSWERER_NODE_ID });
  for (const [nodeId, name] of [
    [offerer.nodeId, 'offerer'],
    [self.nodeId, 'answerer'],
  ] as const) {
    store.upsertPeer({
      nodeId,
      name,
      endpointsJson: '[]',
      inventoryJson: '{}',
      directCapable: true,
      lastSeenAt: Date.now(),
      listVersion: 1,
    });
  }
  const fake = createFakeNativeModule();
  const { RtcPeerManager: Impl } = await import('./rtc');
  const rtc: RtcPeerManager = new Impl({
    loadNative: async () => fake.module,
    iceConfigProvider: () => ({ stun: [] as string[], turn: null }),
    identity: self,
    userStore: store,
    handshakeTimeoutMs: opts?.handshakeTimeoutMs ?? 200,
    now: () => clock.ms,
  });
  fixtures.push({ close: () => rtc.close() });
  await rtc.ready();
  const sent: OutgoingSignal[] = [];
  const uplink = dummyUplink(self, store, async () => {
    throw new Error('no-relay');
  });
  uplink.sendCtl = (msg) => {
    const record = msg as unknown as { t: string; sdp?: string; candidate?: string };
    if (record.t !== 'rtc.signal') return;
    sent.push({ sdp: record.sdp ?? null, candidate: record.candidate ?? null });
  };
  const manager = new PeerManager({
    identity: self,
    userStore: store,
    uplink,
    peerPort: 0,
    startServer: false,
    rtc,
  });
  fixtures.push({ close, stop: () => manager.stop() });
  const session = peerRtcSession(offerer.nodeId, self.nodeId);
  const offer = (epoch: number) => {
    manager.receiveRtcSignal(offerer.nodeId, {
      rtcSession: session,
      from: 'node',
      to: self.nodeId,
      sdp: encodeSdpSignal({ type: 'offer', sdp: 'v=0\r\na=ice-ufrag:remote', epoch }),
      candidate: null,
    });
  };
  const candidate = (epoch: number, n = 1) => {
    manager.receiveRtcSignal(offerer.nodeId, {
      rtcSession: session,
      from: 'node',
      to: self.nodeId,
      sdp: null,
      candidate: encodeCandidateSignal(
        `candidate:${n} 1 UDP 1 192.0.2.${n} 9 typ host`,
        '0',
        epoch
      ),
    });
  };
  const answers = () => sent.filter((item) => item.sdp?.includes('"answer"'));
  const wakes = () => sent.filter((item) => item.sdp?.includes('rtc.wake'));
  return { manager, offerer, self, sent, offer, candidate, answers, wakes, fake, clock };
}

describe('answerer applies a peer-initiated offer', () => {
  const fixtures: Array<{ close: () => void; stop?: () => Promise<void> }> = [];
  let lines: string[] = [];
  let restoreLog: (() => void) | null = null;

  beforeEach(() => {
    resetRtcLogStateForTest();
    lines = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    restoreLog = () => {
      console.log = orig;
    };
  });

  afterEach(async () => {
    restoreLog?.();
    restoreLog = null;
    while (fixtures.length) {
      const item = fixtures.pop();
      await item?.stop?.();
      item?.close();
    }
  });

  const dropped = () => lines.filter((line) => line.includes('signal dropped'));

  test('offer and candidates buffered before the attempt exists reach the answerer', async () => {
    const h = await setupAnswerer(fixtures);
    h.offer(7);
    h.candidate(7, 1);
    h.candidate(7, 2);
    await waitUntil(() => h.answers().length > 0, 2_000);
    await waitUntil(
      () => lines.some((line) => line.includes('dial timeout') && line.includes('stage=checking')),
      2_000
    );
    expect(
      lines.some(
        (line) =>
          line.includes('dial timeout') &&
          line.includes('epoch=7') &&
          line.includes('remote_types=[host]')
      )
    ).toBe(true);
    expect(dropped()).toEqual([]);
  });

  test('candidates arriving before the offer on a wake-started attempt are queued', async () => {
    const h = await setupAnswerer(fixtures, { handshakeTimeoutMs: 1_000 });
    void h.manager.getLink(h.offerer.nodeId).catch(() => undefined);
    await waitUntil(() => h.wakes().length > 0 && h.fake.connections.length > 0, 2_000);
    h.candidate(7, 1);
    h.candidate(7, 2);
    h.offer(7);
    await waitUntil(() => h.answers().length > 0, 2_000);
    await waitUntil(
      () => lines.some((line) => line.includes('dial timeout') && line.includes('stage=checking')),
      3_000
    );
    expect(
      lines.some((line) => line.includes('dial timeout') && line.includes('remote_types=[host]'))
    ).toBe(true);
    expect(dropped()).toEqual([]);
  });

  test('a restarted offerer whose epoch counter reset is answered again', async () => {
    const h = await setupAnswerer(fixtures);
    h.offer(50);
    await waitUntil(() => h.answers().length > 0, 2_000);
    const first = h.answers().length;
    await waitUntil(() => lines.some((line) => line.includes('dial timeout')), 2_000);
    // 对端进程重启：epoch 计数归零，旧的高位记忆过期后不能再把新 offer 当成陈旧信令。
    h.clock.ms += RTC_OFFER_EPOCH_TTL_MS + 1;
    lines = [];
    h.offer(1);
    h.candidate(1, 1);
    await waitUntil(() => h.answers().length > first, 2_000);
    await waitUntil(
      () => lines.some((line) => line.includes('dial timeout') && line.includes('stage=checking')),
      2_000
    );
    expect(dropped()).toEqual([]);
  });

  test('a stale epoch is still rejected while the memory is fresh', async () => {
    const h = await setupAnswerer(fixtures);
    h.offer(50);
    await waitUntil(() => h.answers().length > 0, 2_000);
    await waitUntil(() => lines.some((line) => line.includes('dial timeout')), 2_000);
    lines = [];
    h.offer(3);
    await waitUntil(() => dropped().some((line) => line.includes('cause=epoch-mismatch')), 2_000);
    expect(h.answers()).toHaveLength(1);
  });
});
