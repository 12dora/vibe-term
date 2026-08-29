import type { TlsMode } from './tls-types';

export type LocalRole = 'standalone' | 'node' | 'hub,node';

export interface LocalDirectStatus {
  supported: boolean;
  installed: boolean;
  capable: boolean;
  version: string | null;
  platform: string;
}

export interface LocalTlsStatus {
  mode: TlsMode;
}

export interface LocalStatusResponse {
  role: LocalRole;
  nodeEnv: 'development' | 'test' | 'production';
  hubUrl: string | null;
  hubPublicUrl: string | null;
  direct: LocalDirectStatus;
  tls: LocalTlsStatus;
}

export interface LocalDirectResponse {
  ok: true;
  installed: boolean;
  capable: boolean;
  restartRequired: boolean;
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
