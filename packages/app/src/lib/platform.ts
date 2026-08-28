import { runCommand } from './process';

export type ServiceManagerKind = 'systemd-user' | 'launchd' | 'none';

type Probe = (command: string, args: string[]) => Promise<{ code: number } | null>;

const defaultProbe: Probe = (command, args) =>
  runCommand(command, args, { stdio: 'pipe', timeoutMs: 5000 }).catch(() => null);

// `systemctl --version` 只证明二进制存在；容器 / 无 user bus 的 SSH 会话里 user manager 不可达，
// 需再探测 `--user` 连接，否则后续 `systemctl --user` 全部失败。
export async function detectServiceManager(
  platform: NodeJS.Platform = process.platform,
  probe: Probe = defaultProbe
): Promise<ServiceManagerKind> {
  if (platform === 'darwin') return 'launchd';
  if (platform === 'linux') {
    const version = await probe('systemctl', ['--version']);
    if (!version || version.code !== 0) return 'none';
    const userManager = await probe('systemctl', ['--user', 'show-environment']);
    if (userManager && userManager.code === 0) return 'systemd-user';
    return 'none';
  }
  return 'none';
}

export function isSupportedPlatform(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'linux' || platform === 'darwin';
}
