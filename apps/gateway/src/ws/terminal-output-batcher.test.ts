import { describe, expect, test } from 'bun:test';

import {
  GATEWAY_TERM_OUTPUT_BATCH_DELAY_MS,
  GATEWAY_TERM_OUTPUT_BATCH_MAX_BYTES,
  type TerminalOutputBatchScheduler,
  TerminalOutputBatcher,
} from './terminal-output-batcher';

function values(data: Uint8Array): number[] {
  return Array.from(data);
}

class ManualScheduler implements TerminalOutputBatchScheduler {
  private nextId = 1;
  readonly tasks = new Map<number, { callback: () => void; delayMs: number }>();

  schedule(callback: () => void, delayMs: number): unknown {
    const id = this.nextId;
    this.nextId += 1;
    this.tasks.set(id, { callback, delayMs });
    return id;
  }

  cancel(handle: unknown): void {
    this.tasks.delete(handle as number);
  }

  runAll(): void {
    const tasks = [...this.tasks.entries()];
    for (const [id, task] of tasks) {
      if (!this.tasks.delete(id)) continue;
      task.callback();
    }
  }
}

describe('TerminalOutputBatcher', () => {
  test('uses one frame as the default bounded deadline', () => {
    expect(GATEWAY_TERM_OUTPUT_BATCH_DELAY_MS).toBe(16);
  });

  test('coalesces adjacent event-loop turns until the bounded deadline', async () => {
    const emitted: Array<{ deviceId: string; paneId: string; data: Uint8Array }> = [];
    const scheduler = new ManualScheduler();
    const batcher = new TerminalOutputBatcher(
      (deviceId, paneId, data) => {
        emitted.push({ deviceId, paneId, data });
      },
      {
        scheduler,
      }
    );

    batcher.push('device-a', '%1', new Uint8Array([1, 2]));
    await Promise.resolve();
    batcher.push('device-a', '%1', new Uint8Array([3]));
    await Promise.resolve();
    batcher.push('device-a', '%1', new Uint8Array([4, 5]));

    expect(emitted).toHaveLength(0);
    expect([...scheduler.tasks.values()].map((task) => task.delayMs)).toEqual([
      GATEWAY_TERM_OUTPUT_BATCH_DELAY_MS,
    ]);
    scheduler.runAll();

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.deviceId).toBe('device-a');
    expect(emitted[0]?.paneId).toBe('%1');
    expect(values(emitted[0]?.data ?? new Uint8Array())).toEqual([1, 2, 3, 4, 5]);
  });

  test('flushDevice preserves first-seen pane order and cancels scheduled work', () => {
    const emitted: string[] = [];
    const scheduler = new ManualScheduler();
    const batcher = new TerminalOutputBatcher(
      (deviceId, paneId, data) => {
        emitted.push(`${deviceId}/${paneId}:${values(data).join(',')}`);
      },
      {
        scheduler,
      }
    );

    batcher.push('device-a', '%2', new Uint8Array([2]));
    batcher.push('device-a', '%1', new Uint8Array([1]));
    batcher.push('device-a', '%2', new Uint8Array([3]));
    batcher.flushDevice('device-a');

    expect(emitted).toEqual(['device-a/%2:2,3', 'device-a/%1:1']);
    expect(scheduler.tasks.size).toBe(0);
  });

  test('flushes bounded chunks immediately when a batch reaches the limit', () => {
    const lengths: number[] = [];
    const scheduler = new ManualScheduler();
    const batcher = new TerminalOutputBatcher(
      (_deviceId, _paneId, data) => {
        lengths.push(data.length);
      },
      {
        scheduler,
      }
    );
    const oversized = new Uint8Array(GATEWAY_TERM_OUTPUT_BATCH_MAX_BYTES + 3);

    batcher.push('device-a', '%1', oversized);
    expect(lengths).toEqual([GATEWAY_TERM_OUTPUT_BATCH_MAX_BYTES]);
    expect(scheduler.tasks.size).toBe(1);

    scheduler.runAll();
    expect(lengths).toEqual([GATEWAY_TERM_OUTPUT_BATCH_MAX_BYTES, 3]);
    expect(lengths.every((length) => length <= GATEWAY_TERM_OUTPUT_BATCH_MAX_BYTES)).toBe(true);
  });

  test('discardDevice cancels queued output from a released connection', () => {
    const emitted: Uint8Array[] = [];
    const scheduler = new ManualScheduler();
    const batcher = new TerminalOutputBatcher(
      (_deviceId, _paneId, data) => {
        emitted.push(data);
      },
      {
        scheduler,
      }
    );

    batcher.push('device-a', '%1', new Uint8Array([1]));
    batcher.push('device-b', '%2', new Uint8Array([2]));
    batcher.discardDevice('device-a');
    scheduler.runAll();

    expect(emitted.map(values)).toEqual([[2]]);
  });
});
