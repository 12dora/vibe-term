import { describe, expect, test } from 'bun:test';

import { GATEWAY_WS_BACKPRESSURE_LIMIT_BYTES, WebSocketSendGuard } from './websocket-send-guard';

function createSocket(statuses: number[], maxFrameBytes?: number) {
  let sendCalls = 0;
  let terminateCalls = 0;
  return {
    socket: {
      data: maxFrameBytes === undefined ? undefined : { borshState: { maxFrameBytes } },
      send() {
        const status = statuses[Math.min(sendCalls, statuses.length - 1)] ?? 1;
        sendCalls += 1;
        return status;
      },
      terminate() {
        terminateCalls += 1;
      },
      getBufferedAmount() {
        return 37;
      },
    },
    sendCalls: () => sendCalls,
    terminateCalls: () => terminateCalls,
  };
}

describe('WebSocketSendGuard', () => {
  test('resumes after a backpressured frame drains without any skipped frame', () => {
    const guard = new WebSocketSendGuard({ timeoutMs: 1000, onTerminate: () => {} });
    const target = createSocket([-1, 4]);

    expect(guard.sendFrames(target.socket as never, [new Uint8Array([1])])).toBe(false);
    expect(target.sendCalls()).toBe(1);
    expect(target.terminateCalls()).toBe(0);

    guard.handleDrain(target.socket as never);

    expect(target.terminateCalls()).toBe(0);
    expect(guard.sendFrames(target.socket as never, [new Uint8Array([2])])).toBe(true);
    expect(target.sendCalls()).toBe(2);
  });

  test('reports backpressured when Bun accepts a frame with status -1', () => {
    const guard = new WebSocketSendGuard({ timeoutMs: 1000, onTerminate: () => {} });
    const target = createSocket([-1, 4]);

    expect(guard.sendFramesStatus(target.socket as never, [new Uint8Array([1])])).toBe(
      'backpressured'
    );
    expect(guard.isBackpressured(target.socket as never)).toBe(true);
    expect(guard.sendFrames(target.socket as never, [new Uint8Array([2])])).toBe(false);

    guard.handleDrain(target.socket as never);
    expect(target.terminateCalls()).toBe(1);
  });

  test('terminates on drain when live frames were skipped during backpressure', () => {
    const guard = new WebSocketSendGuard({ timeoutMs: 1000, onTerminate: () => {} });
    const target = createSocket([-1]);

    expect(guard.sendFrames(target.socket as never, [new Uint8Array([1])])).toBe(false);
    expect(guard.sendFrames(target.socket as never, [new Uint8Array([2])])).toBe(false);
    expect(target.sendCalls()).toBe(1);

    guard.handleDrain(target.socket as never);

    expect(target.terminateCalls()).toBe(1);
    expect(guard.sendFrames(target.socket as never, [new Uint8Array([3])])).toBe(false);
    expect(target.sendCalls()).toBe(1);
  });

  test('marks a partial chunk batch as skipped and isolates it after drain', () => {
    const guard = new WebSocketSendGuard({ timeoutMs: 1000, onTerminate: () => {} });
    const target = createSocket([-1]);

    expect(
      guard.sendFrames(target.socket as never, [
        new Uint8Array([1]),
        new Uint8Array([2]),
        new Uint8Array([3]),
      ])
    ).toBe(false);
    expect(target.sendCalls()).toBe(1);

    guard.handleDrain(target.socket as never);
    expect(target.terminateCalls()).toBe(1);
  });

  test('lets a stateful sender mark an abandoned continuation as a stream gap', () => {
    const guard = new WebSocketSendGuard({ timeoutMs: 1000, onTerminate: () => {} });
    const target = createSocket([-1]);

    expect(guard.sendFrames(target.socket as never, [new Uint8Array([1])])).toBe(false);
    guard.markStreamGap(target.socket as never);
    guard.handleDrain(target.socket as never);

    expect(target.terminateCalls()).toBe(1);
  });

  test('terminates a socket that stays backpressured past the deadline', async () => {
    const guard = new WebSocketSendGuard({ timeoutMs: 10, onTerminate: () => {} });
    const target = createSocket([-1]);

    expect(guard.sendFrames(target.socket as never, [new Uint8Array([1])])).toBe(false);
    await Bun.sleep(30);

    expect(target.terminateCalls()).toBe(1);
  });

  test('terminates immediately when Bun reports a dropped frame', () => {
    const guard = new WebSocketSendGuard({ timeoutMs: 1000, onTerminate: () => {} });
    const target = createSocket([0]);

    expect(guard.sendFrames(target.socket as never, [new Uint8Array([1])])).toBe(false);
    expect(target.terminateCalls()).toBe(1);
  });

  test('rejects every frame that exceeds the negotiated maximum before calling Bun', () => {
    const reasons: string[] = [];
    const guard = new WebSocketSendGuard({
      timeoutMs: 1000,
      onTerminate: (reason) => reasons.push(reason),
    });
    const target = createSocket([1], 4);

    expect(guard.sendFrames(target.socket as never, [new Uint8Array(5)])).toBe(false);
    expect(target.sendCalls()).toBe(0);
    expect(target.terminateCalls()).toBe(1);
    expect(reasons).toEqual(['oversized_frame']);
  });

  test('forget cancels the backpressure deadline for a closed socket', async () => {
    const guard = new WebSocketSendGuard({ timeoutMs: 10, onTerminate: () => {} });
    const target = createSocket([-1]);

    expect(guard.sendFrames(target.socket as never, [new Uint8Array([1])])).toBe(false);
    guard.forget(target.socket as never);
    await Bun.sleep(30);

    expect(target.terminateCalls()).toBe(0);
  });

  test('reports bounded queue gauges and content-free termination reasons', () => {
    const guard = new WebSocketSendGuard({ timeoutMs: 1000, onTerminate: () => {} });
    const target = createSocket([-1]);

    expect(guard.sendFrames(target.socket as never, [new Uint8Array([1])])).toBe(false);

    expect(guard.snapshotStats([target.socket as never])).toMatchObject({
      sessions: 1,
      backpressuredSessions: 1,
      unavailableSessions: 0,
      queuedBytes: 37,
      queuedBytesLimit: GATEWAY_WS_BACKPRESSURE_LIMIT_BYTES,
      perSessionBytesLimit: GATEWAY_WS_BACKPRESSURE_LIMIT_BYTES,
      backpressureTimeoutMs: 1000,
      terminationsByReason: {
        backpressure_gap: 0,
        backpressure_timeout: 0,
        dropped_frame: 0,
        oversized_frame: 0,
      },
    });
    guard.forget(target.socket as never);
  });
});
