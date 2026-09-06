import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SERVICE_NAME } from '../constants';
import { t } from '../i18n';
import { ensureDir, pathExists, writeText } from './fs-utils';
import { detectServiceManager } from './platform';
import { runCommand } from './process';
import {
  installLaunchdService,
  installLegacyLabelledLaunchdService,
  queryLaunchdStatus,
  restartLaunchdService,
  startLaunchdService,
  stopLaunchdService,
  uninstallLaunchdService,
} from './service-launchd';
import type {
  ServiceDeps,
  ServiceIdentityOptions,
  ServiceInstallOptions,
  ServiceStatus,
  ServiceUninstallOptions,
} from './service-types';
import { ensureSystemdOomPolicyDropIn, removeSystemdOomPolicyDropIn } from './systemd-oom-policy';

export type {
  ServiceDeps,
  ServiceIdentityOptions,
  ServiceInstallOptions,
  ServiceStatus,
  ServiceUninstallOptions,
};
export {
  buildLaunchdPlist,
  buildLegacyLaunchdPlist,
  findLegacyLaunchdPlists,
  launchdLabel,
  legacyLaunchdLabel,
  legacyLaunchdPlistPaths,
  removeLegacyLaunchdJob,
  removeOtherLaunchdRegistrations,
} from './service-launchd';

