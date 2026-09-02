import { describe, expect, test } from 'bun:test';
import type { CarrierSendResult } from './carrier';
import { createFakeCarrier } from './test-helpers';
import { GATEWAY_WS_BACKPRESSURE_LIMIT_BYTES, WebSocketSendGuard } from './websocket-send-guard';

function createCarrier(statuses: Array<CarrierSendResult | 'throw'>, bufferedAmount = 37) {
  let sendCalls = 0;
  let terminateCalls = 0;
  const carrier = createFakeCarrier({
    bufferedAmount,
    send() {
      const status = statuses[Math.min(sendCalls, statuses.length - 1)] ?? 'sent';
      sendCalls += 1;
      if (status === 'throw') {
        throw new Error('send failed');
      }
      return status;
    },
    terminate() {
      terminateCalls += 1;
    },
  });
  return {
    carrier,
    sendCalls: () => sendCalls,
    terminateCalls: () => terminateCalls,
  };
}

describe('WebSocketSendGuard', () => {
  test('resumes after a backpressured frame drains without any skipped frame', () => {
    const guard = new WebSocketSendGuard({ timeoutMs: 1000, onTerminate: () => {} });
    const target = createCarrier(['backpressure', 'sent']);

    expect(guard.sendFrames(target.carrier, [new Uint8Array([1])])).toBe(false);
    expect(target.sendCalls()).toBe(1);
    expect(target.terminateCalls()).toBe(0);

    guard.handleDrain(target.carrier);

    expect(target.terminateCalls()).toBe(0);
    expect(guard.sendFrames(target.carrier, [new Uint8Array([2])])).toBe(true);
    expect(target.sendCalls()).toBe(2);
  });

  test('reports backpressured when the carrier accepts a frame with backpressure', () => {
    const guard = new WebSocketSendGuard({ timeoutMs: 1000, onTerminate: () => {} });
    const target = createCarrier(['backpressure', 'sent']);

    expect(guard.sendFramesStatus(target.carrier, [new Uint8Array([1])])).toBe('backpressured');
    expect(guard.isBackpressured(target.carrier)).toBe(true);
    expect(guard.sendFrames(target.carrier, [new Uint8Array([2])])).toBe(false);

    guard.handleDrain(target.carrier);
    expect(target.terminateCalls()).toBe(1);
  });

  test('terminates on drain when live frames were skipped during backpressure', () => {
    const guard = new WebSocketSendGuard({ timeoutMs: 1000, onTerminate: () => {} });
    const target = createCarrier(['backpressure']);

    expect(guard.sendFrames(target.carrier, [new Uint8Array([1])])).toBe(false);
    expect(guard.sendFrames(target.carrier, [new Uint8Array([2])])).toBe(false);
    expect(target.sendCalls()).toBe(1);

    guard.handleDrain(target.carrier);

    expect(target.terminateCalls()).toBe(1);
    expect(guard.sendFrames(target.carrier, [new Uint8Array([3])])).toBe(false);
    expect(target.sendCalls()).toBe(1);
  });

  test('marks a partial chunk batch as skipped and isolates it after drain', () => {
    const guard = new WebSocketSendGuard({ timeoutMs: 1000, onTerminate: () => {} });
    const target = createCarrier(['backpressure']);

    expect(
      guard.sendFrames(target.carrier, [
        new Uint8Array([1]),
        new Uint8Array([2]),
        new Uint8Array([3]),
      ])
    ).toBe(false);
    expect(target.sendCalls()).toBe(1);

    guard.handleDrain(target.carrier);
    expect(target.terminateCalls()).toBe(1);
  });

  test('lets a stateful sender mark an abandoned continuation as a stream gap', () => {
    const guard = new WebSocketSendGuard({ timeoutMs: 1000, onTerminate: () => {} });
    const target = createCarrier(['backpressure']);

    expect(guard.sendFrames(target.carrier, [new Uint8Array([1])])).toBe(false);
    guard.markStreamGap(target.carrier);
    guard.handleDrain(target.carrier);

    expect(target.terminateCalls()).toBe(1);
  });

  test('terminates a carrier that stays backpressured past the deadline', async () => {
    const guard = new WebSocketSendGuard({ timeoutMs: 10, onTerminate: () => {} });
    const target = createCarrier(['backpressure']);

    expect(guard.sendFrames(target.carrier, [new Uint8Array([1])])).toBe(false);
    await Bun.sleep(30);

    expect(target.terminateCalls()).toBe(1);
  });

  test('terminates immediately when the carrier reports a closed send', () => {
    const guard = new WebSocketSendGuard({ timeoutMs: 1000, onTerminate: () => {} });
    const target = createCarrier(['closed']);

    expect(guard.sendFrames(target.carrier, [new Uint8Array([1])])).toBe(false);
    expect(target.terminateCalls()).toBe(1);
  });

  test('rejects every frame that exceeds the negotiated maximum before sending', () => {
    const reasons: string[] = [];
    const guard = new WebSocketSendGuard({
      timeoutMs: 1000,
      onTerminate: (reason) => reasons.push(reason),
    });
    const target = createCarrier(['sent']);

    expect(guard.sendFrames(target.carrier, [new Uint8Array(5)], 4)).toBe(false);
    expect(target.sendCalls()).toBe(0);
    expect(target.terminateCalls()).toBe(1);
    expect(reasons).toEqual(['oversized_frame']);
  });

  test('forget cancels the backpressure deadline for a closed carrier', async () => {
    const guard = new WebSocketSendGuard({ timeoutMs: 10, onTerminate: () => {} });
    const target = createCarrier(['backpressure']);

    expect(guard.sendFrames(target.carrier, [new Uint8Array([1])])).toBe(false);
    guard.forget(target.carrier);
    await Bun.sleep(30);

    expect(target.terminateCalls()).toBe(0);
  });

  test('reports bounded queue gauges and content-free termination reasons', () => {
    const guard = new WebSocketSendGuard({ timeoutMs: 1000, onTerminate: () => {} });
    const target = createCarrier(['backpressure']);

    expect(guard.sendFrames(target.carrier, [new Uint8Array([1])])).toBe(false);

    expect(guard.snapshotStats([target.carrier])).toMatchObject({
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
    guard.forget(target.carrier);
  });

  test('keys backpressure independently per carrier on one session', () => {
    const guard = new WebSocketSendGuard({ timeoutMs: 1000, onTerminate: () => {} });
    const primary = createCarrier(['backpressure', 'sent']);
    const direct = createCarrier(['sent']);

    expect(guard.sendFramesStatus(primary.carrier, [new Uint8Array([1])])).toBe('backpressured');
    expect(guard.isBackpressured(primary.carrier)).toBe(true);
    expect(guard.isBackpressured(direct.carrier)).toBe(false);
    expect(guard.sendFrames(direct.carrier, [new Uint8Array([2])])).toBe(true);
    expect(direct.sendCalls()).toBe(1);
    expect(primary.sendCalls()).toBe(1);

    guard.handleDrain(direct.carrier);
    expect(direct.terminateCalls()).toBe(0);
    expect(guard.isBackpressured(primary.carrier)).toBe(true);

    guard.handleDrain(primary.carrier);
    expect(primary.terminateCalls()).toBe(0);
    expect(guard.sendFrames(primary.carrier, [new Uint8Array([3])])).toBe(true);
  });

  test('logs backpressure entry, skip, drain, and terminate with carrier kind', () => {
    const lines: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      const guard = new WebSocketSendGuard({ timeoutMs: 1000, onTerminate: () => {} });
      const target = createCarrier(['backpressure']);
      target.carrier.logContext = {
        kind: 'mesh_link_stream',
        sessionId: 'sess-1',
        cid: 'tab-a',
        nodeId: 'node-1',
      };
      expect(guard.sendFrames(target.carrier, [new Uint8Array([1, 2])])).toBe(false);
      expect(guard.sendFrames(target.carrier, [new Uint8Array([3, 4, 5])])).toBe(false);
      guard.handleDrain(target.carrier);
    } finally {
      console.warn = orig;
    }
    const entry = lines.find((line) => line.includes('backpressure enter'));
    const skip = lines.find((line) => line.includes('backpressure skip'));
    const drain = lines.find((line) => line.includes('backpressure drain'));
    const term = lines.find((line) => line.includes('terminate'));
    expect(entry).toBeTruthy();
    expect(skip).toBeTruthy();
    expect(drain).toBeTruthy();
    expect(term).toBeTruthy();
    for (const line of [entry, skip, drain, term]) {
      expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /);
      expect(line).toContain('carrier=mesh_link_stream');
      expect(line).toContain('session=sess-1');
      expect(line).toContain('cid=tab-a');
      expect(line).toContain('node=node-1');
    }
    expect(entry).toContain('buffered_before=37');
    expect(skip).toContain('skipped_frames=1');
    expect(skip).toContain('skipped_bytes=3');
    expect(term).toContain('reason=backpressure_gap');
  });
});
