import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';

import { CanonicalFrameSizer } from './frame-sizer';
import { CanonicalTransactionSender } from './transaction-sender';

const REQUEST_ID = new Uint8Array(16).fill(0x33);
const SERVER_EPOCH = new Uint8Array(16).fill(0x11);

describe('canonical transaction sender', () => {
  test('chunks screen payloads and stops on send backpressure', () => {
    const events: wsBorsh.CanonicalEvent[] = [];
    let remaining = 3;
    const sender = new CanonicalTransactionSender({
      sizer: new CanonicalFrameSizer(256),
      sendEvent: (event) => {
        if (remaining <= 0) return false;
        remaining -= 1;
        events.push(event);
        return true;
      },
      isClosed: () => false,
      getServerEpoch: () => SERVER_EPOCH,
    });
    const data = new Uint8Array(400).fill(0x61);
    const sent = sender.sendScreenTransaction(
      'device-a',
      REQUEST_ID,
      {
        paneId: '%1',
        paneEpoch: new Uint8Array(16).fill(0x22),
        baseSeq: 0n,
        rows: 24,
        cols: 80,
        modes: 0,
        data,
        historyCursor: null,
        capturedAt: 0,
      },
      {
        splitAtBase: () => null,
        sendLive: () => true,
      }
    );
    expect(sent).toBe(false);
    expect(events[0] && 'ScreenBegin' in events[0]).toBe(true);
    expect(events.some((event) => 'ScreenChunk' in event)).toBe(true);
    expect(events.some((event) => 'ScreenCommit' in event)).toBe(false);
  });

  test('sendFitted skips the frame-size check but still refuses a closed session', () => {
    const events: wsBorsh.CanonicalEvent[] = [];
    let closed = false;
    const sender = new CanonicalTransactionSender({
      sizer: new CanonicalFrameSizer(64),
      sendEvent: (event) => {
        events.push(event);
        return true;
      },
      isClosed: () => closed,
      getServerEpoch: () => SERVER_EPOCH,
    });
    const oversized: wsBorsh.CanonicalEvent = {
      Error: { requestId: REQUEST_ID, code: 1, message: 'x'.repeat(200), retryable: false },
    };
    expect(sender.send(oversized)).toBe(false);
    expect(sender.sendFitted(oversized)).toBe(true);
    closed = true;
    expect(sender.sendFitted(oversized)).toBe(false);
    expect(events).toHaveLength(1);
  });

  test('truncates error messages to 512 bytes on the wire field', () => {
    const events: wsBorsh.CanonicalEvent[] = [];
    const sender = new CanonicalTransactionSender({
      sizer: new CanonicalFrameSizer(wsBorsh.CANONICAL_STATE_MAX_FRAME_BYTES),
      sendEvent: (event) => {
        events.push(event);
        return true;
      },
      isClosed: () => false,
      getServerEpoch: () => SERVER_EPOCH,
    });
    sender.sendError(REQUEST_ID, wsBorsh.ERROR_INTERNAL_ERROR, 'x'.repeat(600), true);
    const error = events[0];
    if (!error || !('Error' in error)) throw new Error('missing Error');
    expect(error.Error.message).toHaveLength(512);
    expect(error.Error.retryable).toBe(true);
  });
});