function systemdUnitPath(serviceName: string, homeDir?: string): string {
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

/** 只有服务名真的换了才需要拆旧 unit；同名时新内容直接原地覆盖。 */
async function removeLegacySystemdUnit(
  serviceName: string,
  legacyName: string | undefined,
  deps?: ServiceDeps
): Promise<void> {
  if (!legacyName || legacyName === serviceName) return;
  const run = deps?.run ?? runCommand;
  const unitPath = systemdUnitPath(legacyName, deps?.homeDir);
  if (!(await pathExists(unitPath))) return;
  await run('systemctl', ['--user', 'disable', '--now', legacyName]).catch(() => null);
  await rm(unitPath, { force: true }).catch(() => null);
}

export function buildSystemdServiceContent({
  serviceName,
  runScriptPath,
  installDir,
}: ServiceInstallOptions): string {
  const escapedInstallDir = installDir.replaceAll('\\', '\\\\');
  const escapedRunScriptPath = runScriptPath.replaceAll('\\', '\\\\').replaceAll('"', '\\"');

  return `[Unit]
Description=VibeTerm (${serviceName})
After=network.target

[Service]
Type=simple
KillMode=process
WorkingDirectory=${escapedInstallDir}
SyslogIdentifier=vibeterm
StandardOutput=journal
StandardError=journal
ExecStart=/usr/bin/env bash "${escapedRunScriptPath}"
Restart=always
RestartSec=3
TimeoutStopSec=20

[Install]
WantedBy=default.target
`;
}

async function installSystemdService(
  options: ServiceInstallOptions,
  deps?: ServiceDeps
): Promise<void> {
  const run = deps?.run ?? runCommand;
  await removeLegacySystemdUnit(options.serviceName, options.legacyServiceName, deps);
  const unitPath = systemdUnitPath(options.serviceName, deps?.homeDir);
  await ensureDir(join(deps?.homeDir ?? homedir(), '.config', 'systemd', 'user'));
  await writeText(unitPath, buildSystemdServiceContent(options));
  await ensureSystemdOomPolicyDropIn({ configDir: deps?.oomConfigDir }).catch(() => 'failed');

  const daemonReload = await run('systemctl', ['--user', 'daemon-reload']);
  if (daemonReload.code !== 0) {
    throw new Error(
      t('service.systemd.daemonReloadFailed', {
        detail: daemonReload.stderr || daemonReload.stdout,
      })
    );
  }

  if (options.autostart) {
    const enable = await run('systemctl', ['--user', 'enable', options.serviceName]);
    if (enable.code !== 0) {
      throw new Error(
        t('service.systemd.enableFailed', {
          detail: enable.stderr || enable.stdout,
        })
      );
    }
  }

  const restart = await run('systemctl', ['--user', 'restart', options.serviceName]);
  if (restart.code !== 0) {
    throw new Error(
      t('service.systemd.restartFailed', {
        detail: restart.stderr || restart.stdout,
      })
    );
  }
}

async function resolveManager(deps?: ServiceDeps) {
  return deps?.manager ?? (await detectServiceManager());
}

export async function installService(
  options: ServiceInstallOptions,
  deps?: ServiceDeps
): Promise<void> {
  const manager = await resolveManager(deps);

  if (manager === 'systemd-user') {
    await installSystemdService(options, deps);
    return;
  }

  if (manager === 'launchd') {
    await installLaunchdService(options, deps);
    return;
  }

  throw new Error(t('service.install.unsupportedPlatform', { platform: process.platform }));
}

/**
 * 迁移回滚：launchd 侧写回旧 label 的 plist；systemd 侧 unit 名就是服务名本身，
 * 走普通安装即可（此时 options.legacyServiceName 是迁移后的新名，会被拆掉）。
 */
export async function installLegacyLabelledService(
  options: ServiceInstallOptions,
  deps?: ServiceDeps
): Promise<void> {
  const manager = await resolveManager(deps);
  if (manager !== 'launchd') {
    await installService(options, deps);
    return;
  }
  await installLegacyLabelledLaunchdService(options, deps);
}

export async function stopService(
  serviceName: string,
  installDir?: string,
  opts?: ServiceIdentityOptions
): Promise<void> {
  const manager = await resolveManager(opts?.deps);
  if (manager === 'systemd-user') {
    const run = opts?.deps?.run ?? runCommand;
    const names = [serviceName, opts?.legacyServiceName].filter(Boolean) as string[];
    for (const name of new Set(names)) {
      await run('systemctl', ['--user', 'stop', name]).catch(() => null);
    }
    return;
  }

  if (manager === 'launchd') {
    await stopLaunchdService(serviceName, installDir, opts);
  }
}

export async function startService(
  serviceName: string,
  installDir?: string,
  deps?: ServiceDeps
): Promise<void> {
  const manager = await resolveManager(deps);
  if (manager === 'systemd-user') {
    const run = deps?.run ?? runCommand;
    const start = await run('systemctl', ['--user', 'start', serviceName]);
    if (start.code !== 0) {
      throw new Error(
        t('service.systemd.restartFailed', {
          detail: start.stderr || start.stdout,
        })
      );
    }
    return;
  }

  if (manager === 'launchd') {
    await startLaunchdService(serviceName, installDir, deps);
    return;
  }

  throw new Error(t('service.install.unsupportedPlatform', { platform: process.platform }));
}

async function uninstallSystemdService(serviceName: string, deps?: ServiceDeps): Promise<void> {
  const run = deps?.run ?? runCommand;
  await run('systemctl', ['--user', 'disable', '--now', serviceName]).catch(() => null);
  const unitPath = systemdUnitPath(serviceName, deps?.homeDir);
  if (await pathExists(unitPath)) {
    await rm(unitPath, { force: true });
  }
  await removeSystemdOomPolicyDropIn({ configDir: deps?.oomConfigDir }).catch(() => 'failed');
  await run('systemctl', ['--user', 'daemon-reload']).catch(() => null);
}

export async function uninstallService(
  options: ServiceUninstallOptions,
  deps?: ServiceDeps
): Promise<void> {
  const manager = await resolveManager(deps);

  if (manager === 'systemd-user') {
    await uninstallSystemdService(options.serviceName, deps);
    return;
  }

  if (manager === 'launchd') {
    await uninstallLaunchdService(options.serviceName, options.installDir, deps);
  }
}

async function querySystemdStatus(serviceName: string, deps?: ServiceDeps): Promise<ServiceStatus> {
  const run = deps?.run ?? runCommand;
  const unitPath = systemdUnitPath(serviceName, deps?.homeDir);
  const installed = await pathExists(unitPath);

  const active = await run('systemctl', ['--user', 'is-active', serviceName]).catch(() => null);
  const enabled = await run('systemctl', ['--user', 'is-enabled', serviceName]).catch(() => null);

  return {
    manager: 'systemd-user',
    installed,
    running: active?.code === 0,
    autostartEnabled: enabled?.code === 0,
    detail: active?.stdout.trim() || enabled?.stdout.trim() || undefined,
  };
}

export async function getServiceStatus(
  serviceName: string,
  installDir?: string,
  opts?: ServiceIdentityOptions
): Promise<ServiceStatus> {
  const manager = await resolveManager(opts?.deps);

  if (manager === 'systemd-user') {
    return await querySystemdStatus(serviceName, opts?.deps);
  }

  if (manager === 'launchd') {
    return await queryLaunchdStatus(serviceName, installDir, opts);
  }

  return {
    manager: 'none',
    installed: false,
    running: false,
    autostartEnabled: false,
    detail: t('service.status.none', { platform: process.platform }),
  };
}

export async function serviceHint(serviceName: string): Promise<string> {
  const manager = await detectServiceManager();
  if (manager === 'systemd-user') {
    return t('service.hint.systemd', { serviceName });
  }
  if (manager === 'launchd') {
    return t('service.hint.launchd', { serviceName });
  }
  return t('service.hint.none');
}

export async function restartService(
  serviceName: string,
  installDir?: string,
  deps?: ServiceDeps
): Promise<void> {
  const manager = await resolveManager(deps);
  if (manager === 'systemd-user') {
    const run = deps?.run ?? runCommand;
    const restart = await run('systemctl', ['--user', 'restart', serviceName]);
    if (restart.code !== 0) {
      throw new Error(
        t('service.systemd.restartFailed', {
          detail: restart.stderr || restart.stdout,
        })
      );
    }
    return;
  }

  if (manager === 'launchd') {
    await restartLaunchdService(serviceName, installDir, deps);
    return;
  }

  throw new Error(t('service.install.unsupportedPlatform', { platform: process.platform }));
}
