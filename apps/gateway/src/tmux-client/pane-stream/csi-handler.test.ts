import { describe, expect, test } from 'bun:test';

import { maybeEmitThemeSubscription } from './csi-handler';

const encoder = new TextEncoder();

function emit(
  params: string,
  finalByte: number,
  inTmuxPassthrough: boolean,
  onThemeSubscription: (subscribed: boolean) => void
): void {
  const bytes = encoder.encode(params);
  maybeEmitThemeSubscription(
    bytes,
    bytes.length,
    finalByte,
    inTmuxPassthrough,
    onThemeSubscription
  );
}

describe('maybeEmitThemeSubscription', () => {
  test('reports 2031h and 2031l', () => {
    const subs: boolean[] = [];
    emit('?2031', 0x68, false, (value) => subs.push(value));
    emit('?2031', 0x6c, false, (value) => subs.push(value));
    expect(subs).toEqual([true, false]);
  });

  test('accepts 2031 among combined private modes', () => {
    const subs: boolean[] = [];
    emit('?1004;2031', 0x68, false, (value) => subs.push(value));
    expect(subs).toEqual([true]);
  });

  test('does not report during tmux passthrough', () => {
    const subs: boolean[] = [];
    emit('?2031', 0x68, true, (value) => subs.push(value));
    expect(subs).toEqual([]);
  });

  test('ignores lookalike modes and non-private CSI', () => {
    const subs: boolean[] = [];
    const onSub = (value: boolean) => subs.push(value);
    emit('?20316', 0x68, false, onSub);
    emit('1;31', 0x6d, false, onSub);
    emit('?1004', 0x68, false, onSub);
    expect(subs).toEqual([]);
  });
});
