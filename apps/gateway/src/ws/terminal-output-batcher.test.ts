import { describe, expect, test } from 'bun:test';

import {
  GATEWAY_TERM_OUTPUT_BATCH_MAX_BYTES,
  TerminalOutputBatcher,
} from './terminal-output-batcher';

function values(data: Uint8Array): number[] {
  return Array.from(data);
}

describe('TerminalOutputBatcher', () => {
  test('coalesces same-tick pane output without changing byte order', async () => {
    const emitted: Array<{ deviceId: string; paneId: string; data: Uint8Array }> = [];
    const batcher = new TerminalOutputBatcher((deviceId, paneId, data) => {
      emitted.push({ deviceId, paneId, data });
    });

    batcher.push('device-a', '%1', new Uint8Array([1, 2]));
    batcher.push('device-a', '%1', new Uint8Array([3]));
    batcher.push('device-a', '%1', new Uint8Array([4, 5]));

    expect(emitted).toHaveLength(0);
    await Promise.resolve();

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.deviceId).toBe('device-a');
    expect(emitted[0]?.paneId).toBe('%1');
    expect(values(emitted[0]?.data ?? new Uint8Array())).toEqual([1, 2, 3, 4, 5]);
  });

  test('keeps panes independent while preserving first-seen flush order', async () => {
    const emitted: string[] = [];
    const batcher = new TerminalOutputBatcher((deviceId, paneId, data) => {
      emitted.push(`${deviceId}/${paneId}:${values(data).join(',')}`);
    });

    batcher.push('device-a', '%2', new Uint8Array([2]));
    batcher.push('device-a', '%1', new Uint8Array([1]));
    batcher.push('device-a', '%2', new Uint8Array([3]));
    await Promise.resolve();

    expect(emitted).toEqual(['device-a/%2:2,3', 'device-a/%1:1']);
  });

  test('flushes bounded chunks immediately when a same-tick batch reaches the limit', async () => {
    const lengths: number[] = [];
    const batcher = new TerminalOutputBatcher((_deviceId, _paneId, data) => {
      lengths.push(data.length);
    });
    const oversized = new Uint8Array(GATEWAY_TERM_OUTPUT_BATCH_MAX_BYTES + 3);

    batcher.push('device-a', '%1', oversized);
    expect(lengths).toEqual([GATEWAY_TERM_OUTPUT_BATCH_MAX_BYTES]);

    await Promise.resolve();
    expect(lengths).toEqual([GATEWAY_TERM_OUTPUT_BATCH_MAX_BYTES, 3]);
    expect(lengths.every((length) => length <= GATEWAY_TERM_OUTPUT_BATCH_MAX_BYTES)).toBe(true);
  });

  test('discardDevice prevents queued output from escaping a released connection', async () => {
    const emitted: Uint8Array[] = [];
    const batcher = new TerminalOutputBatcher((_deviceId, _paneId, data) => {
      emitted.push(data);
    });

    batcher.push('device-a', '%1', new Uint8Array([1]));
    batcher.push('device-b', '%2', new Uint8Array([2]));
    batcher.discardDevice('device-a');
    await Promise.resolve();

    expect(emitted.map(values)).toEqual([[2]]);
  });
});
