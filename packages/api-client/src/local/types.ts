import type { TlsMode } from './tls-types';

export type LocalRole = 'standalone' | 'node' | 'hub,node' | 'relay' | 'relay,node';

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

export interface LocalRelayStatus {
  publicUrl: string | null;
  hasPassword: boolean;
  tenantCount: number;
  nodesOnline: number;
  currentNodes: number;
}

export interface LocalStatusResponse {
  role: LocalRole;
  nodeEnv: 'development' | 'test' | 'production';
  hubUrl: string | null;
  hubPublicUrl: string | null;
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

export interface SetupPrecheckResponse {
  reachable: boolean;
  isSelf: boolean;
  status: number | null;
  error: string | null;
}

export type SetupDirectOutcome = 'enabled' | 'failed' | 'skipped';

export interface SetupHubRequest {
  hubPublicUrl: string;
  username: string;
  password: string;
  directEnable: boolean;
}

export interface SetupHubResponse {
  ok: true;
  fingerprint: string;
  direct: SetupDirectOutcome;
  directError: string | null;
  restarting: true;
}

export interface SetupJoinRequest {
  hubUrl: string;
  token?: string;
  password?: string;
  method?: 'token' | 'password';
  name: string;
  directEnable: boolean;
  insecureLocal?: boolean;
}

export interface SetupJoinResponse {
  ok: true;
  hubUrl: string;
  username: string;
  direct: SetupDirectOutcome;
  directError: string | null;
  restarting: true;
}

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
