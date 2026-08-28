import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import type { ServerWebSocket } from 'bun';
import { decodeGatewayTransportMessage } from '../../../../../packages/ws-client/src/transport-message-decoder';
import type { GatewayTransportEvent } from '../../../../../packages/ws-client/src/transport-types';
import { createBorshTestWs } from '../test-helpers';
import { SessionStateStore } from './session-state';

function decodeSentSourceGap(frame: Uint8Array | undefined) {
  expect(frame).toBeInstanceOf(Uint8Array);
  if (!(frame instanceof Uint8Array)) {
    throw new Error('expected SourceGap frame');
  }
  const envelope = wsBorsh.decodeEnvelope(frame);
  expect(envelope.kind).toBe(wsBorsh.KIND_CANONICAL_EVENT);
  const events: GatewayTransportEvent[] = [];
  const handled = decodeGatewayTransportMessage(envelope.kind, envelope.payload, (event) => {
    events.push(event);
  });
  expect(handled).toBe(true);
  expect(events).toEqual([{ type: 'rebase-required', reason: 'resource_exhausted' }]);
  return wsBorsh.decodeCanonicalEventPayload(envelope.payload).event;
}

describe('SessionStateStore output gate byte cap', () => {
  test('buffers frames under the byte cap and returns them unchanged', () => {
    const store = new SessionStateStore({ maxOutputBufferBytes: 16 });
    const ws = createBorshTestWs();
    store.create(ws);

    store.startOutputBuffering(ws, 'device-1');
    const first = new Uint8Array([1, 2, 3]);
    const second = new Uint8Array([4, 5, 6]);
    expect(store.bufferOutput(ws, 'device-1', first)).toBe(true);
    expect(store.bufferOutput(ws, 'device-1', second)).toBe(true);

    const buffered = store.stopOutputBuffering(ws, 'device-1');
    expect(buffered).toEqual([first, second]);
    expect(store.isBuffering(ws, 'device-1')).toBe(false);
    expect(ws.sent).toEqual([]);
  });

  test('overflow clears the buffer and emits SourceGap resource_exhausted', () => {
    const store = new SessionStateStore({ maxOutputBufferBytes: 8 });
    const ws = createBorshTestWs();
    store.create(ws);
    store.startOutputBuffering(ws, 'device-1');

    expect(store.bufferOutput(ws, 'device-1', new Uint8Array([1, 2, 3, 4, 5]))).toBe(true);
    expect(store.bufferOutput(ws, 'device-1', new Uint8Array([6, 7, 8, 9]))).toBe(false);

    const gate = store.getOrCreateOutputGate(ws, 'device-1');
    expect(gate?.buffer).toEqual([]);
    expect(gate?.bufferBytes).toBe(0);
    expect(gate?.overflowed).toBe(true);
    expect(store.isBuffering(ws, 'device-1')).toBe(true);

    expect(ws.sent).toHaveLength(1);
    expect(decodeSentSourceGap(ws.sent[0])).toEqual({
      SourceGap: {
        reason: wsBorsh.SOURCE_GAP_REASON_RESOURCE_EXHAUSTED,
        scope: { Stream: {} },
      },
    });

    expect(store.bufferOutput(ws, 'device-1', new Uint8Array([9, 9]))).toBe(false);
    expect(gate?.buffer).toEqual([]);
    expect(ws.sent).toHaveLength(1);
    expect(store.stopOutputBuffering(ws, 'device-1')).toEqual([]);
  });

  test('frame-count overflow also clears and signals rebase instead of dropping oldest', () => {
    const store = new SessionStateStore({
      maxOutputBufferBytes: 1024,
      maxOutputBufferFrames: 2,
    });
    const ws = createBorshTestWs();
    store.create(ws);
    store.startOutputBuffering(ws, 'device-1');

    expect(store.bufferOutput(ws, 'device-1', new Uint8Array([1]))).toBe(true);
    expect(store.bufferOutput(ws, 'device-1', new Uint8Array([2]))).toBe(true);
    expect(store.bufferOutput(ws, 'device-1', new Uint8Array([3]))).toBe(false);

    const gate = store.getOrCreateOutputGate(ws, 'device-1');
    expect(gate?.buffer).toEqual([]);
    expect(gate?.overflowed).toBe(true);
    expect(decodeSentSourceGap(ws.sent[0])).toEqual({
      SourceGap: {
        reason: wsBorsh.SOURCE_GAP_REASON_RESOURCE_EXHAUSTED,
        scope: { Stream: {} },
      },
    });
  });

  test('overflow without a sendable client still clears the buffer', () => {
    const store = new SessionStateStore({ maxOutputBufferBytes: 2 });
    const ws = {} as ServerWebSocket<unknown>;
    store.create(ws);
    store.startOutputBuffering(ws, 'device-1');

    expect(store.bufferOutput(ws, 'device-1', new Uint8Array([1, 2, 3]))).toBe(false);
    const gate = store.getOrCreateOutputGate(ws, 'device-1');
    expect(gate?.buffer).toEqual([]);
    expect(gate?.overflowed).toBe(true);
  });
});

describe('SessionStateStore notification throttle TTL prune', () => {
  test('drops stale notification entries and keeps fresh ones', () => {
    let now = 1_000_000;
    const store = new SessionStateStore({
      now: () => now,
      throttlePruneIntervalMs: 1_000,
    });
    const ws = createBorshTestWs();
    store.create(ws);

    expect(store.shouldAllowNotification(ws, 'dev', '%1', 'stale', 2)).toBe(true);
    expect(store.shouldAllowNotification(ws, 'dev', '%1', 'fresh', 10)).toBe(true);

    now = 1_001_500;
    expect(store.shouldAllowNotification(ws, 'dev', '%1', 'fresh', 10)).toBe(false);
    const mid = store.get(ws);
    expect(mid?.notificationThrottles.has('dev:%1:stale')).toBe(true);
    expect(mid?.notificationThrottles.has('dev:%1:fresh')).toBe(true);

    now = 1_003_000;
    expect(store.shouldAllowNotification(ws, 'dev', '%1', 'next', 10)).toBe(true);

    const state = store.get(ws);
    expect(state?.notificationThrottles.has('dev:%1:stale')).toBe(false);
    expect(state?.notificationThrottles.has('dev:%1:fresh')).toBe(true);
    expect(state?.notificationThrottles.has('dev:%1:next')).toBe(true);
  });

  test('raising throttle from 10s to 60s still rejects at 31s', () => {
    let now = 1_000_000;
    const store = new SessionStateStore({
      now: () => now,
      throttlePruneIntervalMs: 1_000,
    });
    const ws = createBorshTestWs();
    store.create(ws);

    expect(store.shouldAllowNotification(ws, 'dev', '%1', 'src', 10)).toBe(true);

    now = 1_000_000 + 31_000;
    expect(store.shouldAllowNotification(ws, 'dev', '%1', 'src', 60)).toBe(false);
  });
});
