import { describe, expect, test } from 'bun:test';

import { maybeEmitThemeSubscription } from './csi-handler';

describe('maybeEmitThemeSubscription', () => {
  test('reports 2031h and 2031l', () => {
    const subs: boolean[] = [];
    maybeEmitThemeSubscription([0x3f, 0x32, 0x30, 0x33, 0x31], 0x68, false, (value) =>
      subs.push(value)
    );
    maybeEmitThemeSubscription([0x3f, 0x32, 0x30, 0x33, 0x31], 0x6c, false, (value) =>
      subs.push(value)
    );
    expect(subs).toEqual([true, false]);
  });

  test('accepts 2031 among combined private modes', () => {
    const subs: boolean[] = [];
    const params = Array.from(new TextEncoder().encode('?1004;2031'));
    maybeEmitThemeSubscription(params, 0x68, false, (value) => subs.push(value));
    expect(subs).toEqual([true]);
  });

  test('does not report during tmux passthrough', () => {
    const subs: boolean[] = [];
    maybeEmitThemeSubscription([0x3f, 0x32, 0x30, 0x33, 0x31], 0x68, true, (value) =>
      subs.push(value)
    );
    expect(subs).toEqual([]);
  });

  test('ignores lookalike modes and non-private CSI', () => {
    const subs: boolean[] = [];
    const onSub = (value: boolean) => subs.push(value);
    maybeEmitThemeSubscription(Array.from(new TextEncoder().encode('?20316')), 0x68, false, onSub);
    maybeEmitThemeSubscription(Array.from(new TextEncoder().encode('1;31')), 0x6d, false, onSub);
    maybeEmitThemeSubscription(Array.from(new TextEncoder().encode('?1004')), 0x68, false, onSub);
    expect(subs).toEqual([]);
  });
});
