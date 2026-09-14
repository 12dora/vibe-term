import type { TlsMode } from './tls-types';

export type LocalRole = 'standalone' | 'node' | 'relay' | 'relay,node';

export interface LocalDirectStatus {
  supported: boolean;
  installed: boolean;
  enabled: boolean;
  capable: boolean;
  version: string | null;
  platform: string;
}

export interface LocalTlsStatus {
  mode: TlsMode;
  listenerRunning: boolean;
  tlsPort: number | null;
}

export interface LocalDomainAccessStatus {
  allowed: boolean;
  viaDomain: boolean;
  hosts: string[];
}

export interface LocalRelayTurnStatus {
  enabled: boolean;
  source: 'builtin' | 'external' | 'off';
  url: string | null;
  port: number | null;
  externalIp: string | null;
  listening: boolean;
  allocations: number;
  /** 分配上限；旧中继不下发。 */
  maxAlloc?: number | null;
  error: string | null;
  relayPortRange: string | null;
  membersProbe?: { ok: number; total: number; updatedAt: number } | null;
}

export interface LocalRelayStatus {
  publicUrl: string | null;
  hasPassword: boolean;
  tenantCount: number;
  nodesOnline: number;
  currentNodes: number;
  turn?: LocalRelayTurnStatus;
}

export interface LocalStatusResponse {
  role: LocalRole;
  nodeEnv: 'development' | 'test' | 'production';
  direct: LocalDirectStatus;
  tls: LocalTlsStatus;
  domainAccess: LocalDomainAccessStatus;
  relay: LocalRelayStatus | null;
}

export type LocalDirectAction = 'install' | 'remove' | 'enable' | 'disable';

export interface LocalDirectResponse {
  ok: true;
  installed: boolean;
  enabled: boolean;
  capable: boolean;
  restartRequired: boolean;
}

/** 能退出 mesh 的角色：必须带 node 才有成员身份，纯 `relay` 不算。 */
export type LocalMeshRole = Exclude<LocalRole, 'standalone' | 'relay'>;

export type LocalLeaveTargetRole = 'standalone' | 'relay';

export interface LocalLeaveRequest {
  expectedRole: LocalMeshRole;
  targetRole?: LocalLeaveTargetRole;
}

export interface LocalLeaveResponse {
  ok: true;
  fromRole: LocalMeshRole;
  targetRole: LocalLeaveTargetRole;
  restarting: true;
}

/** 端口探测的服务形态：中继打 `/api/relay/health`。 */
export type SetupPrecheckKind = 'relay';

export interface SetupPrecheckRequest {
  url: string;
  /** 缺省为 `relay`。 */
  kind?: SetupPrecheckKind;
}

export interface SetupPrecheckResponse {
  reachable: boolean;
  isSelf: boolean;
  status: number | null;
  error: string | null;
  /** 端口探测确定的地址（含端口）；未探测或一个端口都没答话为 `null`。 */
  resolvedUrl: string | null;
  /** 实际发起过探测的端口；未探测为空。 */
  triedPorts: number[];
  /** 地址没写端口时才探测候选端口。 */
  probed: boolean;
}

export type SetupDirectOutcome = 'enabled' | 'failed' | 'skipped';

export type SetupRelayRole = 'relay' | 'relay,node';

export interface SetupRelayRequest {
  role: SetupRelayRole;
  relayPublicUrl: string;
  relayPassword?: string | null;
  username?: string;
  password?: string;
  directEnable?: boolean;
}

export interface SetupRelayResponse {
  ok: true;
  direct: SetupDirectOutcome;
  directError: string | null;
  role: SetupRelayRole;
  relayPublicUrl: string;
  hasPassword: boolean;
  restarting: true;
  fingerprint?: string;
}

export interface SetupRelayJoinRequest {
  relayUrl: string;
  tenantId: string;
  password: string;
  name: string;
  caFingerprint?: string;
  directEnable?: boolean;
}

export interface SetupRelayJoinResponse {
  ok: true;
  relayUrl: string;
  tenantId: string;
  username: string;
  direct: SetupDirectOutcome;
  directError: string | null;
  restarting: true;
}
