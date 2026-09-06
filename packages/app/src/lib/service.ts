import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SERVICE_NAME } from '../constants';
import { t } from '../i18n';
import { ensureDir, pathExists, writeText } from './fs-utils';
import { type ServiceManagerKind, detectServiceManager } from './platform';
import { runCommand } from './process';
import { ensureSystemdOomPolicyDropIn, removeSystemdOomPolicyDropIn } from './systemd-oom-policy';

export interface ServiceInstallOptions {
  serviceName: string;
  runScriptPath: string;
  installDir: string;
  autostart: boolean;
  /** 曾用的服务名；与 serviceName 不同时，安装前拆掉它留下的 systemd unit。 */
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

function systemdUnitPath(serviceName: string): string {
  return join(homedir(), '.config', 'systemd', 'user', `${serviceName}.service`);
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

function launchdLabel(serviceName: string): string {
  return `com.vibeterm.${serviceName}`;
}

/** 改名前的 launchd label；升级时必须先卸载它，否则 KeepAlive 会拉起第二个实例抢端口。 */
function legacyLaunchdLabel(serviceName: string): string {
  return `com.tmex.${serviceName}`;
}

function launchdLaunchAgentsPlistPath(serviceName: string): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${launchdLabel(serviceName)}.plist`);
}

function launchdLocalPlistPath(serviceName: string, installDir: string): string {
  return join(installDir, `${launchdLabel(serviceName)}.plist`);
}

function legacyLaunchAgentsPlistPath(serviceName: string): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${legacyLaunchdLabel(serviceName)}.plist`);
}

function legacyLocalPlistPath(serviceName: string, installDir: string): string {
  return join(installDir, `${legacyLaunchdLabel(serviceName)}.plist`);
}

export function legacyLaunchdPlistPaths(serviceName: string, installDir?: string): string[] {
  return legacyPlistPaths(serviceName, installDir);
}

function legacyPlistPaths(serviceName: string, installDir?: string): string[] {
  const paths = [legacyLaunchAgentsPlistPath(serviceName)];
  if (installDir) paths.push(legacyLocalPlistPath(serviceName, installDir));
  return paths;
}

async function bootoutLegacyLaunchd(serviceName: string, installDir?: string): Promise<void> {
  const uid = String(process.getuid?.() ?? 0);
  for (const path of legacyPlistPaths(serviceName, installDir)) {
    await runCommand('launchctl', ['bootout', `gui/${uid}`, path]).catch(() => null);
  }
}

/** bootout 旧 label 并删除旧 plist；只在旧文件真的存在时动手。返回被拆掉的 plist 路径。 */
export async function removeLegacyLaunchdJob(
  serviceName: string,
  installDir?: string,
  deps?: { run?: typeof runCommand }
): Promise<string[]> {
  const run = deps?.run ?? runCommand;
  const uid = String(process.getuid?.() ?? 0);
  const removed: string[] = [];
  for (const path of legacyPlistPaths(serviceName, installDir)) {
    if (!(await pathExists(path))) continue;
    await run('launchctl', ['bootout', `gui/${uid}`, path]).catch(() => null);
    await rm(path, { force: true }).catch(() => null);
    removed.push(path);
  }
  return removed;
}

