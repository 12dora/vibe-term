import { describe, expect, test } from 'bun:test';
import type { LinkSession } from '@tmex/shared/link';
import { type ForwardPump, type StreamFailoverHost, runStreamFailover } from './forwarder-failover';
import { type OpenedWsStream, STREAM_FAILOVER_MAX_ATTEMPTS } from './mesh-deps';
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

type TrackedStream = OpenedWsStream & { closedWith: { code?: number; reason?: string } | null };

function trackedStream(): TrackedStream {
  const stream: TrackedStream = {
    send: async () => {},
    onMessage() {},
    onClose() {},
    close(code?: number, reason?: string) {
      stream.closedWith ??= { code, reason };
    },
    muxStreamId: 1,
    closedWith: null,
  };
  return stream;
}

/** 与 Forwarder 同语义的 host：bindStream / discardStream / closePump 都照搬真实实现的副作用。 */
function trackingHost(overrides: Partial<StreamFailoverHost> = {}): {
  host: StreamFailoverHost;
  opened: TrackedStream[];
  closed: Array<{ code?: number; reason?: string }>;
  flushed: number;
} {
  const opened: TrackedStream[] = [];
  const closed: Array<{ code?: number; reason?: string }> = [];
  const state = { flushed: 0 };
  const host: StreamFailoverHost = {
    sleep: async () => {},
    log() {},
    peers: {
      getLink: async () => ({ id: 'link' }) as unknown as LinkSession,
      listReach: () => new Map(),
      onNodeEvent: () => () => {},
      transportOf: () => 'relay',
    },
    streams: {
      openHttpStream: async () => new Response(null, { status: 404 }),
      openWsStream: async () => {
        const stream = trackedStream();
        opened.push(stream);
        return stream;
      },
    },
    bindStream(pump, stream, transport) {
      pump.stream = stream;
      pump.streamAlive = true;
      pump.boundTransport = transport;
    },
    discardStream(pump, stream) {
      if (pump.inflight === stream) pump.inflight = null;
      if (pump.stream === stream) {
        pump.stream = null;
        pump.streamAlive = false;
      }
      stream.close();
    },
    closePump(pump, info) {
      if (pump.browserClosed) return;
      pump.browserClosed = true;
      const inflight = pump.inflight;
      pump.inflight = null;
      inflight?.close(info.code, info.reason);
      pump.stream?.close(info.code, info.reason);
      pump.stream = null;
      pump.streamAlive = false;
      closed.push(info);
    },
    sendToStream() {},
    sendToBrowser() {},
    flushQueue() {
      state.flushed += 1;
    },
    ...overrides,
  };
  return {
    host,
    opened,
    closed,
    get flushed() {
      return state.flushed;
    },
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
    const browserFrames: Uint8Array[] = [];
    const closed: Array<{ code?: number; reason?: string }> = [];
    const stream = fakeStream();
    const signal = new Uint8Array([9]);
    pump.replay.browserSignalFrames = () => (flushed.length > 0 ? [signal] : []);
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
      closePump(target, info) {
        target.stream?.close(info.code, info.reason);
        target.stream = null;
        closed.push(info);
      },
      sendToStream() {},
      sendToBrowser(_target, frame) {
        browserFrames.push(frame);
      },
      flushQueue() {
        flushed.push(1);
      },
    };

    await runStreamFailover(host, pump, { code: 1011, reason: 'reset' });
    expect(pump.failingOver).toBe(false);
    expect(flushed).toEqual([1]);
    expect(browserFrames).toEqual([signal]);
    expect(closed).toEqual([]);
  });
});

describe('runStreamFailover 终止路径不留上游流', () => {
  test('重试用尽：每一轮开出来的流都被关掉，浏览器也一起断', async () => {
    const pump = makePump();
    pump.stream = null;
    pump.streamAlive = false;
    const fixture = trackingHost({
      // 新流刚绑上就被对端断掉：completeFailover 只能放弃这一轮
      bindStream(target, stream, transport) {
        target.stream = stream;
        target.streamAlive = false;
        target.boundTransport = transport;
      },
    });

    await runStreamFailover(fixture.host, pump, { code: 1011, reason: 'reset' });

    expect(fixture.opened).toHaveLength(STREAM_FAILOVER_MAX_ATTEMPTS);
    expect(fixture.opened.every((stream) => stream.closedWith !== null)).toBe(true);
    expect(fixture.closed).toEqual([{ code: 1011, reason: 'failover-exhausted' }]);
    expect(pump.stream).toBeNull();
    expect(pump.inflight).toBeNull();
    expect(pump.browserClosed).toBe(true);
    expect(fixture.flushed).toBe(0);
  });

  test('绑定阶段抛错：在途流不会留下', async () => {
    const pump = makePump();
    pump.stream = null;
    pump.streamAlive = false;
    const fixture = trackingHost({
      bindStream() {
        throw new Error('bind boom');
      },
    });

    await runStreamFailover(fixture.host, pump, { code: 1011, reason: 'reset' });

    expect(fixture.opened).toHaveLength(1);
    expect(fixture.opened[0]?.closedWith).toEqual({ code: 1011, reason: 'failover-error' });
    expect(fixture.closed).toEqual([{ code: 1011, reason: 'failover-error' }]);
    expect(pump.inflight).toBeNull();
    expect(pump.browserClosed).toBe(true);
  });
});
