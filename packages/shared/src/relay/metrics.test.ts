import { describe, expect, test } from 'bun:test';
import type { RelayMetricsResponse } from './metrics';

const SAMPLE: RelayMetricsResponse = {
  schemaVersion: 1,
  sampledAt: 1,
  intervalMs: 5000,
  uptimeMs: 10,
  version: '1.1.23',
  process: {
    memory: { rssBytes: 1, heapTotalBytes: 1, heapUsedBytes: 1, externalBytes: 0 },
    cpu: { utilizationPct: null },
    loadAvg: null,
    eventLoop: { lagMs: 0, maxLagMs: 0 },
    openSockets: 0,
    authenticatedLinks: 0,
  },
  totals: {
    tenants: 0,
    members: 0,
    membersOnline: 0,
    activeStreams: 0,
    bytesIn: 0,
    bytesOut: 0,
    bytesInPerSec: 0,
    bytesOutPerSec: 0,
    framesInPerSec: 0,
    framesOutPerSec: 0,
    bandwidthBytesPerSec: 0,
  },
  tenants: [],
  members: [],
  history: { intervalMs: 5000, samples: [] },
};

describe('RelayMetricsResponse JSON', () => {
  test('wire fixture serializes with schemaVersion 1', () => {
    const json = JSON.stringify(SAMPLE);
    expect(json.startsWith('{"schemaVersion":1,')).toBe(true);
    const parsed = JSON.parse(json) as RelayMetricsResponse;
    expect(parsed.totals.bandwidthBytesPerSec).toBe(0);
    expect(parsed.members).toEqual([]);
  });
});
