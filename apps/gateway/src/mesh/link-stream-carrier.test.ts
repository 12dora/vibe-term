import { describe, expect, test } from 'bun:test';
import { createInMemoryLinkPair } from '@tmex/shared/link';
import { SHARE_WS_CLOSE_ENDED } from '@tmex/shared/share';
import { LINK_STREAM_BACKPRESSURE_BYTES, LinkStreamCarrier } from './link-stream-carrier';
import {
  decodeTerminalStreamClose,
  encodeTerminalStreamClose,
  isTerminalStreamClose,
} from './stream-close-code';

describe('LinkStreamCarrier', () => {
  test('maps send queue above 1 MiB to backpressure and fires onDrain', async () => {
    const [a, b] = createInMemoryLinkPair();
    const incomingP = new Promise<import('@tmex/shared/link').LinkStream>((resolve) =>
      b.onStream(resolve)
    );
    const out = await a.openStream(new Uint8Array([1]));
    const incoming = await incomingP;
    const carrier = new LinkStreamCarrier(incoming);
    let drained = 0;
    carrier.onDrain(() => {
      drained += 1;
    });

    const meg = new Uint8Array(LINK_STREAM_BACKPRESSURE_BYTES);
    expect(carrier.send(meg)).toBe('sent');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(carrier.send(meg)).toBe('sent');
    expect(carrier.send(new Uint8Array(1))).toBe('backpressure');

    const reader = out.readable.getReader();
    while (carrier.bufferedAmount() > LINK_STREAM_BACKPRESSURE_BYTES) {
      await reader.read();
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(drained).toBeGreaterThan(0);
    out.end();
    incoming.end();
  });

  test('close ends the stream and terminate RSTs', async () => {
    const [a, b] = createInMemoryLinkPair();
    const incomingP = new Promise<import('@tmex/shared/link').LinkStream>((resolve) =>
      b.onStream(resolve)
    );
    const out = await a.openStream(new Uint8Array([1]));
    const incoming = await incomingP;
    const carrier = new LinkStreamCarrier(out);
    carrier.close(1000, 'bye');
    const reader = incoming.readable.getReader();
    expect((await reader.read()).done).toBe(true);
    incoming.end();
    expect((await out.closed).reason).toBe('end');

    const incoming2P = new Promise<import('@tmex/shared/link').LinkStream>((resolve) =>
      b.onStream(resolve)
    );
    const out2 = await a.openStream(new Uint8Array([2]));
    await incoming2P;
    const carrier2 = new LinkStreamCarrier(out2);
    const aborted = new Promise<void>((resolve) => out2.onAbort(resolve));
    carrier2.terminate();
    await aborted;
  });

  test('close drains already-accepted frames before END', async () => {
    const [a, b] = createInMemoryLinkPair();
    const incomingP = new Promise<import('@tmex/shared/link').LinkStream>((resolve) =>
      b.onStream(resolve)
    );
    const out = await a.openStream(new Uint8Array([1]));
    const incoming = await incomingP;
    const carrier = new LinkStreamCarrier(out);
    expect(carrier.send(new TextEncoder().encode('one'))).toBe('sent');
    expect(carrier.send(new TextEncoder().encode('two'))).toBe('sent');
    carrier.close(1000, 'bye');
    expect(carrier.send(new TextEncoder().encode('three'))).toBe('closed');
    const reader = incoming.readable.getReader();
    const first = await reader.read();
    const second = await reader.read();
    const done = await reader.read();
    expect(new TextDecoder().decode(first.value?.bytes)).toBe('one');
    expect(new TextDecoder().decode(second.value?.bytes)).toBe('two');
    expect(done.done).toBe(true);
  });

  test('link abort fires onClose even with a queued send', async () => {
    const [a, b] = createInMemoryLinkPair();
    const incomingP = new Promise<import('@tmex/shared/link').LinkStream>((resolve) =>
      b.onStream(resolve)
    );
    const out = await a.openStream(new Uint8Array([1]));
    await incomingP;
    const carrier = new LinkStreamCarrier(out);
    const closed = new Promise<void>((resolve) => carrier.onClose(resolve));
    expect(carrier.send(new Uint8Array(64))).toBe('sent');
    a.close('link-down');
    await closed;
    expect(carrier.send(new Uint8Array([1]))).toBe('closed');
  });
});

describe('LinkStreamCarrier 终止性关闭码', () => {
  test('4410 以 RST 携带 code:reason，对端可解码', async () => {
    const [a, b] = createInMemoryLinkPair();
    const incomingP = new Promise<import('@tmex/shared/link').LinkStream>((resolve) =>
      b.onStream(resolve)
    );
    const out = await a.openStream(new Uint8Array([1]));
    const incoming = await incomingP;
    const carrier = new LinkStreamCarrier(incoming);
    let closed = 0;
    carrier.onClose(() => {
      closed += 1;
    });
    carrier.close(SHARE_WS_CLOSE_ENDED, 'SHARE_ENDED');
    expect(closed).toBe(1);
    const info = await out.closed;
    expect(info.reason).toBe('rst');
    expect(decodeTerminalStreamClose(info.message)).toEqual({
      code: SHARE_WS_CLOSE_ENDED,
      reason: 'SHARE_ENDED',
    });
  });

  test('普通关闭码仍是干净半关闭，不带终止标记', async () => {
    const [a, b] = createInMemoryLinkPair();
    const incomingP = new Promise<import('@tmex/shared/link').LinkStream>((resolve) =>
      b.onStream(resolve)
    );
    const out = await a.openStream(new Uint8Array([1]));
    const incoming = await incomingP;
    new LinkStreamCarrier(incoming).close(1000, 'bye');
    const reader = out.readable.getReader();
    const first = await reader.read();
    expect(first.done).toBe(true);
    out.end();
  });
});

describe('stream-close-code', () => {
  test('编解码只认白名单里的终止码', () => {
    expect(decodeTerminalStreamClose(encodeTerminalStreamClose(4410, 'SHARE_ENDED'))).toEqual({
      code: 4410,
      reason: 'SHARE_ENDED',
    });
    expect(
      decodeTerminalStreamClose(encodeTerminalStreamClose(4401, 'NODE_LOGIN_REQUIRED'))
    ).toEqual({ code: 4401, reason: 'NODE_LOGIN_REQUIRED' });
    expect(decodeTerminalStreamClose('tmex-close:1011:boom')).toBeNull();
    expect(decodeTerminalStreamClose('session-invalid')).toBeNull();
    expect(decodeTerminalStreamClose(undefined)).toBeNull();
    expect(isTerminalStreamClose({ code: 4410 })).toBe(true);
    expect(isTerminalStreamClose({ code: 1011 })).toBe(false);
    expect(isTerminalStreamClose(null)).toBe(false);
  });
});
