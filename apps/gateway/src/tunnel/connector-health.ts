import type { TunnelConnectorStatus } from '@tmex/shared';

export const EMPTY_CONNECTOR: TunnelConnectorStatus = {
  reachable: null,
  metricsAddr: null,
  readyConnections: null,
  connectorId: null,
  checkedAt: null,
  lastError: null,
};
