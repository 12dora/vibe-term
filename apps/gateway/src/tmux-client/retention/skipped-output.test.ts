import { describe, expect, test } from 'bun:test';

import {
  clearSkippedPaneOutput,
  clearSkippedPaneOutputsForDevice,
  hasDeviceSkippedPaneOutput,
  hasSkippedPaneOutput,
  markSkippedPaneOutput,
} from './skipped-output';

describe('skipped pane output state', () => {
  test('isolates devices and replaces a pane epoch without leaving stale indexes', () => {
    const epochA = new Uint8Array(16).fill(0xa1);
    const epochB = new Uint8Array(16).fill(0xa2);
    clearSkippedPaneOutputsForDevice('device-a');
    clearSkippedPaneOutputsForDevice('device-b');

    markSkippedPaneOutput('device-a', '%1', epochA);
    markSkippedPaneOutput('device-b', '%1', epochB);
    expect(hasSkippedPaneOutput('%1', epochA)).toBe(true);
    expect(hasSkippedPaneOutput('%1', epochB)).toBe(true);

    markSkippedPaneOutput('device-a', '%1', epochB);
    expect(hasDeviceSkippedPaneOutput('device-a', '%1')).toBe(true);
    expect(hasSkippedPaneOutput('%1', epochA)).toBe(false);
    expect(hasSkippedPaneOutput('%1', epochB)).toBe(true);

    clearSkippedPaneOutput('device-a', '%1');
    expect(hasDeviceSkippedPaneOutput('device-a', '%1')).toBe(false);
    expect(hasDeviceSkippedPaneOutput('device-b', '%1')).toBe(true);
    clearSkippedPaneOutputsForDevice('device-b');
    expect(hasSkippedPaneOutput('%1', epochB)).toBe(false);
  });
});
