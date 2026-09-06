// launchd 侧的服务注册：label 推导、plist 生成、bootout / bootstrap 与状态查询。
//
// 改名期间同一台机器上可能同时存在两组注册：新 `com.vibeterm.<服务名>` 与旧 `com.tmex.<服务名>`，
// 服务名本身还可能从 `tmex` 迁到 `vibeterm`。装任何一组之前都要把另外几组拆干净，否则 KeepAlive
// 会把旧 run.sh 拉起来，两个实例抢同一个端口。
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { t } from '../i18n';
import { ensureDir, pathExists, writeText } from './fs-utils';
import { runCommand } from './process';
import type {
  ServiceDeps,
  ServiceIdentityOptions,
  ServiceInstallOptions,
  ServiceStatus,
} from './service-types';

const LABEL_PREFIX = 'com.vibeterm.';
/** 协议外的历史前缀，全网升级到 ≥ 2.0 之前必须继续识别 */
const LEGACY_LABEL_PREFIX = 'com.tmex.';

const UNLOAD_TIMEOUT_MS = 10_000;
const UNLOAD_POLL_MS = 100;

export function launchdLabel(serviceName: string): string {
  return `${LABEL_PREFIX}${serviceName}`;
}

export function legacyLaunchdLabel(serviceName: string): string {
  return `${LEGACY_LABEL_PREFIX}${serviceName}`;
}

function currentUid(): string {
  return String(process.getuid?.() ?? 0);
}

function agentsPlistPath(label: string, homeDir = homedir()): string {
  return join(homeDir, 'Library', 'LaunchAgents', `${label}.plist`);
}

function localPlistPath(label: string, installDir: string): string {
  return join(installDir, `${label}.plist`);
}

function plistPathsFor(label: string, installDir?: string, homeDir?: string): string[] {
  const paths = [agentsPlistPath(label, homeDir)];
  if (installDir) paths.push(localPlistPath(label, installDir));
  return paths;
}

export function launchdLaunchAgentsPlistPath(serviceName: string, homeDir?: string): string {
  return agentsPlistPath(launchdLabel(serviceName), homeDir);
}

export function launchdLocalPlistPath(serviceName: string, installDir: string): string {
  return localPlistPath(launchdLabel(serviceName), installDir);
}

export function legacyLaunchdPlistPaths(
  serviceName: string,
  installDir?: string,
  homeDir?: string
): string[] {
  return plistPathsFor(legacyLaunchdLabel(serviceName), installDir, homeDir);
}

function uniqueNames(...names: (string | undefined)[]): string[] {
  return [...new Set(names.filter((name): name is string => Boolean(name)))];
}

/** 一个服务名在改名期间可能占用的两个 label */
function labelsFor(serviceName: string): string[] {
  return [launchdLabel(serviceName), legacyLaunchdLabel(serviceName)];
}

/**
 * 先按 plist 路径 bootout（解除文件关联），再按 label 兜底。
 * 现网见过 plist 文件已被删、job 仍在 launchd 域里跑的机器：只按路径 bootout 会静默失败，
 * 旧进程继续占着端口，随后的 bootstrap 必然失败。
 */
export async function bootoutLaunchdJob(
  label: string,
  paths: readonly string[],
  deps?: ServiceDeps
): Promise<void> {
  const run = deps?.run ?? runCommand;
  const uid = currentUid();
  for (const path of paths) {
    await run('launchctl', ['bootout', `gui/${uid}`, path]).catch(() => null);
  }
  await run('launchctl', ['bootout', `gui/${uid}/${label}`]).catch(() => null);
}

export async function isLaunchdJobLoaded(label: string, deps?: ServiceDeps): Promise<boolean> {
  const run = deps?.run ?? runCommand;
  const printed = await run('launchctl', ['print', `gui/${currentUid()}/${label}`]).catch(
    () => null
  );
  return printed?.code === 0;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 等到给定 label 都不在 launchd 域里；超时返回 false，由调用方决定是否报错。 */
export async function waitForLaunchdUnloaded(
  labels: readonly string[],
  timeoutMs = UNLOAD_TIMEOUT_MS,
  deps?: ServiceDeps
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let loaded = false;
    for (const label of labels) {
      if (await isLaunchdJobLoaded(label, deps)) {
        loaded = true;
        break;
      }
    }
    if (!loaded) return true;
    if (Date.now() >= deadline) return false;
    await sleepMs(UNLOAD_POLL_MS);
  }
}

