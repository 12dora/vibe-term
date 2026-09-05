import { describe, expect, test } from 'bun:test';
import { combineAbortSignals } from './abort';

function spyOnRemoveListener(signal: AbortSignal): { calls: number } {
  const spy = { calls: 0 };
  const original = signal.removeEventListener.bind(signal);
  signal.removeEventListener = ((...args: Parameters<typeof original>) => {
    spy.calls += 1;
    return original(...args);
  }) as typeof signal.removeEventListener;
  return spy;
}

describe('combineAbortSignals', () => {
  test('returns undefined when no usable signal is passed', () => {
    expect(combineAbortSignals()).toBeUndefined();
    expect(combineAbortSignals(undefined, null)).toBeUndefined();
  });

  test('returns the single signal unchanged when exactly one is passed', () => {
    const controller = new AbortController();
    expect(combineAbortSignals(controller.signal)).toBe(controller.signal);
    expect(combineAbortSignals(undefined, controller.signal, null)).toBe(controller.signal);
  });

  test('aborts once any input aborts, propagating its reason', () => {
    const a = new AbortController();
    const b = new AbortController();
    const combined = combineAbortSignals(a.signal, b.signal);
    expect(combined).toBeDefined();
    expect(combined?.aborted).toBe(false);

    const reason = new Error('a failed first');
    a.abort(reason);

    expect(combined?.aborted).toBe(true);
    expect(combined?.reason).toBe(reason);
  });

  test('first abort wins when both inputs abort', () => {
    const a = new AbortController();
    const b = new AbortController();
    const combined = combineAbortSignals(a.signal, b.signal);

    a.abort('reason-a');
    b.abort('reason-b');

    expect(combined?.aborted).toBe(true);
    expect(combined?.reason).toBe('reason-a');
  });

  test('is already aborted when one input is aborted upfront', () => {
    const a = new AbortController();
    a.abort('already gone');
    const b = new AbortController();

    const combined = combineAbortSignals(a.signal, b.signal);

    expect(combined?.aborted).toBe(true);
    expect(combined?.reason).toBe('already gone');
  });

  test('does not leak listeners: aborting one input after the other already fired is a no-op', () => {
    const a = new AbortController();
    const b = new AbortController();
    const combined = combineAbortSignals(a.signal, b.signal);

    a.abort('first');
    // 第二次 abort 不应改变已经确定的 reason，也不该抛错（监听器已摘干净）。
    expect(() => b.abort('second')).not.toThrow();
    expect(combined?.reason).toBe('first');
  });

  test('manual fallback (no AbortSignal.any) also propagates the first reason and unregisters listeners', () => {
    const original = AbortSignal.any;
    // @ts-expect-error - 临时摘掉原生 fast path，逼手搭 fallback 分支跑一遍
    AbortSignal.any = undefined;
    try {
      const a = new AbortController();
      const b = new AbortController();
      const removeSpyA = spyOnRemoveListener(a.signal);
      const removeSpyB = spyOnRemoveListener(b.signal);

      const combined = combineAbortSignals(a.signal, b.signal);
      a.abort('fallback-reason');

      expect(combined?.aborted).toBe(true);
      expect(combined?.reason).toBe('fallback-reason');
      expect(removeSpyA.calls).toBe(1);
      expect(removeSpyB.calls).toBe(1);
    } finally {
      AbortSignal.any = original;
    }
  });

  test('combines three or more signals', () => {
    const a = new AbortController();
    const b = new AbortController();
    const c = new AbortController();
    const combined = combineAbortSignals(a.signal, b.signal, c.signal);

    c.abort('c-reason');

    expect(combined?.aborted).toBe(true);
    expect(combined?.reason).toBe('c-reason');
  });
});
