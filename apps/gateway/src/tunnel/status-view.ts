import type {
  TunnelAccessStatus,
  TunnelBinaryStatus,
  TunnelConnectorStatus,
  TunnelEdgeResolution,
  TunnelExternalStatus,
  TunnelJobStatus,
  TunnelProcessState,
  TunnelStatusResponse,
} from '@tmex/shared';
import { type TunnelAccessPersisted, computeAccessEffective } from './access-store';
import type { TunnelPersisted } from './config-store';
import { isTunnelPlatformSupported, tunnelPlatformLabel } from './platform';

export const FAKE_IP_HINT =
  'edge DNS resolved to fake-IP 198.18.x (local proxy); static edge override';

export function buildAccessStatus(
  row: TunnelAccessPersisted,
  persisted: TunnelPersisted
): TunnelAccessStatus {
  const configured = Boolean(row.appId && row.aud && row.hostname);
  return {
    hasCredentials: Boolean(row.apiTokenEnc && row.accountId),
    accountId: row.accountId,
    teamDomain: row.teamDomain,
    configured,
    appId: row.appId,
    aud: row.aud,
    hostname: row.hostname,
    rules: [...row.rules],
    enforceJwt: row.enforceJwt,
    effective: computeAccessEffective({
      configured,
      enforceJwt: row.enforceJwt,
      accessHostname: row.hostname,
      tunnelMode: persisted.mode,
      tunnelHostname: persisted.hostname,
    }),
    bypassAppId: row.bypassAppIds[0] ?? null,
    lastError: row.lastError,
  };
}

export function tunnelProcessState(input: {
  persisted: TunnelPersisted;
  externalRunning: boolean;
  connector: TunnelConnectorStatus;
  supervisorState: TunnelProcessState;
}): TunnelProcessState {
  const degradedConnector =
    input.connector.reachable === true && input.connector.readyConnections === 0;
  if (input.persisted.externallyManaged) {
    if (!input.externalRunning) return 'stopped';
    return degradedConnector ? 'degraded' : 'running';
  }
  if (input.supervisorState === 'running' && degradedConnector) return 'degraded';
  return input.supervisorState;
}

export function tunnelPublicUrl(
  persisted: TunnelPersisted,
  processAlive: boolean,
  quickUrl: string | null
): string | null {
  const hostUrl = persisted.hostname ? `https://${persisted.hostname}` : null;
  if (persisted.externallyManaged) return hostUrl;
  if (!processAlive) return null;
  if (persisted.mode === 'named') return hostUrl;
  return persisted.mode === 'quick' ? quickUrl : null;
}

/** 0 连接且系统解析器返回 fake-IP 时给出可操作提示 */
export function edgeHintText(edge: TunnelEdgeResolution | null): string {
  if (!edge?.fakeIpDetected) return '';
  const state = edge.mode === 'static' ? 'active' : `failed: ${edge.lastError ?? 'unknown'}`;
  return ` — ${FAKE_IP_HINT} ${state}`;
}

export function connectorHintText(
  connector: TunnelConnectorStatus,
  edgeHint: () => string
): string {
  if (connector.reachable === true && connector.readyConnections != null) {
    const hint = connector.readyConnections === 0 ? edgeHint() : '';
    return ` (connector: ${connector.readyConnections} edge connections)${hint}`;
  }
  if (connector.reachable === false) return ' (connector: metrics unreachable)';
  return '';
}

export type TunnelSupervisorView = {
  pid: number | null;
  startedAt: string | null;
  lastError: string | null;
  restarts: number;
  publicUrl: string | null;
};

export type TunnelStatusInput = {
  platform: NodeJS.Platform;
  arch: string;
  binary: { path: string | null; version: string | null; source: TunnelBinaryStatus['source'] };
  persisted: TunnelPersisted;
  loggedIn: boolean;
  loginUrl: string | null;
  originPort: number;
  processState: TunnelProcessState;
  processAlive: boolean;
  supervisor: TunnelSupervisorView;
  connector: TunnelConnectorStatus;
  connectorLastError: string | null;
  edge: TunnelEdgeResolution | null;
  access: TunnelAccessStatus;
  external: TunnelExternalStatus;
  loginEnforced: boolean;
  exposureProtected: boolean;
  job: TunnelJobStatus | null;
  trustProxy: boolean;
  configuredTrustProxy: boolean;
  restartRequired: boolean;
  log: string[];
};

export function buildTunnelStatus(input: TunnelStatusInput): TunnelStatusResponse {
  const { persisted, supervisor } = input;
  const external = persisted.externallyManaged;
  return {
    supported: isTunnelPlatformSupported(input.platform, input.arch),
    platform: tunnelPlatformLabel(input.platform, input.arch),
    binary: {
      installed: Boolean(input.binary.path),
      version: input.binary.version,
      path: input.binary.path,
      source: input.binary.source,
    },
    auth: { loggedIn: input.loggedIn, loginUrl: input.loginUrl },
    config: {
      mode: persisted.mode,
      hostname: persisted.hostname,
      tunnelName: persisted.tunnelName,
      tunnelId: persisted.tunnelId,
      autoStart: persisted.autoStart,
      externallyManaged: persisted.externallyManaged,
      originPort: input.originPort,
      accessMode: persisted.accessMode,
    },
    process: {
      state: input.processState,
      pid: external ? null : supervisor.pid,
      startedAt: external ? null : supervisor.startedAt,
      publicUrl: tunnelPublicUrl(persisted, input.processAlive, supervisor.publicUrl),
      lastError: external ? input.connectorLastError : supervisor.lastError,
      restarts: external ? 0 : supervisor.restarts,
    },
    connector: { ...input.connector },
    edge: external ? null : input.edge,
    access: input.access,
    external: input.external,
    loginEnforced: input.loginEnforced,
    exposureProtected: input.exposureProtected,
    job: input.job ? { ...input.job } : null,
    trustProxy: input.trustProxy,
    configuredTrustProxy: input.configuredTrustProxy,
    restartRequired: input.restartRequired,
    log: input.log,
  };
}
