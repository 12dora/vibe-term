import { describe, expect, test } from 'bun:test';
import { decodeJsonBytes } from './ctl';
import { type PeerCtlHost, handlePeerCtl, receiveRtcSignal } from './peer-ctl';
import { noteDialDcFailure } from './peer-dialer-dc-gate';
import type { PeerManagerState } from './peer-manager-state';
import type { LivePeer } from './peer-reconnect-wake';
import { encodeCandidateSignal, encodeSdpSignal, peerRtcSession } from './rtc/ice';
import type { PeerConnectionLike } from './rtc/native';
import {
  encodeDcOfferDecline,
  isDcOfferDecline,
  readDcOfferDecline,
  readDcOfferDeclineDetail,
} from './rtc/rtc-offer-decline';
import { applyRemoteSdp, createSignalingAttemptState } from './rtc/rtc-signal-apply';

function encodeCtl(msg: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(msg));
}

function fakeHost(overrides: Partial<PeerCtlHost> = {}): PeerCtlHost & {
  pongs: number;
  upgrades: string[];
  wakes: string[];
  browser: Array<{ from?: string }>;
  link: string[];
} {
  const tally = { pongs: 0 };
  const upgrades: string[] = [];
  const wakes: string[] = [];
  const browser: Array<{ from?: string }> = [];
  const link: string[] = [];
  const host = {
    identity: { nodeId: 'aa'.repeat(16) },
    state: {
      rtcInbox: new Map(),
      pending: new Map(),
      upgrading: new Map(),
      live: new Map(),
      scheduler: { now: () => 1 },
    } as unknown as PeerManagerState,
    statusSync: {
      applyPeerStatus: async () => undefined,
      serveKeyLog: async () => undefined,
      applyKeyLogRes: async () => undefined,
    },
    registry: {
      onPeerPong: () => {
        tally.pongs += 1;
      },
    },
    drain: {
      handleLinkCtl: (_live: LivePeer, t: string) => {
        link.push(t);
      },
    },
    dialer: { hasDcInflight: () => false, dcCapable: () => false },
    reroll: { interceptRtc: () => false },
    dcUpgrade: {
      dcBreaker: { shouldAcceptAnswer: () => false, inboundBlock: () => null },
    },
    rtcListeners: new Map(),
    onBrowserSignal: (_msg: unknown, from?: string) => {
      browser.push({ from });
    },
    isTrusted: () => true,
    maybeUpgrade: (nodeId: string) => {
      upgrades.push(nodeId);
    },
    handleIncomingRtcWake: (fromNodeId: string) => {
      wakes.push(fromNodeId);
    },
    get pongs() {
      return tally.pongs;
    },
    upgrades,
    wakes,
    browser,
    link,
    ...overrides,
  };
  return host;
}

function fakeLive(peerNodeId = 'bb'.repeat(16)): LivePeer {
  return { peerNodeId, session: { sendCtl: () => undefined } } as unknown as LivePeer;
}

describe('handlePeerCtl', () => {
  test('ignores malformed payloads', () => {
    const host = fakeHost();
    handlePeerCtl(host, fakeLive(), new Uint8Array([0xff, 0xfe]));
    expect(host.pongs).toBe(0);
  });

  test('pong updates registry liveness', () => {
    const host = fakeHost();
    handlePeerCtl(host, fakeLive(), encodeCtl({ t: 'pong' }));
    expect(host.pongs).toBe(1);
  });

  test('link.* ctl is handed to drain', () => {
    const host = fakeHost();
    handlePeerCtl(host, fakeLive(), encodeCtl({ t: 'link.hello' }));
    expect(host.link).toEqual(['link.hello']);
  });

  test('browser rtc.signal goes to onBrowserSignal', () => {
    const host = fakeHost();
    const live = fakeLive();
    handlePeerCtl(
      host,
      live,
      encodeCtl({ t: 'rtc.signal', from: 'browser', rtcSession: 's', to: 'x' })
    );
    expect(host.browser).toEqual([{ from: live.peerNodeId }]);
  });
});

