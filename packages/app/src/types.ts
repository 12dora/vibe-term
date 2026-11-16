import type { ServiceManagerKind } from './lib/platform';
import type { VibeTermRoleName } from './lib/roles';

export type { ServiceManagerKind };

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
  relayPublicUrl: string;
  peerPort: number;
  stunServers: string;
  noService: boolean;
  linger: boolean;
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
  /** systemd 用户服务是否启用 linger；缺省按开启处理，false 为用户明确关闭。 */
  linger?: boolean;
  /** 安装来源；老安装没有这一项（网关按 CLI 处理）。升级不覆盖已有值。 */
  installSource?: InstallSource;
  /** 安装 / 升级时探测到的服务管理器；serviceMode=none 时为 none。老安装没有这一项。 */
  serviceManager?: ServiceManagerKind;
  /** OpenRC：安装用户能否免密执行 `rc-service <服务名> …`（root 安装恒为 true）。 */
  openrcSudoers?: boolean;
}
