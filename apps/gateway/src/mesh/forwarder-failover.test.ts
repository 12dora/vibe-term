import { describe, expect, test } from 'bun:test';
import type { LinkSession } from '@tmex/shared/link';
import { type ForwardPump, type StreamFailoverHost, runStreamFailover } from './forwarder-failover';
import type { OpenedWsStream } from './mesh-deps';
import { StreamReplayState } from './stream-replay-state';

function fakeStream(): OpenedWsStream {
  return {
    send: async () => {},
    onMessage() {},
    onClose() {},
    close() {},
    muxStreamId: 1,
  };
}

function makePump(): ForwardPump {
  return {
    id: 'pump-1',
    nodeId: 'node-1',
    auth: 'sid',
    cid: 'tab-a',
    stream: fakeStream(),
    boundTransport: 'dc',
    replay: new StreamReplayState(),
    browserClosed: false,
    failingOver: false,
    failoverAbort: null,
    queue: [new Uint8Array([1, 2, 3])],
    helloWait: null,
    resumeWait: null,
    streamAlive: true,
    inflight: null,
    queueBytes: 3,
  };
}

describe('runStreamFailover logging isolation', () => {
  test('throwing streamLog does not stick failingOver or skip flush', async () => {
    const pump = makePump();
    const flushed: number[] = [];
    const closed: Array<{ code?: number; reason?: string }> = [];
    const stream = fakeStream();
    const host: StreamFailoverHost = {
      sleep: async () => {},
      log() {
        throw new Error('log boom');
      },
      peers: {
        getLink: async () => ({ id: 'link' }) as unknown as LinkSession,
        listReach: () => new Map(),
        onNodeEvent: () => () => {},
        transportOf: () => 'relay',
      },
      streams: {
        openHttpStream: async () => new Response(null, { status: 404 }),
        openWsStream: async () => stream,
      },
      bindStream(target, opened, transport) {
        target.stream = opened;
        target.streamAlive = true;
        target.boundTransport = transport;
      },
      discardStream() {},
      closeBrowser(_target, info) {
        closed.push(info);
      },
      sendToStream() {},
      sendToBrowser() {},
      flushQueue() {
        flushed.push(1);
      },
    };

    await runStreamFailover(host, pump, { code: 1011, reason: 'reset' });
    expect(pump.failingOver).toBe(false);
    expect(flushed).toEqual([1]);
    expect(closed).toEqual([]);
  });
});
