import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import type { CarrierSendResult } from './carrier';
import { createFakeCarrier } from './test-helpers';
import {
  GATEWAY_WS_BACKPRESSURE_HARD_LIMIT_BYTES,
  GATEWAY_WS_BACKPRESSURE_LIMIT_BYTES,
  WebSocketSendGuard,
} from './websocket-send-guard';

function createCarrier(statuses: Array<CarrierSendResult | 'throw'>, bufferedAmount = 37) {
  let sendCalls = 0;
  let terminateCalls = 0;
  const sent: Uint8Array[] = [];
  const carrier = createFakeCarrier({
    bufferedAmount,
    send(bytes) {
      const status = statuses[Math.min(sendCalls, statuses.length - 1)] ?? 'sent';
      sendCalls += 1;
      if (status === 'throw') {
        throw new Error('send failed');
      }
      sent.push(bytes.slice());
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
    sent,
  };
}

function isStreamPaneGap(frame: Uint8Array): boolean {
  try {
    const env = wsBorsh.decodeEnvelopeView(frame);
    if (env.kind !== wsBorsh.KIND_CANONICAL_EVENT) return false;
    const event = wsBorsh.decodeCanonicalEventPayload(env.payload).event;
    return (
      'SourceGap' in event &&
      'Stream' in event.SourceGap.scope &&
      event.SourceGap.reason === wsBorsh.SOURCE_GAP_REASON_PANE_GAP
    );
  } catch {
    return false;
  }
}

function paneDataFrame(seq: number, data = new Uint8Array([seq & 0xff])): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    wsBorsh.encodeCanonicalEventFrame(
      {
        PaneData: {
          pane: {
            deviceId: 'device-a',
            serverEpoch: new Uint8Array(16).fill(1),
            paneId: '%1',
          },
          paneEpoch: new Uint8Array(16).fill(2),
          seqStart: 0n,
          seqEnd: BigInt(data.byteLength),
          data,
        },
      },
      seq
    )
  );
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
    expect(guard.sendFrames(target.carrier, [paneDataFrame(2)])).toBe(false);

    guard.handleDrain(target.carrier);
    expect(target.terminateCalls()).toBe(0);
    expect(target.sent.filter(isStreamPaneGap)).toHaveLength(1);
    expect(guard.sendFrames(target.carrier, [new Uint8Array([3])])).toBe(true);
  });

  test('sends one SourceGap on drain after skipped frames and keeps the socket open', () => {
    const guard = new WebSocketSendGuard({ timeoutMs: 1000, onTerminate: () => {} });
    const target = createCarrier(['backpressure', 'sent']);

    expect(guard.sendFrames(target.carrier, [new Uint8Array([1])])).toBe(false);
    expect(guard.sendFrames(target.carrier, [paneDataFrame(2)])).toBe(false);
    expect(target.sendCalls()).toBe(1);

    guard.handleDrain(target.carrier);

    expect(target.terminateCalls()).toBe(0);
    expect(guard.isBackpressured(target.carrier)).toBe(false);
    expect(target.sent.filter(isStreamPaneGap)).toHaveLength(1);
    expect(guard.sendFrames(target.carrier, [new Uint8Array([3])])).toBe(true);
    expect(target.sendCalls()).toBe(3);
  });

  test('repeated skips in one backpressure window emit a single SourceGap', () => {
    const guard = new WebSocketSendGuard({ timeoutMs: 1000, onTerminate: () => {} });
    const target = createCarrier(['backpressure', 'sent', 'sent', 'backpressure', 'sent']);

    expect(guard.sendFrames(target.carrier, [new Uint8Array([1])])).toBe(false);
    for (let i = 0; i < 12; i += 1) {
      expect(guard.sendFrames(target.carrier, [paneDataFrame(i + 2)])).toBe(false);
    }
    expect(target.sendCalls()).toBe(1);

    guard.handleDrain(target.carrier);
    expect(target.terminateCalls()).toBe(0);
    expect(target.sent.filter(isStreamPaneGap)).toHaveLength(1);

    expect(guard.sendFrames(target.carrier, [new Uint8Array([99])])).toBe(true);
    expect(guard.sendFrames(target.carrier, [new Uint8Array([100])])).toBe(false);
    expect(guard.sendFrames(target.carrier, [paneDataFrame(101)])).toBe(false);
    guard.handleDrain(target.carrier);
    expect(target.sent.filter(isStreamPaneGap)).toHaveLength(2);
    expect(target.terminateCalls()).toBe(0);
  });

  test('marks a partial chunk batch as skipped and resyncs after drain', () => {
    const guard = new WebSocketSendGuard({ timeoutMs: 1000, onTerminate: () => {} });
    const target = createCarrier(['backpressure', 'sent']);

    expect(
      guard.sendFrames(target.carrier, [new Uint8Array([1]), paneDataFrame(2), paneDataFrame(3)])
    ).toBe(false);
    expect(target.sendCalls()).toBe(1);

    guard.handleDrain(target.carrier);
    expect(target.terminateCalls()).toBe(0);
    expect(target.sent.filter(isStreamPaneGap)).toHaveLength(1);
    expect(guard.sendFrames(target.carrier, [new Uint8Array([4])])).toBe(true);
  });

  test('terminates after a stateful continuation is abandoned under backpressure', () => {
    const reasons: string[] = [];
    const guard = new WebSocketSendGuard({
      timeoutMs: 1000,
      onTerminate: (reason) => reasons.push(reason),
    });
    const target = createCarrier(['backpressure', 'sent']);

    expect(guard.sendFrames(target.carrier, [new Uint8Array([1])])).toBe(false);
    guard.markStreamGap(target.carrier);
    guard.handleDrain(target.carrier);

    expect(target.terminateCalls()).toBe(1);
    expect(target.sent.filter(isStreamPaneGap)).toHaveLength(0);
    expect(reasons).toEqual(['backpressure_gap']);
  });

  test('terminates when any skipped frame is not screen-reconstructible terminal data', () => {
    const reasons: string[] = [];
    const guard = new WebSocketSendGuard({
      timeoutMs: 1000,
      onTerminate: (reason) => reasons.push(reason),
    });
    const target = createCarrier(['backpressure', 'sent']);
    const control = new Uint8Array(wsBorsh.encodeEnvelope(wsBorsh.KIND_PONG, new Uint8Array(), 2));

    expect(guard.sendFrames(target.carrier, [new Uint8Array([1])])).toBe(false);
    expect(guard.sendFrames(target.carrier, [paneDataFrame(1), control])).toBe(false);
    guard.handleDrain(target.carrier);

    expect(target.terminateCalls()).toBe(1);
    expect(target.sent.filter(isStreamPaneGap)).toHaveLength(0);
    expect(reasons).toEqual(['backpressure_gap']);
  });

  test('terminates when the drain resync frame is rejected', () => {
    const reasons: string[] = [];
    const guard = new WebSocketSendGuard({
      timeoutMs: 1000,
      onTerminate: (reason) => reasons.push(reason),
    });
    const target = createCarrier(['backpressure', 'rejected']);

    expect(guard.sendFrames(target.carrier, [new Uint8Array([1])])).toBe(false);
    expect(guard.sendFrames(target.carrier, [paneDataFrame(2)])).toBe(false);
    guard.handleDrain(target.carrier);

    expect(target.terminateCalls()).toBe(1);
    expect(reasons).toEqual(['backpressure_gap']);
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

  test('N skipped sends while backpressured produce at most two log lines', () => {
    const lines: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      const guard = new WebSocketSendGuard({ timeoutMs: 1000, onTerminate: () => {} });
      const target = createCarrier(['backpressure']);
      expect(guard.sendFrames(target.carrier, [new Uint8Array([1])])).toBe(false);
      for (let i = 0; i < 40; i += 1) {
        expect(guard.sendFrames(target.carrier, [new Uint8Array([i + 2])])).toBe(false);
      }
    } finally {
      console.warn = orig;
    }
    expect(lines.length).toBeLessThanOrEqual(2);
    expect(lines.filter((line) => line.includes('backpressure enter'))).toHaveLength(1);
    expect(lines.filter((line) => line.includes('backpressure skip')).length).toBeLessThanOrEqual(
      1
    );
  });

  test('decodes frame kind from a real encodeEnvelope TX little-endian frame', () => {
    const lines: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      const guard = new WebSocketSendGuard({ timeoutMs: 1000, onTerminate: () => {} });
      const target = createCarrier(['backpressure']);
      const frame = wsBorsh.encodeEnvelope(
        wsBorsh.KIND_TMUX_EVENT,
        wsBorsh.encodeTmuxEventPayload({ deviceId: 'd', type: 'bell', data: {} }),
        1
      );
      expect(guard.sendFrames(target.carrier, [new Uint8Array(frame)])).toBe(false);
    } finally {
      console.warn = orig;
    }
    const entry = lines.find((line) => line.includes('backpressure enter'));
    expect(entry).toContain(`frame_kind=${wsBorsh.KIND_TMUX_EVENT.toString(16).padStart(4, '0')}`);
  });

  test('logs backpressure entry, skip, drain, and resync with carrier kind', () => {
    const lines: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      const guard = new WebSocketSendGuard({ timeoutMs: 1000, onTerminate: () => {} });
      const target = createCarrier(['backpressure', 'sent']);
      target.carrier.logContext = {
        kind: 'mesh_link_stream',
        sessionId: 'sess-1',
        cid: 'tab-a',
        nodeId: 'node-1',
      };
      const skipped = paneDataFrame(2, new Uint8Array([3, 4, 5]));
      expect(guard.sendFrames(target.carrier, [new Uint8Array([1, 2])])).toBe(false);
      expect(guard.sendFrames(target.carrier, [skipped])).toBe(false);
      guard.handleDrain(target.carrier);
    } finally {
      console.warn = orig;
    }
    const entry = lines.find((line) => line.includes('backpressure enter'));
    const skip = lines.find((line) => line.includes('backpressure skip'));
    const drain = lines.find((line) => line.includes('backpressure drain'));
    const term = lines.find((line) => line.includes('terminate'));
    expect(entry).toBeTruthy();
    expect(skip).toBeFalsy();
    expect(drain).toBeTruthy();
    expect(term).toBeFalsy();
    for (const line of [entry, drain]) {
      expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /);
      expect(line).toContain('carrier=mesh_link_stream');
      expect(line).toContain('session=sess-1');
      expect(line).toContain('cid=tab-a');
      expect(line).toContain('node=node-1');
    }
    expect(entry).toContain('buffered_before=37');
    expect(drain).toContain('skipped_frames=1');
    expect(drain).toContain(
      `skipped_bytes=${paneDataFrame(2, new Uint8Array([3, 4, 5])).byteLength}`
    );
    expect(drain).toContain('resync=1');
  });

  test('priority frames send during backpressure without marking a stream gap', () => {
    const guard = new WebSocketSendGuard({ timeoutMs: 1000, onTerminate: () => {} });
    const target = createCarrier(['backpressure', 'sent']);

    expect(guard.sendFramesStatus(target.carrier, [new Uint8Array([1])])).toBe('backpressured');
    expect(guard.isBackpressured(target.carrier)).toBe(true);
    expect(guard.sendPriorityFrames(target.carrier, [new Uint8Array([9])])).toBe('sent');
    expect(target.sendCalls()).toBe(2);

    guard.handleDrain(target.carrier);
    expect(target.terminateCalls()).toBe(0);
    expect(guard.sendFrames(target.carrier, [new Uint8Array([2])])).toBe(true);
  });

  test('priority frames report backpressured when the carrier rejects the frame', () => {
    const guard = new WebSocketSendGuard({ timeoutMs: 1000, onTerminate: () => {} });
    const target = createCarrier(['rejected']);

    expect(guard.sendPriorityFrames(target.carrier, [new Uint8Array([9])])).toBe('backpressured');
    expect(target.sendCalls()).toBe(1);
    expect(target.terminateCalls()).toBe(0);
    expect(guard.isBackpressured(target.carrier)).toBe(false);
  });

  test('priority frames still refuse an unavailable carrier', () => {
    const guard = new WebSocketSendGuard({ timeoutMs: 1000, onTerminate: () => {} });
    const target = createCarrier(['closed']);
    expect(guard.sendFrames(target.carrier, [new Uint8Array([1])])).toBe(false);
    expect(target.terminateCalls()).toBe(1);
    expect(guard.sendPriorityFrames(target.carrier, [new Uint8Array([9])])).toBe('dropped');
    expect(target.sendCalls()).toBe(1);
  });

  test('hard backpressure limit still terminates the carrier', () => {
    const reasons: string[] = [];
    const guard = new WebSocketSendGuard({
      timeoutMs: 1000,
      onTerminate: (reason) => reasons.push(reason),
    });
    const target = createCarrier(['sent'], GATEWAY_WS_BACKPRESSURE_HARD_LIMIT_BYTES);
    expect(guard.sendFrames(target.carrier, [new Uint8Array([1])])).toBe(false);
    expect(target.sendCalls()).toBe(0);
    expect(target.terminateCalls()).toBe(1);
    expect(reasons).toEqual(['backpressure_gap']);
    expect(guard.sendPriorityFrames(target.carrier, [new Uint8Array([9])])).toBe('dropped');
  });
});
