import { describe, expect, test } from 'bun:test';

import { ControlStreamMetrics } from './control-stream-metrics';

describe('ControlStreamMetrics', () => {
  test('separates raw control traffic from parsed terminal output and control events', () => {
    const metrics = new ControlStreamMetrics(1_000, 10_000);
    metrics.recordRawChunk(100);
    metrics.recordControlOutput(80);
    metrics.recordTerminalOutput(20);
    metrics.recordTitle();
    metrics.recordBell();
    metrics.recordNotification();
    metrics.recordStructureChange();
    metrics.recordBlock();

    expect(metrics.takeIfDue(10_999)).toBeNull();
    expect(metrics.takeIfDue(11_000)).toEqual({
      intervalMs: 1_000,
      rawChunks: 1,
      rawBytes: 100,
      controlOutputs: 1,
      controlOutputBytes: 80,
      terminalOutputs: 1,
      terminalOutputBytes: 20,
      titles: 1,
      bells: 1,
      notifications: 1,
      structureChanges: 1,
      blocks: 1,
    });
    expect(metrics.lastRawChunkAtMs()).toBeGreaterThan(0);
  });

  test('resets all counters after reporting', () => {
    const metrics = new ControlStreamMetrics(1_000, 5_000);
    metrics.recordRawChunk(7);
    expect(metrics.takeIfDue(6_000)?.rawBytes).toBe(7);
    expect(metrics.takeIfDue(7_000)).toEqual({
      intervalMs: 1_000,
      rawChunks: 0,
      rawBytes: 0,
      controlOutputs: 0,
      controlOutputBytes: 0,
      terminalOutputs: 0,
      terminalOutputBytes: 0,
      titles: 0,
      bells: 0,
      notifications: 0,
      structureChanges: 0,
      blocks: 0,
    });
  });
});
