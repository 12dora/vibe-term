// 指标面板的测试夹具：一份形状完整的 `GET /api/relay/metrics` 响应，按需覆写字段。
// 只被 *.test.tsx 引用，不进产物。

import type {
  RelayMetricsMember,
  RelayMetricsResponse,
  RelayMetricsSample,
} from '@tmex/api-client/relay/metrics-types';

export const RELAY_METRICS_SAMPLED_AT = 1_700_000_600_000;

export function relayMetricsSample(
  index: number,
  patch: Partial<RelayMetricsSample> = {}
): RelayMetricsSample {
  return {
    sampledAt: RELAY_METRICS_SAMPLED_AT - (5 - index) * 5_000,
    membersOnline: 2,
    activeStreams: index,
    bytesInPerSec: 1024 * (index + 1),
    bytesOutPerSec: 2048 * (index + 1),
    framesInPerSec: 10 * index,
    framesOutPerSec: 12 * index,
    rssBytes: 128 * 1024 * 1024,
    heapUsedBytes: 48 * 1024 * 1024,
    eventLoopLagMs: 2 + index,
    cpuUtilizationPct: 5 + index,
    ...patch,
  };
}

export function relayMetricsMember(patch: Partial<RelayMetricsMember> = {}): RelayMetricsMember {
  return {
    tenantId: '0123456789abcdef0123456789abcdef',
    nodeId: 'aabbccddeeff0011',
    name: '上海节点',
    online: true,
    lastSeenAt: RELAY_METRICS_SAMPLED_AT,
    connectedAt: RELAY_METRICS_SAMPLED_AT - 3_600_000,
    rttMs: 42,
    reconnects: 1,
    activeStreams: 2,
    bytesInPerSec: 4096,
    bytesOutPerSec: 8192,
    ...patch,
  };
}

export function relayMetricsFixture(
  patch: Partial<RelayMetricsResponse> = {}
): RelayMetricsResponse {
  return {
    schemaVersion: 1,
    sampledAt: RELAY_METRICS_SAMPLED_AT,
    intervalMs: 5_000,
    uptimeMs: 90_000_000,
    version: '1.1.27',
    process: {
      memory: {
        rssBytes: 134_217_728,
        heapTotalBytes: 67_108_864,
        heapUsedBytes: 50_331_648,
        externalBytes: 4_194_304,
      },
      cpu: { utilizationPct: 12.5 },
      loadAvg: [1.2, 1.1, 0.9],
      eventLoop: { lagMs: 3.2, maxLagMs: 18.4 },
      openSockets: 9,
      authenticatedLinks: 4,
    },
    totals: {
      tenants: 2,
      members: 5,
      membersOnline: 3,
      activeStreams: 4,
      bytesIn: 10_485_760,
      bytesOut: 10_485_760,
      bytesInPerSec: 8192,
      bytesOutPerSec: 16_384,
      framesInPerSec: 24,
      framesOutPerSec: 30,
    },
    tenants: [],
    members: [
      relayMetricsMember(),
      relayMetricsMember({
        nodeId: 'ffeeddccbbaa9988',
        name: null,
        online: false,
        rttMs: null,
        activeStreams: 0,
        bytesInPerSec: 0,
        bytesOutPerSec: 0,
        connectedAt: null,
      }),
    ],
    history: {
      intervalMs: 5_000,
      samples: [0, 1, 2, 3, 4, 5].map((index) => relayMetricsSample(index)),
    },
    ...patch,
  };
}
