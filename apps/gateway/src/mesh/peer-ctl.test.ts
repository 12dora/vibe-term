import { describe, expect, test } from 'bun:test';
import { type PeerCtlHost, handlePeerCtl, receiveRtcSignal } from './peer-ctl';
import type { PeerManagerState } from './peer-manager-state';
import type { LivePeer } from './peer-reconnect-wake';

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
    dcUpgrade: { dcBreaker: { shouldAcceptAnswer: () => false } },
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
});
