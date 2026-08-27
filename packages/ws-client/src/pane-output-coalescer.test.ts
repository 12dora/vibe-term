import { describe, expect, test } from 'bun:test';
import { PaneOutputCoalescer } from './pane-output-coalescer';
import type { GatewayTerminalData } from './transport';

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (data: Uint8Array) => new TextDecoder().decode(data);

function frame(paneId: string, text: string, extra: Partial<GatewayTerminalData> = {}) {
  return { deviceId: 'dev', paneId, data: encode(text), ...extra };
}

function createHarness(flushBytes?: number) {
  const emitted: Array<{ key: string; frame: GatewayTerminalData }> = [];
  let pending: Array<() => void> = [];
  const coalescer = new PaneOutputCoalescer((key, merged) => emitted.push({ key, frame: merged }), {
    ...(flushBytes === undefined ? {} : { flushBytes }),
    schedule: (flush) => pending.push(flush),
  });

  return {
    coalescer,
    emitted,
    texts: () => emitted.map((entry) => decode(entry.frame.data)),
    runScheduled: () => {
      const callbacks = pending;
      pending = [];
      for (const callback of callbacks) callback();
    },
    scheduledCount: () => pending.length,
  };
}

describe('PaneOutputCoalescer', () => {
  test('同一 pane 的连续帧在调度边界合并为一次下发', () => {
    const harness = createHarness();

    harness.coalescer.push('dev:%1', frame('%1', 'abc'));
    harness.coalescer.push('dev:%1', frame('%1', 'def'));
    expect(harness.emitted).toEqual([]);

    harness.runScheduled();
    expect(harness.texts()).toEqual(['abcdef']);
  });

  test('一个调度周期只排一次回调，多 pane 各自成帧且不互串', () => {
    const harness = createHarness();

    harness.coalescer.push('dev:%1', frame('%1', 'a1'));
    harness.coalescer.push('dev:%2', frame('%2', 'b1'));
    harness.coalescer.push('dev:%1', frame('%1', 'a2'));
    expect(harness.scheduledCount()).toBe(1);

    harness.runScheduled();
    expect(harness.emitted.map((entry) => [entry.key, decode(entry.frame.data)])).toEqual([
      ['dev:%1', 'a1a2'],
      ['dev:%2', 'b1'],
    ]);
  });

  test('跨 flush 的字节顺序保持不变', () => {
    const harness = createHarness();

    harness.coalescer.push('dev:%1', frame('%1', '1'));
    harness.runScheduled();
    harness.coalescer.push('dev:%1', frame('%1', '2'));
    harness.coalescer.push('dev:%1', frame('%1', '3'));
    harness.runScheduled();
    harness.coalescer.push('dev:%1', frame('%1', '4'));
    harness.runScheduled();

    expect(harness.texts()).toEqual(['1', '23', '4']);
  });

  test('攒够 flushBytes 立即同步下发，不等调度边界', () => {
    const harness = createHarness(8);

    harness.coalescer.push('dev:%1', frame('%1', '1234'));
    expect(harness.emitted).toEqual([]);
    harness.coalescer.push('dev:%1', frame('%1', '5678'));
    expect(harness.texts()).toEqual(['12345678']);

    // 阈值触发的 flush 之后仍能继续攒下一批
    harness.coalescer.push('dev:%1', frame('%1', '9'));
    harness.runScheduled();
    expect(harness.texts()).toEqual(['12345678', '9']);
  });

  test('paneEpoch 变化时先把旧 epoch 的字节冲出去', () => {
    const harness = createHarness();
    const first = new Uint8Array(16).fill(1);
    const second = new Uint8Array(16).fill(2);

    harness.coalescer.push('dev:%1', frame('%1', 'old', { paneEpoch: first }));
    harness.coalescer.push('dev:%1', frame('%1', 'new', { paneEpoch: second }));

    expect(harness.texts()).toEqual(['old']);
    expect(harness.emitted[0]?.frame.paneEpoch).toBe(first);

    harness.runScheduled();
    expect(harness.texts()).toEqual(['old', 'new']);
    expect(harness.emitted[1]?.frame.paneEpoch).toBe(second);
  });

  test('合并帧取首帧的 seqStart 与末帧的 seqEnd', () => {
    const harness = createHarness();

    harness.coalescer.push('dev:%1', frame('%1', 'a', { seqStart: 4n, seqEnd: 5n }));
    harness.coalescer.push('dev:%1', frame('%1', 'b', { seqStart: 6n, seqEnd: 9n }));
    harness.runScheduled();

    expect(harness.emitted[0]?.frame.seqStart).toBe(4n);
    expect(harness.emitted[0]?.frame.seqEnd).toBe(9n);
  });

  test('flush 无缓冲时不产生空帧', () => {
    const harness = createHarness();

    harness.coalescer.flush('dev:%1');
    harness.runScheduled();

    expect(harness.emitted).toEqual([]);
  });

  test('discardMatching 丢弃命中的 pane，其余仍照常下发', () => {
    const harness = createHarness();

    harness.coalescer.push('dev-a:%1', frame('%1', 'gone'));
    harness.coalescer.push('dev-b:%1', frame('%1', 'kept'));
    harness.coalescer.discardMatching((key) => key.startsWith('dev-a:'));
    harness.runScheduled();

    expect(harness.texts()).toEqual(['kept']);
  });
});
