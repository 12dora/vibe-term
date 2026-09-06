import type { VibeTermRoleName } from './lib/roles';

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
  role: VibeTermRoleName;
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

/** 安装来源（写进 install-meta.json；网关另有 `manual` 表示压根没有 install-meta）。 */
export type InstallSource = 'install-script' | 'npx' | 'cli';

export interface InstallMeta {
  serviceName: string;
  platform: NodeJS.Platform;
  autostart: boolean;
  installDir: string;
  updatedAt: string;
  cliVersion: string;
  bunPath?: string;
  serviceMode?: ServiceMode;
  /** 安装来源；老安装没有这一项（网关按 CLI 处理）。升级不覆盖已有值。 */
  installSource?: InstallSource;
}
