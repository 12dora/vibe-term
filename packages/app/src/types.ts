import type { TmexRoleName } from './lib/roles';

export interface ParsedArgs {
  command: string | null;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export interface InitConfig {
  installDir: string;
  host: string;
  port: number;
  databasePath: string;
  autostart: boolean;
  serviceName: string;
  force: boolean;
  nonInteractive: boolean;
  installDeps: boolean;
  skipDepCheck: boolean;
  role: TmexRoleName;
  hubUrl: string;
  hubPublicUrl: string;
  relayPublicUrl: string;
  peerPort: number;
  stunServers: string;
  noService: boolean;
}

export type CheckLevel = 'pass' | 'warn' | 'fail';

export interface DoctorCheck {
  id: string;
  level: CheckLevel;
  message: string;
  detail?: string;
  hint?: string;
  fixable?: boolean;
}

export type ServiceMode = 'managed' | 'none';

export interface InstallMeta {
  serviceName: string;
  platform: NodeJS.Platform;
  autostart: boolean;
  installDir: string;
  updatedAt: string;
  cliVersion: string;
  bunPath?: string;
  serviceMode?: ServiceMode;
}
