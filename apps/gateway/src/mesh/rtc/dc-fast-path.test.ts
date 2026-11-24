import { afterEach, describe, expect, test } from 'bun:test';
import { noteFastPathDesync, resetFastPathDesyncForTest } from './data-channel-fast-path';
import { DataChannelLink } from './data-channel-link';
import { PeerRtChannels, dcFastPathEnabled } from './dc-fast-path';
import type { DataChannelLike } from './native';
import { FakeDataChannel, FakePeerConnection, pairDataChannels } from './test-fakes';

function owner() {
  const attached: DataChannelLike[] = [];
  return { attached, attachFastChannel: (dc: DataChannelLike) => attached.push(dc) };
}

function deliver(pc: FakePeerConnection, label: string): FakeDataChannel {
  const dc = new FakeDataChannel(label);
  pc.inbound.push(dc);
  return dc;
}

describe('dc fast path helpers', () => {
  const prev = process.env.VIBETERM_DC_FAST_PATH;
  afterEach(() => {
    resetFastPathDesyncForTest();
    if (prev === undefined) delete process.env.VIBETERM_DC_FAST_PATH;
    else process.env.VIBETERM_DC_FAST_PATH = prev;
  });

  test('VIBETERM_DC_FAST_PATH accepts 0/off/false/no as off', () => {
    for (const raw of ['0', 'off', 'FALSE', ' no ']) {
      process.env.VIBETERM_DC_FAST_PATH = raw;
      expect(dcFastPathEnabled()).toBe(false);
    }
    process.env.VIBETERM_DC_FAST_PATH = '1';
    expect(dcFastPathEnabled()).toBe(true);
    delete process.env.VIBETERM_DC_FAST_PATH;
    expect(dcFastPathEnabled()).toBe(true);
  });

  test('answerer routes by label: peer ignored, unknown closed, peer-rt held until bind', () => {
    const pc = new FakePeerConnection('answerer', { iceServers: [] });
    const peer = deliver(pc, 'peer');
    const rt = deliver(pc, 'peer-rt');
    const other = deliver(pc, 'bulk:x');
    const channels = new PeerRtChannels(pc, 'peer-b');
    channels.routeInbound();
    expect(peer.closed).toBe(false);
    expect(other.closed).toBe(true);
    expect(rt.closed).toBe(false);
    const link = owner();
    channels.bind(link, false, true);
    expect(link.attached).toEqual([rt]);
    pc.close();
  });

  test('dispose closes a held peer-rt when the handshake fails', () => {
    const pc = new FakePeerConnection('answerer', { iceServers: [] });
    const rt = deliver(pc, 'peer-rt');
    const channels = new PeerRtChannels(pc, 'peer-b');
    channels.routeInbound();
    channels.dispose();
    expect(rt.closed).toBe(true);
  });

  test('disabled answerer does not take over onDataChannel', () => {
    process.env.VIBETERM_DC_FAST_PATH = '0';
    const pc = new FakePeerConnection('answerer', { iceServers: [] });
    const other = deliver(pc, 'bulk:x');
    const channels = new PeerRtChannels(pc, 'peer-b');
    channels.routeInbound();
    expect(other.closed).toBe(false);
  });

  test('offerer opens peer-rt only when negotiated', () => {
    const pc = new FakePeerConnection('offerer', { iceServers: [] });
    const channels = new PeerRtChannels(pc, 'peer-b');
    const link = owner();
    channels.bind(link, true, false);
    expect(pc.created.map((dc) => dc.label)).toEqual([]);
    channels.bind(link, true, true);
    expect(pc.created.map((dc) => dc.label)).toEqual(['peer-rt']);
    expect(link.attached.length).toBe(1);
    pc.close();
  });

  test('a peer that hit fast-path-desync is not offered peer-rt during the cooldown', () => {
    const pc = new FakePeerConnection('offerer', { iceServers: [] });
    expect(new PeerRtChannels(pc, 'peer-c').enabled).toBe(true);
    noteFastPathDesync('PEER-C');
    expect(new PeerRtChannels(pc, 'peer-c').enabled).toBe(false);
    expect(new PeerRtChannels(pc, 'peer-d').enabled).toBe(true);
    resetFastPathDesyncForTest();
    expect(new PeerRtChannels(pc, 'peer-c').enabled).toBe(true);
  });

  test('answerer: copies that arrive before the Link is bound are delivered after bind', async () => {
    const [a, b] = pairDataChannels('peer');
    const [fa, fb] = pairDataChannels('peer-rt');
    const left = new DataChannelLink(a, { liveness: false, fastPath: true, fastCopyDelayMs: 0 });
    left.attachFastChannel(fa);
    a.dropSend = true;
    await left.send(new Uint8Array([1]));
    expect(fa.sent).toHaveLength(1);

    const pc = new FakePeerConnection('answerer', { iceServers: [] });
    pc.inbound.push(fb);
    const channels = new PeerRtChannels(pc, 'peer-a');
    channels.routeInbound();
    const right = new DataChannelLink(b, { liveness: false, fastPath: true });
    const got: Uint8Array[] = [];
    right.onData((frame) => got.push(frame));
    expect(got).toEqual([]);
    channels.bind(right, false, true);
    expect(got).toEqual([new Uint8Array([1])]);
    expect(right.stats()).toMatchObject({ deliveredEarly: 1 });

    b.emitMessage(Buffer.from(a.sent[0] as Uint8Array));
    expect(got).toHaveLength(1);
    expect(right.stats()).toMatchObject({ droppedDup: 1, desync: 0 });
    left.close();
    right.close();
  });
});
