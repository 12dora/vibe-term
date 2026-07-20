import { describe, expect, test } from 'bun:test';

import { TerminalOutputMetrics } from './terminal-output-metrics';

describe('TerminalOutputMetrics', () => {
  test('reports source, drop, batch, and recipient layers without identifiers', () => {
    const metrics = new TerminalOutputMetrics(1_000, 10_000);
    metrics.recordSource(3, false);
    metrics.recordSource(5, true);
    metrics.recordBatch(5);
    metrics.recordRecipient(5);
    metrics.recordRecipient(5);

    expect(metrics.takeIfDue(10_999)).toBeNull();
    expect(metrics.takeIfDue(11_000)).toEqual({
      intervalMs: 1_000,
      sourceEvents: 2,
      sourceBytes: 8,
      droppedEvents: 1,
      droppedBytes: 3,
      batches: 1,
      batchBytes: 5,
      recipientDeliveries: 2,
      recipientBytes: 10,
    });
  });

  test('resets counters after a report window', () => {
    const metrics = new TerminalOutputMetrics(1_000, 5_000);
    metrics.recordSource(7, true);
    expect(metrics.takeIfDue(6_000)?.sourceBytes).toBe(7);

    metrics.recordBatch(4);
    expect(metrics.takeIfDue(7_000)).toEqual({
      intervalMs: 1_000,
      sourceEvents: 0,
      sourceBytes: 0,
      droppedEvents: 0,
      droppedBytes: 0,
      batches: 1,
      batchBytes: 4,
      recipientDeliveries: 0,
      recipientBytes: 0,
    });
  });
});