/** bootout 旧 label 并删除旧 plist。返回被删掉的 plist 路径（没有文件也照样 bootout）。 */
export async function removeLegacyLaunchdJob(
  serviceName: string,
  installDir?: string,
  deps?: ServiceDeps
): Promise<string[]> {
  // 测试必须注入 homeDir：默认会扫描真实 ~/Library/LaunchAgents 并删除生产 plist。
  const paths = legacyLaunchdPlistPaths(serviceName, installDir, deps?.homeDir);
  await bootoutLaunchdJob(legacyLaunchdLabel(serviceName), paths, deps);
  const removed: string[] = [];
  for (const path of paths) {
    if (!(await pathExists(path))) continue;
    await rm(path, { force: true }).catch(() => null);
    removed.push(path);
  }
  return removed;
}

/**
 * 拆掉除 keepLabel 之外的所有注册：两个 label 前缀 × 新旧两个服务名。
 * 正向安装 keepLabel 是 `com.vibeterm.<新名>`，因此会清掉 `com.tmex.<旧名>`；
 * 迁移回滚时 keepLabel 是 `com.tmex.<旧名>`，于是清掉的是 `com.vibeterm.<新名>`。
 */
export async function removeOtherLaunchdRegistrations(opts: {
  keepLabel: string;
  serviceNames: readonly string[];
  installDir?: string;
  deps?: ServiceDeps;
}): Promise<string[]> {
  const removed: string[] = [];
  for (const name of uniqueNames(...opts.serviceNames)) {
    for (const label of labelsFor(name)) {
      if (label === opts.keepLabel) continue;
      const paths = plistPathsFor(label, opts.installDir, opts.deps?.homeDir);
      await bootoutLaunchdJob(label, paths, opts.deps);
      for (const path of paths) {
        if (!(await pathExists(path))) continue;
        await rm(path, { force: true }).catch(() => null);
        removed.push(path);
      }
    }
  }
  return removed;
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

async function bootstrapLaunchd(targetPath: string, deps?: ServiceDeps): Promise<void> {
  const run = deps?.run ?? runCommand;
  const bootstrap = await run('launchctl', ['bootstrap', `gui/${currentUid()}`, targetPath]);
  if (bootstrap.code !== 0) {
    throw new Error(
      t('service.launchd.bootstrapFailed', {
        detail: bootstrap.stderr || bootstrap.stdout,
      })
    );
  }
}

async function installPlist(opts: {
  options: ServiceInstallOptions;
  label: string;
  content: string;
  deps?: ServiceDeps;
}): Promise<void> {
  const { options, label, deps } = opts;
  const agents = agentsPlistPath(label, deps?.homeDir);
  const local = localPlistPath(label, options.installDir);
  const targetPath = options.autostart ? agents : local;

  await removeOtherLaunchdRegistrations({
    keepLabel: label,
    serviceNames: [options.serviceName, options.legacyServiceName ?? ''],
    installDir: options.installDir,
    deps,
  });

  if (options.autostart) await ensureDir(dirname(agents));
  await writeText(targetPath, opts.content);
  // 同一 label 可能已在域里（上一次安装或崩溃残留），bootstrap 前先拆掉两个位置的注册。
  await bootoutLaunchdJob(label, [agents, local], deps);
  await bootstrapLaunchd(targetPath, deps);
}

export async function installLaunchdService(
  options: ServiceInstallOptions,
  deps?: ServiceDeps
): Promise<void> {
  await installPlist({
    options,
    label: launchdLabel(options.serviceName),
    content: buildLaunchdPlist(options),
    deps,
  });
}

/**
 * 回滚安装迁移时把 launchd job 还原成旧 label：留着新 label 会让 1.1.x 的 CLI 找不到自己的 job，
 * 之后再升级会同时跑起两个实例抢端口。
 */
export async function installLegacyLabelledLaunchdService(
  options: ServiceInstallOptions,
  deps?: ServiceDeps
): Promise<void> {
  await installPlist({
    options,
    label: legacyLaunchdLabel(options.serviceName),
    content: buildLegacyLaunchdPlist(options),
    deps,
  });
}

export async function stopLaunchdService(
  serviceName: string,
  installDir?: string,
  opts?: ServiceIdentityOptions & { timeoutMs?: number }
): Promise<void> {
  const labels: string[] = [];
  for (const name of uniqueNames(serviceName, opts?.legacyServiceName)) {
    for (const label of labelsFor(name)) {
      labels.push(label);
      await bootoutLaunchdJob(
        label,
        plistPathsFor(label, installDir, opts?.deps?.homeDir),
        opts?.deps
      );
    }
  }
  // launchctl bootout 可能先于进程退出返回；等到所有 label 都不在域里再交还控制权。
  await waitForLaunchdUnloaded(labels, opts?.timeoutMs ?? UNLOAD_TIMEOUT_MS, opts?.deps);
}

async function existingPlistPath(
  serviceName: string,
  installDir?: string,
  deps?: ServiceDeps
): Promise<string | null> {
  const agents = launchdLaunchAgentsPlistPath(serviceName, deps?.homeDir);
  if (await pathExists(agents)) return agents;
  if (!installDir) return null;
  const local = launchdLocalPlistPath(serviceName, installDir);
  return (await pathExists(local)) ? local : null;
}

export async function startLaunchdService(
  serviceName: string,
  installDir?: string,
  deps?: ServiceDeps
): Promise<void> {
  const targetPath = await existingPlistPath(serviceName, installDir, deps);
  if (!targetPath) {
    throw new Error(t('service.launchd.bootstrapFailed', { detail: 'plist not found' }));
  }
  await bootstrapLaunchd(targetPath, deps);
}

export async function restartLaunchdService(
  serviceName: string,
  installDir?: string,
  deps?: ServiceDeps
): Promise<void> {
  const run = deps?.run ?? runCommand;
  const label = launchdLabel(serviceName);
  const kick = await run('launchctl', ['kickstart', '-k', `gui/${currentUid()}/${label}`]);
  if (kick.code === 0) return;

  const targetPath = await existingPlistPath(serviceName, installDir, deps);
  if (!targetPath) {
    throw new Error(t('service.launchd.bootstrapFailed', { detail: kick.stderr || kick.stdout }));
  }
  await bootoutLaunchdJob(label, [targetPath], deps);
  await bootstrapLaunchd(targetPath, deps);
}

export async function uninstallLaunchdService(
  serviceName: string,
  installDir?: string,
  deps?: ServiceDeps
): Promise<void> {
  const paths = plistPathsFor(launchdLabel(serviceName), installDir, deps?.homeDir);
  await bootoutLaunchdJob(launchdLabel(serviceName), paths, deps);
  for (const path of paths) {
    await rm(path, { force: true }).catch(() => null);
  }
  await removeLegacyLaunchdJob(serviceName, installDir, deps);
}

export async function queryLaunchdStatus(
  serviceName: string,
  installDir?: string,
  opts?: ServiceIdentityOptions
): Promise<ServiceStatus> {
  const agents = launchdLaunchAgentsPlistPath(serviceName, opts?.deps?.homeDir);
  const local = installDir ? launchdLocalPlistPath(serviceName, installDir) : null;
  const hasLaunchAgents = await pathExists(agents);
  const installed = hasLaunchAgents || (local ? await pathExists(local) : false);

  const run = opts?.deps?.run ?? runCommand;
  const printed = await run('launchctl', [
    'print',
    `gui/${currentUid()}/${launchdLabel(serviceName)}`,
  ]).catch(() => null);
  // 升级中途仍可能是改名前的 label（或改名前的服务名）在跑：只看新 label 会把「没停下」误判成「未运行」。
  const others = uniqueNames(serviceName, opts?.legacyServiceName)
    .flatMap(labelsFor)
    .filter((label) => label !== launchdLabel(serviceName));
  let running = printed?.code === 0;
  for (const label of others) {
    if (running) break;
    running = await isLaunchdJobLoaded(label, opts?.deps);
  }

  return {
    manager: 'launchd',
    installed,
    running,
    autostartEnabled: hasLaunchAgents,
    detail: installed
      ? running
        ? 'loaded'
        : (printed?.stderr || printed?.stdout || '').trim()
      : t('service.status.plistMissing'),
  };
}

/** 迁移后残留的旧 label plist 路径（doctor 用），没有返回空数组。 */
export async function findLegacyLaunchdPlists(
  serviceNames: readonly string[],
  installDir?: string
): Promise<string[]> {
  if (process.platform !== 'darwin') return [];
  const found: string[] = [];
  for (const name of serviceNames) {
    for (const path of legacyLaunchdPlistPaths(name, installDir)) {
      if (await pathExists(path)) found.push(path);
    }
  }
  return found;
}
