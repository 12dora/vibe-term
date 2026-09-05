import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import type { LinkSession } from '@tmex/shared/link';
import {
  type ForwardPump,
  STREAM_STALE_INPUT_TTL_MS,
  type StreamFailoverHost,
  dropStaleQueuedInput,
  runStreamFailover,
} from './forwarder-failover';
import {
  type OpenedWsStream,
  STREAM_FAILOVER_BACKOFF_MS,
  STREAM_FAILOVER_MAX_ATTEMPTS,
} from './mesh-deps';
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
    queuedAt: [Date.now()],
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
  test('弱网重连退避预算接近 15 秒', () => {
    expect(STREAM_FAILOVER_BACKOFF_MS).toEqual([0, 50, 100, 200, 400, 800, 1600, 3200, 6400]);
    expect(STREAM_FAILOVER_BACKOFF_MS.reduce<number>((sum, delay) => sum + delay, 0)).toBe(12_750);
  });

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

describe('dropStaleQueuedInput', () => {
  const inputFrame = (): Uint8Array =>
    wsBorsh.encodeEnvelope(wsBorsh.KIND_TERM_INPUT, new Uint8Array([1, 2, 3]), 1);
  const structuralFrame = (): Uint8Array =>
    wsBorsh.encodeEnvelope(wsBorsh.KIND_DEVICE_CONNECT, new Uint8Array([7]), 2);

  test('超过 TTL 的输入帧被丢弃，结构帧与新鲜输入保留', () => {
    const now = 100_000;
    const stale = inputFrame();
    const fresh = inputFrame();
    const structural = structuralFrame();
    const pump = {
      queue: [stale, structural, fresh],
      queuedAt: [
        now - STREAM_STALE_INPUT_TTL_MS - 1,
        now - STREAM_STALE_INPUT_TTL_MS - 1,
        now - 10,
      ],
      queueBytes: stale.byteLength + structural.byteLength + fresh.byteLength,
    };

    const result = dropStaleQueuedInput(pump, now);

    expect(result.droppedFrames).toBe(1);
    expect(result.droppedBytes).toBe(stale.byteLength);
    expect(result.oldestAgeMs).toBe(STREAM_STALE_INPUT_TTL_MS + 1);
    expect(pump.queue).toEqual([structural, fresh]);
    expect(pump.queueBytes).toBe(structural.byteLength + fresh.byteLength);
  });

  test('TTL 内不丢帧', () => {
    const now = 100_000;
    const frame = inputFrame();
    const pump = {
      queue: [frame],
      queuedAt: [now - STREAM_STALE_INPUT_TTL_MS],
      queueBytes: frame.byteLength,
    };
    expect(dropStaleQueuedInput(pump, now).droppedFrames).toBe(0);
    expect(pump.queue).toHaveLength(1);
  });

  test('解不出信封的裸帧一律保留', () => {
    const now = 100_000;
    const opaque = new Uint8Array([0, 1, 2, 3]);
    const pump = {
      queue: [opaque],
      queuedAt: [now - 60_000],
      queueBytes: opaque.byteLength,
    };
    expect(dropStaleQueuedInput(pump, now).droppedFrames).toBe(0);
    expect(pump.queue).toEqual([opaque]);
  });
});

describe('runStreamFailover 丢弃过期排队输入', () => {
  test('恢复后不补发过期输入，并打一行日志', async () => {
    const pump = makePump();
    const stale = wsBorsh.encodeEnvelope(wsBorsh.KIND_TERM_INPUT, new Uint8Array([1]), 1);
    pump.queue = [stale];
    pump.queuedAt = [Date.now() - STREAM_STALE_INPUT_TTL_MS - 500];
    pump.queueBytes = stale.byteLength;
    const lines: string[] = [];
    const tracked = trackingHost({ log: (line) => lines.push(line) });

    await runStreamFailover(tracked.host, pump, { code: 1011, reason: 'reset' });

    expect(pump.queue).toHaveLength(0);
    expect(pump.queueBytes).toBe(0);
    const dropLines = lines.filter((line) =>
      line.startsWith('[mesh][stream] dropped stale queued input')
    );
    expect(dropLines).toHaveLength(1);
    expect(dropLines[0]).toMatch(
      new RegExp(
        `^\\[mesh\\]\\[stream\\] dropped stale queued input bytes=${stale.byteLength} age_ms=\\d+$`
      )
    );
    expect(tracked.flushed).toBe(1);
  });
});
