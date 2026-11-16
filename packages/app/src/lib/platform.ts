import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { runCommand } from './process';

export type ServiceManagerKind = 'systemd-user' | 'launchd' | 'openrc' | 'none';

/** `none` 的具体原因；目前只区分「装了 OpenRC 但系统不是它引导的」（容器常见）。 */
export type ServiceManagerNoneReason = 'openrc-not-booted';

export interface ServiceManagerDetection {
  kind: ServiceManagerKind;
  reason?: ServiceManagerNoneReason;
}

type Probe = (command: string, args: string[]) => Promise<{ code: number } | null>;

export interface OpenrcProbeDeps {
  exists?: (path: string) => boolean;
  pathEnv?: string;
}

const OPENRC_RUN = '/sbin/openrc-run';
const OPENRC_SVCDIR = '/run/openrc';
const SYSTEMD_BOOTED = '/run/systemd/system';

const defaultProbe: Probe = (command, args) =>
  runCommand(command, args, { stdio: 'pipe', timeoutMs: 5000 }).catch(() => null);

async function hasSystemdUserManager(probe: Probe): Promise<boolean> {
  const version = await probe('systemctl', ['--version']);
  if (!version || version.code !== 0) return false;
  // `systemctl --version` 只证明二进制存在；容器 / 无 user bus 的 SSH 会话里 user manager 不可达。
  const userManager = await probe('systemctl', ['--user', 'show-environment']);
  return userManager?.code === 0;
}

function hasOpenrcRun(exists: (path: string) => boolean, pathEnv: string): boolean {
  if (exists(OPENRC_RUN)) return true;
  return pathEnv
    .split(delimiter)
    .filter(Boolean)
    .some((dir) => exists(join(dir, 'openrc-run')));
}

// 未经 OpenRC 引导的系统（容器里装了 openrc 包）没有 softlevel，rc-service 只会告警并给出不可预期的结果。
async function detectOpenrc(probe: Probe, deps: OpenrcProbeDeps): Promise<ServiceManagerDetection> {
  const exists = deps.exists ?? existsSync;
  if (!hasOpenrcRun(exists, deps.pathEnv ?? process.env.PATH ?? '')) return { kind: 'none' };
  if (exists(join(OPENRC_SVCDIR, 'softlevel'))) return { kind: 'openrc' };
  if (exists(OPENRC_SVCDIR)) {
    const status = await probe('rc-status', ['--runlevel']);
    if (status?.code === 0) return { kind: 'openrc' };
  }
  // systemd 引导的主机上装了 openrc 包只是缺 user bus，不能误报成「OpenRC 未引导（容器）」。
  if (exists(SYSTEMD_BOOTED)) return { kind: 'none' };
  return { kind: 'none', reason: 'openrc-not-booted' };
}

export async function detectServiceManagerDetail(
  platform: NodeJS.Platform = process.platform,
  probe: Probe = defaultProbe,
  openrc: OpenrcProbeDeps = {}
): Promise<ServiceManagerDetection> {
  if (platform === 'darwin') return { kind: 'launchd' };
  if (platform !== 'linux') return { kind: 'none' };
  if (await hasSystemdUserManager(probe)) return { kind: 'systemd-user' };
  return await detectOpenrc(probe, openrc);
}

export async function detectServiceManager(
  platform: NodeJS.Platform = process.platform,
  probe: Probe = defaultProbe,
  openrc: OpenrcProbeDeps = {}
): Promise<ServiceManagerKind> {
  return (await detectServiceManagerDetail(platform, probe, openrc)).kind;
}

export function isSupportedPlatform(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'linux' || platform === 'darwin';
}
