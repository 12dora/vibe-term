import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SERVICE_NAME } from '../constants';

export function systemdUnitPath(serviceName: string, homeDir?: string): string {
  return join(homeDir ?? homedir(), '.config', 'systemd', 'user', `${serviceName}.service`);
}

export function vibeTermSystemdUnitPath(serviceName = DEFAULT_SERVICE_NAME): string {
  return systemdUnitPath(serviceName);
}

/**
 * 1.1.x 之前写出的 unit 没有 `KillMode=process`：`Restart=always` 触发的重启会把整个
 * cgroup（含用户的 tmux 服务端）一起 SIGTERM，表现为窗口连同进程凭空消失。
 */
export function systemdUnitLacksKillModeProcess(unitContent: string | null): boolean {
  if (unitContent === null) return false;
  return !/^\s*KillMode\s*=\s*process\s*$/m.test(unitContent);
}

export const SYSTEMD_KILL_MODE_WARNING =
  '[service] the systemd unit lacks KillMode=process; tmux may be killed on restart — run vibeterm upgrade / re-install to refresh the unit';
