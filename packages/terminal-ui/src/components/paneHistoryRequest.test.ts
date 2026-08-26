import { describe, expect, test } from 'bun:test';
import { historyRequestDeadlineMs, shouldRequestOlderHistory } from './paneHistoryRequest';

describe('historyRequestDeadlineMs', () => {
  test('keeps a 15s floor for fast or unknown links', () => {
    expect(historyRequestDeadlineMs(null)).toBe(15_000);
    expect(historyRequestDeadlineMs(undefined)).toBe(15_000);
    expect(historyRequestDeadlineMs(100)).toBe(15_000);
  });

  test('scales with latency up to a 60s ceiling', () => {
    expect(historyRequestDeadlineMs(3_000)).toBe(24_000);
    expect(historyRequestDeadlineMs(10_000)).toBe(60_000);
  });
});

describe('shouldRequestOlderHistory', () => {
  test('requires an upward wheel near the top of the buffer', () => {
    expect(shouldRequestOlderHistory({ deltaY: -1, requestInFlight: false, viewportY: 0 })).toBe(
      true
    );
    expect(shouldRequestOlderHistory({ deltaY: -1, requestInFlight: false, viewportY: 3 })).toBe(
      true
    );
  });

  test('skips downward scrolls, in-flight requests and deep viewports', () => {
    expect(shouldRequestOlderHistory({ deltaY: 1, requestInFlight: false, viewportY: 0 })).toBe(
      false
    );
    expect(shouldRequestOlderHistory({ deltaY: 0, requestInFlight: false, viewportY: 0 })).toBe(
      false
    );
    expect(shouldRequestOlderHistory({ deltaY: -1, requestInFlight: true, viewportY: 0 })).toBe(
      false
    );
    expect(shouldRequestOlderHistory({ deltaY: -1, requestInFlight: false, viewportY: 4 })).toBe(
      false
    );
  });
});
