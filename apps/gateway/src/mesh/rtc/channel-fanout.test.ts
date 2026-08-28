import { describe, expect, test } from 'bun:test';
import { fanoutDataChannel } from './channel-fanout';
import { FakeDataChannel, pairDataChannels } from './test-fakes';

function textOf(msg: string | Buffer | ArrayBuffer): string {
  if (typeof msg === 'string') return msg;
  return new TextDecoder().decode(msg);
}

describe('fanoutDataChannel', () => {
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
});
