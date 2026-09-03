import { describe, expect, test } from 'bun:test';

import { TerminalOutputMetrics, emptyTerminalOutputQueueStats } from './terminal-output-metrics';

describe('TerminalOutputMetrics', () => {
  test('reports source, drop, batch, and recipient layers without identifiers', () => {
    const metrics = new TerminalOutputMetrics(1_000, 10_000);
    metrics.recordSource(3, { legacy: false, canonical: false });
    metrics.recordSource(5, { legacy: true, canonical: true });
    metrics.recordBatch(5);
    metrics.recordRecipient(5);
    metrics.recordRecipient(5);
    metrics.recordCanonicalRecipient(5, true);
    metrics.recordCanonicalRecipient(2, false);

    expect(metrics.takeIfDue(10_999)).toBeNull();
    expect(metrics.takeIfDue(11_000)).toEqual({
      intervalMs: 1_000,
      sourceEvents: 2,
      sourceBytes: 8,
      droppedEvents: 1,
      droppedBytes: 3,
      legacyObservedEvents: 1,
      legacyObservedBytes: 5,
      canonicalObservedEvents: 1,
      canonicalObservedBytes: 5,
      batches: 1,
      batchBytes: 5,
      recipientDeliveries: 2,
      recipientBytes: 10,
      canonicalRecipientDeliveries: 1,
      canonicalRecipientBytes: 5,
      canonicalDeliveryDrops: 1,
      canonicalDeliveryDropBytes: 2,
      queues: emptyTerminalOutputQueueStats(),
    });
  });

  test('resets counters after a report window', () => {
    const metrics = new TerminalOutputMetrics(1_000, 5_000);
    metrics.recordSource(7, { legacy: true, canonical: false });
    expect(metrics.takeIfDue(6_000)?.sourceBytes).toBe(7);

    metrics.recordBatch(4);
    expect(metrics.takeIfDue(7_000)).toEqual({
      intervalMs: 1_000,
      sourceEvents: 0,
      sourceBytes: 0,
      droppedEvents: 0,
      droppedBytes: 0,
      legacyObservedEvents: 0,
      legacyObservedBytes: 0,
      canonicalObservedEvents: 0,
      canonicalObservedBytes: 0,
      batches: 1,
      batchBytes: 4,
      recipientDeliveries: 0,
      recipientBytes: 0,
      canonicalRecipientDeliveries: 0,
      canonicalRecipientBytes: 0,
      canonicalDeliveryDrops: 0,
      canonicalDeliveryDropBytes: 0,
      queues: emptyTerminalOutputQueueStats(),
    });
  });

  test('isDue follows a fake clock so the window closes at 30s without 1024 events', () => {
    const metrics = new TerminalOutputMetrics(30_000, 1_000);
    expect(metrics.isDue(30_999)).toBe(false);
    expect(metrics.takeIfDue(30_999)).toBeNull();
    expect(metrics.isDue(31_000)).toBe(true);
    expect(metrics.takeIfDue(31_000)?.intervalMs).toBe(30_000);
    expect(metrics.isDue(31_000)).toBe(false);
  });
});