/** 只有 serviceName 真的换了名字才需要拆旧 unit；同名时新内容直接原地覆盖。 */
async function removeLegacySystemdUnit(serviceName: string, legacyName?: string): Promise<void> {
  if (!legacyName || legacyName === serviceName) return;
  const unitPath = systemdUnitPath(legacyName);
  if (!(await pathExists(unitPath))) return;
  await runCommand('systemctl', ['--user', 'disable', '--now', legacyName]).catch(() => null);
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

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function buildLaunchdPlistFor(
  label: string,
  logBaseName: string,
  logEnvPrefix: string,
  { runScriptPath, installDir }: ServiceInstallOptions
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${escapeXml(runScriptPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(installDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>AbandonProcessGroup</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>${logEnvPrefix}_LOG_FILE</key>
    <string>${escapeXml(join(installDir, `${logBaseName}.log`))}</string>
    <key>${logEnvPrefix}_LOG_ERR_FILE</key>
    <string>${escapeXml(join(installDir, `${logBaseName}.err.log`))}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(join(installDir, `${logBaseName}.log`))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(join(installDir, `${logBaseName}.err.log`))}</string>
</dict>
</plist>
`;
}

export function buildLaunchdPlist(options: ServiceInstallOptions): string {
  return buildLaunchdPlistFor(launchdLabel(options.serviceName), 'vibeterm', 'VIBETERM', options);
}

/** 迁移回滚专用：写回改名前那份 plist（旧 label / 旧日志名 / 旧环境变量名）。 */
export function buildLegacyLaunchdPlist(options: ServiceInstallOptions): string {
  return buildLaunchdPlistFor(legacyLaunchdLabel(options.serviceName), 'tmex', 'TMEX', options);
}

async function installSystemdService(options: ServiceInstallOptions): Promise<void> {
  await removeLegacySystemdUnit(options.serviceName, options.legacyServiceName);
  const unitPath = systemdUnitPath(options.serviceName);
  await ensureDir(join(homedir(), '.config', 'systemd', 'user'));
  await writeText(unitPath, buildSystemdServiceContent(options));
  await ensureSystemdOomPolicyDropIn().catch(() => 'failed');

  const daemonReload = await runCommand('systemctl', ['--user', 'daemon-reload']);
  if (daemonReload.code !== 0) {
    throw new Error(
      t('service.systemd.daemonReloadFailed', {
        detail: daemonReload.stderr || daemonReload.stdout,
      })
    );
  }

  if (options.autostart) {
    const enable = await runCommand('systemctl', ['--user', 'enable', options.serviceName]);
    if (enable.code !== 0) {
      throw new Error(
        t('service.systemd.enableFailed', {
          detail: enable.stderr || enable.stdout,
        })
      );
    }
  }

  const restart = await runCommand('systemctl', ['--user', 'restart', options.serviceName]);
  if (restart.code !== 0) {
    throw new Error(
      t('service.systemd.restartFailed', {
        detail: restart.stderr || restart.stdout,
      })
    );
  }
}

async function installLaunchdService(options: ServiceInstallOptions): Promise<void> {
  const launchAgentsPath = launchdLaunchAgentsPlistPath(options.serviceName);
  const localPath = launchdLocalPlistPath(options.serviceName, options.installDir);
  const targetPath = options.autostart ? launchAgentsPath : localPath;

  if (options.autostart) {
    await ensureDir(join(homedir(), 'Library', 'LaunchAgents'));
  }

  // 换 label 前先把旧 job 拆干净：留着它 KeepAlive 会复活旧 run.sh，两个实例抢同一个端口。
  await removeLegacyLaunchdJob(options.serviceName, options.installDir);

  await writeText(targetPath, buildLaunchdPlist(options));

  // Ensure no duplicate jobs in this user domain.
  await runCommand('launchctl', [
    'bootout',
    `gui/${process.getuid?.() ?? 0}`,
    launchAgentsPath,
  ]).catch(() => null);
  await runCommand('launchctl', ['bootout', `gui/${process.getuid?.() ?? 0}`, localPath]).catch(
    () => null
  );

  const uid = String(process.getuid?.() ?? 0);
  const bootstrap = await runCommand('launchctl', ['bootstrap', `gui/${uid}`, targetPath]);
  if (bootstrap.code !== 0) {
    throw new Error(
      t('service.launchd.bootstrapFailed', {
        detail: bootstrap.stderr || bootstrap.stdout,
      })
    );
  }
}

/**
 * 回滚安装目录迁移时把 launchd job 还原成旧 label：留着新 label 会让 1.1.x 的 CLI
 * 找不到自己的 job，之后再升级会同时跑起两个实例抢端口。systemd 侧 unit 名不变，无需处理。
 */
export async function installLegacyLabelledService(options: ServiceInstallOptions): Promise<void> {
  const manager = await detectServiceManager();
  if (manager !== 'launchd') {
    await installService(options);
    return;
  }

  const uid = String(process.getuid?.() ?? 0);
  const newAgents = launchdLaunchAgentsPlistPath(options.serviceName);
  const newLocal = launchdLocalPlistPath(options.serviceName, options.installDir);
  for (const path of [newAgents, newLocal]) {
    await runCommand('launchctl', ['bootout', `gui/${uid}`, path]).catch(() => null);
    await rm(path, { force: true }).catch(() => null);
  }

  const targetPath = options.autostart
    ? legacyLaunchAgentsPlistPath(options.serviceName)
    : legacyLocalPlistPath(options.serviceName, options.installDir);
  if (options.autostart) {
    await ensureDir(join(homedir(), 'Library', 'LaunchAgents'));
  }
  await writeText(targetPath, buildLegacyLaunchdPlist(options));
  await runCommand('launchctl', ['bootout', `gui/${uid}`, targetPath]).catch(() => null);
  const bootstrap = await runCommand('launchctl', ['bootstrap', `gui/${uid}`, targetPath]);
  if (bootstrap.code !== 0) {
    throw new Error(
      t('service.launchd.bootstrapFailed', {
        detail: bootstrap.stderr || bootstrap.stdout,
      })
    );
  }
}

export async function installService(options: ServiceInstallOptions): Promise<void> {
  const manager = await detectServiceManager();

  if (manager === 'systemd-user') {
    await installSystemdService(options);
    return;
  }

  if (manager === 'launchd') {
    await installLaunchdService(options);
    return;
  }

  throw new Error(t('service.install.unsupportedPlatform', { platform: process.platform }));
}

async function stopSystemd(serviceName: string): Promise<void> {
  await runCommand('systemctl', ['--user', 'stop', serviceName]).catch(() => null);
}

export async function stopService(serviceName: string, installDir?: string): Promise<void> {
  const manager = await detectServiceManager();
  if (manager === 'systemd-user') {
    await stopSystemd(serviceName);
    return;
  }

  if (manager === 'launchd') {
    const uid = String(process.getuid?.() ?? 0);
    const launchAgentsPath = launchdLaunchAgentsPlistPath(serviceName);
    await runCommand('launchctl', ['bootout', `gui/${uid}`, launchAgentsPath]).catch(() => null);
    if (installDir) {
      const localPath = launchdLocalPlistPath(serviceName, installDir);
      await runCommand('launchctl', ['bootout', `gui/${uid}`, localPath]).catch(() => null);
    }
    // 升级时正在跑的可能仍是旧 label 的 job，不停掉它端口不会释放。
    await bootoutLegacyLaunchd(serviceName, installDir);
  }
}

export async function startService(serviceName: string, installDir?: string): Promise<void> {
  const manager = await detectServiceManager();
  if (manager === 'systemd-user') {
    const start = await runCommand('systemctl', ['--user', 'start', serviceName]);
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
    const uid = String(process.getuid?.() ?? 0);
    const launchAgentsPath = launchdLaunchAgentsPlistPath(serviceName);
    const localPath = installDir ? launchdLocalPlistPath(serviceName, installDir) : null;
    const targetPath = (await pathExists(launchAgentsPath))
      ? launchAgentsPath
      : localPath && (await pathExists(localPath))
        ? localPath
        : null;
    if (!targetPath) {
      throw new Error(t('service.launchd.bootstrapFailed', { detail: 'plist not found' }));
    }
    const bootstrap = await runCommand('launchctl', ['bootstrap', `gui/${uid}`, targetPath]);
    if (bootstrap.code !== 0) {
      throw new Error(
        t('service.launchd.bootstrapFailed', {
          detail: bootstrap.stderr || bootstrap.stdout,
        })
      );
    }
    return;
  }

  throw new Error(t('service.install.unsupportedPlatform', { platform: process.platform }));
}

async function uninstallSystemdService(serviceName: string): Promise<void> {
  await runCommand('systemctl', ['--user', 'disable', '--now', serviceName]).catch(() => null);
  const unitPath = systemdUnitPath(serviceName);
  if (await pathExists(unitPath)) {
    await rm(unitPath, { force: true });
  }
  await removeSystemdOomPolicyDropIn().catch(() => 'failed');
  await runCommand('systemctl', ['--user', 'daemon-reload']).catch(() => null);
}

export async function uninstallService(options: ServiceUninstallOptions): Promise<void> {
  const manager = await detectServiceManager();

  if (manager === 'systemd-user') {
    await uninstallSystemdService(options.serviceName);
    return;
  }

  if (manager === 'launchd') {
    const uid = String(process.getuid?.() ?? 0);
    const launchAgentsPath = launchdLaunchAgentsPlistPath(options.serviceName);
    await runCommand('launchctl', ['bootout', `gui/${uid}`, launchAgentsPath]).catch(() => null);
    await rm(launchAgentsPath, { force: true }).catch(() => null);

    if (options.installDir) {
      const localPath = launchdLocalPlistPath(options.serviceName, options.installDir);
      await runCommand('launchctl', ['bootout', `gui/${uid}`, localPath]).catch(() => null);
      await rm(localPath, { force: true }).catch(() => null);
    }
    await removeLegacyLaunchdJob(options.serviceName, options.installDir);
    return;
  }
}

async function querySystemdStatus(serviceName: string): Promise<ServiceStatus> {
  const unitPath = systemdUnitPath(serviceName);
  const installed = await pathExists(unitPath);

  const active = await runCommand('systemctl', ['--user', 'is-active', serviceName]).catch(
    () => null
  );
  const enabled = await runCommand('systemctl', ['--user', 'is-enabled', serviceName]).catch(
    () => null
  );

  return {
    manager: 'systemd-user',
    installed,
    running: active?.code === 0,
    autostartEnabled: enabled?.code === 0,
    detail: active?.stdout.trim() || enabled?.stdout.trim() || undefined,
  };
}

async function queryLaunchdStatus(
  serviceName: string,
  installDir?: string
): Promise<ServiceStatus> {
  const launchAgentsPath = launchdLaunchAgentsPlistPath(serviceName);
  const localPath = installDir ? launchdLocalPlistPath(serviceName, installDir) : null;
  const hasLaunchAgents = await pathExists(launchAgentsPath);
  const hasLocal = localPath ? await pathExists(localPath) : false;
  const installed = hasLaunchAgents || hasLocal;

  const uid = String(process.getuid?.() ?? 0);
  const label = launchdLabel(serviceName);
  const printed = await runCommand('launchctl', ['print', `gui/${uid}/${label}`]).catch(() => null);

  return {
    manager: 'launchd',
    installed,
    running: printed?.code === 0,
    autostartEnabled: hasLaunchAgents,
    detail: installed
      ? printed?.code === 0
        ? 'loaded'
        : (printed?.stderr || printed?.stdout || '').trim()
      : t('service.status.plistMissing'),
  };
}

export async function getServiceStatus(
  serviceName: string,
  installDir?: string
): Promise<ServiceStatus> {
  const manager = await detectServiceManager();

  if (manager === 'systemd-user') {
    return await querySystemdStatus(serviceName);
  }

  if (manager === 'launchd') {
    return await queryLaunchdStatus(serviceName, installDir);
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

export async function restartService(serviceName: string, installDir?: string): Promise<void> {
  const manager = await detectServiceManager();
  if (manager === 'systemd-user') {
    const restart = await runCommand('systemctl', ['--user', 'restart', serviceName]);
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
    const uid = String(process.getuid?.() ?? 0);
    const label = launchdLabel(serviceName);
    const kick = await runCommand('launchctl', ['kickstart', '-k', `gui/${uid}/${label}`]);
    if (kick.code === 0) {
      return;
    }

    const launchAgentsPath = launchdLaunchAgentsPlistPath(serviceName);
    const localPath = installDir ? launchdLocalPlistPath(serviceName, installDir) : null;
    const targetPath = (await pathExists(launchAgentsPath))
      ? launchAgentsPath
      : localPath && (await pathExists(localPath))
        ? localPath
        : null;
    if (!targetPath) {
      throw new Error(t('service.launchd.bootstrapFailed', { detail: kick.stderr || kick.stdout }));
    }
    await runCommand('launchctl', ['bootout', `gui/${uid}`, targetPath]).catch(() => null);
    const bootstrap = await runCommand('launchctl', ['bootstrap', `gui/${uid}`, targetPath]);
    if (bootstrap.code !== 0) {
      throw new Error(
        t('service.launchd.bootstrapFailed', {
          detail: bootstrap.stderr || bootstrap.stdout,
        })
      );
    }
    return;
  }

  throw new Error(t('service.install.unsupportedPlatform', { platform: process.platform }));
}

/** 迁移后残留的旧 label plist 路径（doctor 用），没有返回空数组。 */
export async function findLegacyLaunchdPlists(
  serviceNames: readonly string[],
  installDir?: string
): Promise<string[]> {
  if (process.platform !== 'darwin') return [];
  const found: string[] = [];
  for (const name of serviceNames) {
    for (const path of legacyPlistPaths(name, installDir)) {
      if (await pathExists(path)) found.push(path);
    }
  }
  return found;
}
