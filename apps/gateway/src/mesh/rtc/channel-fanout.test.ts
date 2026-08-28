import { describe, expect, test } from 'bun:test';
import {
  FANOUT_MAX_PENDING_BYTES,
  FANOUT_MAX_PENDING_MESSAGES,
  fanoutDataChannel,
} from './channel-fanout';
import { FakeDataChannel, pairDataChannels } from './test-fakes';

function textOf(msg: string | Buffer | ArrayBuffer): string {
  if (typeof msg === 'string') return msg;
  return new TextDecoder().decode(msg);
}

describe('fanoutDataChannel', () => {
  test('shiftPendingMessage takes the first buffered frame and leaves the rest', () => {
    const [a, b] = pairDataChannels('peer');
    const fan = fanoutDataChannel(b);
    expect(a.sendMessage('nonce')).toBe(true);
    expect(a.sendMessage('frame')).toBe(true);
    expect(textOf(fan.shiftPendingMessage() ?? '')).toBe('nonce');
    const later: string[] = [];
    fan.onMessage((msg) => {
      later.push(textOf(msg));
    });
    expect(later).toEqual(['frame']);
  });

  test('buffers messages while no listener is attached and replays them in order', () => {
    const [a, b] = pairDataChannels('peer');
    const fan = fanoutDataChannel(b);
    expect(a.sendMessage('one')).toBe(true);
    expect(a.sendMessage('two')).toBe(true);
    const got: string[] = [];
    fan.onMessage((msg) => {
      got.push(textOf(msg));
    });
    expect(got).toEqual(['one', 'two']);
    expect(a.sendMessage('three')).toBe(true);
    expect(got).toEqual(['one', 'two', 'three']);
  });

  test('resumes buffering after the last message listener detaches', () => {
    const [a, b] = pairDataChannels('peer');
    const fan = fanoutDataChannel(b);
    const early: string[] = [];
    const unsub: unknown = fan.onMessage((msg) => {
      early.push(textOf(msg));
    });
    expect(typeof unsub).toBe('function');
    expect(a.sendMessage('keep')).toBe(true);
    expect(early).toEqual(['keep']);
    if (typeof unsub === 'function') unsub();
    expect(a.sendMessage('held')).toBe(true);
    expect(early).toEqual(['keep']);
    const later: string[] = [];
    fan.onMessage((msg) => {
      later.push(textOf(msg));
    });
    expect(later).toEqual(['held']);
  });

  test('replays close to a listener registered after the channel already closed', () => {
    const [a, b] = pairDataChannels('peer');
    const fan = fanoutDataChannel(b);
    a.close();
    expect(fan.isOpen()).toBe(false);
    let closed = 0;
    fan.onClosed(() => {
      closed += 1;
    });
    expect(closed).toBe(1);
    fan.onClosed(() => {
      closed += 1;
    });
    expect(closed).toBe(2);
  });

  test('replays error to a late subscriber', () => {
    const inner = new FakeDataChannel('peer');
    inner.markOpen();
    const fan = fanoutDataChannel(inner);
    inner.emitError('boom');
    let err = '';
    fan.onError((e) => {
      err = e;
    });
    expect(err).toBe('boom');
  });

  test('buffers a 2 MiB burst of 64 KiB frames while detached instead of closing at 32 messages', () => {
    const [a, b] = pairDataChannels('peer');
    a.maxSize = 64 * 1024;
    b.maxSize = 64 * 1024;
    const fan = fanoutDataChannel(b, { peer: 'node-b' });
    const frame = Buffer.alloc(64 * 1024, 7);
    for (let i = 0; i < FANOUT_MAX_PENDING_MESSAGES + 1; i++) {
      expect(a.sendMessageBinary(frame)).toBe(true);
    }
    expect(fan.isOpen()).toBe(true);
    expect(b.closed).toBe(false);
    const later: number[] = [];
    fan.onMessage((msg) => {
      later.push(typeof msg === 'string' ? msg.length : msg.byteLength);
    });
    expect(later).toHaveLength(FANOUT_MAX_PENDING_MESSAGES + 1);
    expect(later.every((n) => n === 64 * 1024)).toBe(true);
  });

  test('closes the channel on buffer overflow instead of dropping frames', () => {
    const [a, b] = pairDataChannels('peer');
    const fan = fanoutDataChannel(b, { peer: 'node-b' });
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      const chunk = Buffer.alloc(1024 * 1024, 1);
      const n = Math.floor(FANOUT_MAX_PENDING_BYTES / chunk.byteLength) + 1;
      for (let i = 0; i < n; i++) {
        expect(a.sendMessageBinary(chunk)).toBe(true);
      }
      expect(fan.isOpen()).toBe(false);
      expect(b.closed).toBe(true);
      expect(
        lines.some(
          (line) =>
            line.includes('[mesh][rtc] buffer overflow') &&
            line.includes('peer=node-b') &&
            line.includes('dropped=')
        )
      ).toBe(true);
      const later: string[] = [];
      fan.onMessage((msg) => {
        later.push(textOf(msg));
      });
      expect(later).toEqual([]);
    } finally {
      console.log = orig;
    }
  });

  test('preserves text frames so handshake JSON stays distinguishable from binary', () => {
    const inner = new FakeDataChannel('peer');
    inner.markOpen();
    const fan = fanoutDataChannel(inner);
    const kinds: Array<{ type: string; handshake: boolean }> = [];
    fan.onMessage((msg) => {
      kinds.push({
        type: typeof msg,
        handshake: typeof msg === 'string' || (msg instanceof Buffer && msg[0] === 0x7b),
      });
    });
    inner.emitMessage('{"t":"hello"}');
    inner.emitMessage(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(kinds).toEqual([
      { type: 'string', handshake: true },
      { type: 'object', handshake: false },
    ]);
  });

  test('reinjectMessages prepends leftovers ahead of frames that arrived after detach', () => {
    const [a, b] = pairDataChannels('peer');
    const fan = fanoutDataChannel(b);
    const early: string[] = [];
    const unsub: unknown = fan.onMessage((msg) => {
      early.push(textOf(msg));
    });
    expect(typeof unsub).toBe('function');
    if (typeof unsub === 'function') unsub();
    expect(a.sendMessage('after-detach')).toBe(true);
    fan.reinjectMessages([Buffer.from('leftover')]);
    const later: string[] = [];
    fan.onMessage((msg) => {
      later.push(textOf(msg));
    });
    expect(later).toEqual(['leftover', 'after-detach']);
  });
});
