export type RelayMetricsProcess = {
  memory: {
    rssBytes: number;
    heapTotalBytes: number;
    heapUsedBytes: number;
    externalBytes: number;
  };
  cpu: {
    utilizationPct: number | null;
  };
  loadAvg: [number, number, number] | null;
  eventLoop: {
    lagMs: number;
    maxLagMs: number;
  };
  openSockets: number;
  authenticatedLinks: number;
};

export type RelayMetricsTotals = {
  tenants: number;
  members: number;
  membersOnline: number;
  activeStreams: number;
  bytesIn: number;
  bytesOut: number;
  bytesInPerSec: number;
  bytesOutPerSec: number;
  framesInPerSec: number;
  framesOutPerSec: number;
};

export type RelayMetricsTenant = {
  id: string;
  label: string | null;
  memberCount: number;
  onlineMembers: number;
  activeStreams: number;
  bytesIn: number;
  bytesOut: number;
  bytesInPerSec: number;
  bytesOutPerSec: number;
  lastSeenAt: number | null;
  pack: {
    sizeBytes: number;
    updatedAt: number | null;
  };
  quota: {
    maxNodes: number;
    maxStreams: number;
    bandwidthBytesPerSec: number | null;
  } | null;
};

export type RelayMetricsMember = {
  tenantId: string;
  nodeId: string;
  name: string | null;
  online: boolean;
  lastSeenAt: number | null;
  connectedAt: number | null;
  rttMs: number | null;
  reconnects: number;
  activeStreams: number;
  bytesInPerSec: number;
  bytesOutPerSec: number;
};

export type RelayMetricsSample = {
  sampledAt: number;
  membersOnline: number;
  activeStreams: number;
  bytesInPerSec: number;
  bytesOutPerSec: number;
  framesInPerSec: number;
  framesOutPerSec: number;
  rssBytes: number;
  heapUsedBytes: number;
  eventLoopLagMs: number;
  cpuUtilizationPct: number | null;
};

export type RelayMetricsResponse = {
  schemaVersion: 1;
  sampledAt: number;
  intervalMs: number;
  uptimeMs: number;
  version: string;
  process: RelayMetricsProcess;
  totals: RelayMetricsTotals;
  tenants: RelayMetricsTenant[];
  members: RelayMetricsMember[];
  history: {
    intervalMs: number;
    samples: RelayMetricsSample[];
  };
};
