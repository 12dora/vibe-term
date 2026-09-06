import type { ServiceManagerKind } from './platform';
import type { runCommand } from './process';

export interface ServiceInstallOptions {
  serviceName: string;
  runScriptPath: string;
  installDir: string;
  autostart: boolean;
  /**
   * 改名前注册用的服务名。与 serviceName 不同时（迁移把默认 `tmex` 改成 `vibeterm`），
   * 注册新身份之前要把它留下的 plist / unit 拆掉，否则 KeepAlive / Restart 会拉起第二个实例抢端口。
   */
  legacyServiceName?: string;
}

export interface ServiceUninstallOptions {
  serviceName: string;
  installDir?: string;
}

export interface ServiceStatus {
  manager: ServiceManagerKind;
  installed: boolean;
  running: boolean;
  autostartEnabled: boolean;
  detail?: string;
}

/** 测试注入点：不注入就打真实 launchctl / systemctl 与真实 $HOME。 */
export interface ServiceDeps {
  run?: typeof runCommand;
  homeDir?: string;
  manager?: ServiceManagerKind;
  /** systemd OOM drop-in 的配置根目录；测试注入，避免写到真实 ~/.config/systemd */
  oomConfigDir?: string;
}

export interface ServiceIdentityOptions {
  legacyServiceName?: string;
  deps?: ServiceDeps;
}
