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

export interface LocalStatusResponse {
  role: LocalRole;
  nodeEnv: 'development' | 'test' | 'production';
  hubUrl: string | null;
  hubPublicUrl: string | null;
  direct: LocalDirectStatus;
  tls: LocalTlsStatus;
  domainAccess: LocalDomainAccessStatus;
}

export type LocalDirectAction = 'install' | 'remove' | 'enable' | 'disable';

export interface LocalDirectResponse {
  ok: true;
  installed: boolean;
  enabled: boolean;
  capable: boolean;
  restartRequired: boolean;
}

export interface LocalLeaveRequest {
  expectedRole: 'node' | 'hub,node';
}

export interface LocalLeaveResponse {
  ok: true;
  fromRole: 'node' | 'hub,node';
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
  token: string;
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

export interface ApiErrorBody {
  error: { code: string; message: string };
}