describe('receiveRtcSignal', () => {
  test('drops untrusted peers', () => {
    const host = fakeHost({ isTrusted: () => false });
    receiveRtcSignal(host, 'bb'.repeat(16), {
      rtcSession: 's',
      from: 'node',
      to: '',
      sdp: 'v=0',
      candidate: null,
    });
    expect(host.wakes).toEqual([]);
    expect(host.upgrades).toEqual([]);
  });

  test('browser origin is forwarded without trust check', () => {
    const host = fakeHost({ isTrusted: () => false });
    receiveRtcSignal(host, 'bb'.repeat(16), {
      rtcSession: 's',
      from: 'browser',
      to: '',
      sdp: null,
      candidate: null,
    });
    expect(host.browser).toEqual([{ from: 'bb'.repeat(16) }]);
  });

  test('blocked offer is declined before the inbox and the offerer stops without a dial failure', () => {
    const peer = 'bb'.repeat(16);
    const sent: unknown[] = [];
    const host = fakeHost({
      dialer: { hasDcInflight: () => false, dcCapable: () => true },
      dcUpgrade: {
        dcBreaker: { shouldAcceptAnswer: () => false, inboundBlock: () => 'disabled' },
      },
    });
    host.state.live.set(peer, liveWithCtl(peer, sent));
    const started = Date.now();
    receiveRtcSignal(host, peer, {
      rtcSession: '',
      from: 'node',
      to: host.identity.nodeId,
      sdp: encodeSdpSignal({ type: 'offer', sdp: 'v=0', epoch: 4 }),
      candidate: null,
    });
    receiveRtcSignal(host, peer, {
      rtcSession: '',
      from: 'node',
      to: host.identity.nodeId,
      sdp: null,
      candidate: encodeCandidateSignal('candidate:1 1 UDP 1 10.0.0.8 9 typ host', '0', 4),
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(host.upgrades).toEqual([]);
    expect(host.state.rtcInbox.has(peer)).toBe(false);
    expect(sent).toHaveLength(1);
    const decline = sent[0] as { t: string; sdp: string; to: string; rtcSession: string };
    expect(decline.t).toBe('rtc.signal');
    expect(decline.to).toBe(peer);
    expect(decline.rtcSession).toBe(peerRtcSession(host.identity.nodeId, peer));
    expect(isDcOfferDecline(decline.sdp)).toBe(true);
    expect(readDcOfferDecline(decline.sdp)).toBe('disabled');

    const superseded: number[] = [];
    const state = createSignalingAttemptState(4);
    state.onSuperseded = () => {
      superseded.push(1);
    };
    const pc = {
      setRemoteDescription() {
        throw new Error('decline must not be applied');
      },
    } as unknown as PeerConnectionLike;
    const offererStarted = Date.now();
    expect(applyRemoteSdp(pc, peer, 'answer', state, decline.sdp)).toBe('dropped');
    expect(Date.now() - offererStarted).toBeLessThan(1_000);
    expect(superseded).toEqual([1]);
    let noted = 0;
    noteDialDcFailure({
      stopped: false,
      nodeId: peer,
      err: new Error('superseded'),
      connectP: null,
      attemptId: 'dc:1',
      peerInitiated: false,
      dcBreaker: {
        noteFailure: () => {
          noted += 1;
          return { counted: true, opened: false, open: false };
        },
      },
    });
    expect(noted).toBe(0);
  });

  test('cooling at the cap declines; an answer and an unblocked offer are not declined', () => {
    const peer = 'bb'.repeat(16);
    const sent: unknown[] = [];
    const blocked = fakeHost({
      dcUpgrade: {
        dcBreaker: { shouldAcceptAnswer: () => false, inboundBlock: () => 'cooling' },
      },
    });
    blocked.state.live.set(peer, liveWithCtl(peer, sent));
    receiveRtcSignal(blocked, peer, {
      rtcSession: 'dc:a:b',
      from: 'node',
      to: blocked.identity.nodeId,
      sdp: encodeSdpSignal({ type: 'offer', sdp: 'v=0', epoch: 1 }),
      candidate: null,
    });
    expect(readDcOfferDecline((sent[0] as { sdp: string }).sdp)).toBe('cooling');
    expect(blocked.state.rtcInbox.has(peer)).toBe(false);

    const answerer = fakeHost({
      identity: { nodeId: 'ff'.repeat(16) },
      dcUpgrade: {
        dcBreaker: { shouldAcceptAnswer: () => false, inboundBlock: () => 'disabled' },
      },
    });
    const answerFrom = '11'.repeat(16);
    const answerSent: unknown[] = [];
    answerer.state.live.set(answerFrom, liveWithCtl(answerFrom, answerSent));
    receiveRtcSignal(answerer, answerFrom, {
      rtcSession: 'dc:a:b',
      from: 'node',
      to: answerer.identity.nodeId,
      sdp: encodeSdpSignal({ type: 'answer', sdp: 'v=0', epoch: 1 }),
      candidate: null,
    });
    expect(answerSent).toEqual([]);
    expect(answerer.state.rtcInbox.get(answerFrom)).toHaveLength(1);

    const open = fakeHost({
      dialer: { hasDcInflight: () => false, dcCapable: () => true },
      dcUpgrade: {
        dcBreaker: { shouldAcceptAnswer: () => true, inboundBlock: () => null },
      },
    });
    receiveRtcSignal(open, peer, {
      rtcSession: 'dc:a:b',
      from: 'node',
      to: open.identity.nodeId,
      sdp: encodeSdpSignal({ type: 'offer', sdp: 'v=0', epoch: 2 }),
      candidate: null,
    });
    expect(open.upgrades).toEqual([peer]);
    expect(open.state.rtcInbox.get(peer)).toHaveLength(1);
  });

  test('unbound decline is dropped: no inbox and no peer-initiated dial', () => {
    const peer = 'bb'.repeat(16);
    const host = fakeHost({
      dialer: { hasDcInflight: () => false, dcCapable: () => true },
      dcUpgrade: {
        dcBreaker: { shouldAcceptAnswer: () => true, inboundBlock: () => null },
      },
    });
    host.state.live.set(peer, {
      peerNodeId: peer,
      transport: 'relay',
      quiesceCapable: true,
    } as unknown as LivePeer);
    receiveRtcSignal(host, peer, {
      rtcSession: 'dc:a:b',
      from: 'node',
      to: host.identity.nodeId,
      sdp: encodeDcOfferDecline('disabled'),
      candidate: null,
    });
    expect(host.upgrades).toEqual([]);
    expect(host.state.rtcInbox.has(peer)).toBe(false);
  });

  test('decline during an inflight dial stays in the inbox and does not start another dial', () => {
    const peer = 'bb'.repeat(16);
    const host = fakeHost({
      dialer: { hasDcInflight: () => true, dcCapable: () => true },
      dcUpgrade: {
        dcBreaker: { shouldAcceptAnswer: () => true, inboundBlock: () => null },
      },
    });
    receiveRtcSignal(host, peer, {
      rtcSession: 'dc:a:b',
      from: 'node',
      to: host.identity.nodeId,
      sdp: encodeDcOfferDecline('cooling', { retryAfterMs: 30_000 }),
      candidate: null,
    });
    expect(host.upgrades).toEqual([]);
    expect(host.state.rtcInbox.get(peer)).toHaveLength(1);
  });

  test('decline carries the remote cooldown', () => {
    const peer = 'bb'.repeat(16);
    const sent: unknown[] = [];
    const host = fakeHost({
      dcUpgrade: {
        dcBreaker: {
          shouldAcceptAnswer: () => false,
          inboundBlock: () => 'cooling',
          refusalCooldown: () => ({ until: 9_000, retryAfterMs: 8_000 }),
        },
      },
    });
    host.state.live.set(peer, liveWithCtl(peer, sent));
    receiveRtcSignal(host, peer, {
      rtcSession: 'dc:a:b',
      from: 'node',
      to: host.identity.nodeId,
      sdp: encodeSdpSignal({ type: 'offer', sdp: 'v=0', epoch: 1 }),
      candidate: null,
    });
    const decline = sent[0] as { sdp: string };
    expect(readDcOfferDeclineDetail(decline.sdp)).toEqual({
      reason: 'cooling',
      until: 9_000,
      retryAfterMs: 8_000,
    });
  });
});

function liveWithCtl(peerNodeId: string, sent: unknown[]): LivePeer {
  return {
    peerNodeId,
    session: {
      ctl: {
        send: (bytes: Uint8Array) => {
          sent.push(decodeJsonBytes(bytes));
        },
      },
    },
  } as unknown as LivePeer;
}
