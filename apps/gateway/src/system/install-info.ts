import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { GatewayDeployment, InstallSource } from '@vibeterm/shared';
import { config } from '../config';

/** install-meta.json 形状（由 vibeterm-cli init/upgrade 写入） */
export interface InstallMetaShape {
  serviceName?: string;
  platform?: string;
  autostart?: boolean;
  installDir?: string;
  updatedAt?: string;
  cliVersion?: string;
  bunPath?: string;
  installSource?: string;
  serviceManager?: string;
  serviceMode?: string;
  openrcSudoers?: boolean;
}

export interface InstallInfo {
  installedViaCli: boolean;
  /** 安装来源；`getInstallInfo` 恒会给出，测试替身可省。 */
  installSource?: InstallSource;
  deployment: GatewayDeployment;
  installDir: string | null;
  serviceName: string | null;
  cliVersion: string | null;
  bunPath: string | null;
  /** OpenRC：安装用户能否免密 `rc-service <服务名> …`；缺省按不能处理。 */
  openrcSudoers?: boolean;
}

/** 非 root 的 OpenRC 节点只能经 sudo 控制系统服务；没有就绪的免密规则就不能无 TTY 自更新。 */
export function openrcSelfUpdateBlocked(
  install: Pick<InstallInfo, 'deployment' | 'openrcSudoers'>,
  euid: number | undefined = process.geteuid?.()
): boolean {
  if (install.deployment !== 'openrc' || euid === 0) return false;
  return install.openrcSudoers !== true;
}

/** 卸载要 rc-update del 与删 /etc 下的文件，免密规则不覆盖：非 root 的 OpenRC 节点只能在终端卸。 */
export function openrcRemoteUninstallBlocked(
  install: Pick<InstallInfo, 'deployment'>,
  euid: number | undefined = process.geteuid?.()
): boolean {
  return install.deployment === 'openrc' && euid !== 0;
}

/**
 * 反推安装目录：优先由 run.sh export 的 VIBETERM_FE_DIST_DIR
 * （= installDir/resources/fe-dist）上溯两级，回退到 cwd（服务 WorkingDirectory=installDir）。
 */
export function resolveInstallDir(): string {
  const explicit = process.env.VIBETERM_INSTALL_DIR;
  if (explicit) return resolve(explicit);
  const feDist = process.env.VIBETERM_FE_DIST_DIR;
  if (feDist) {
    const resourcesParent = resolve(feDist, '..', '..');
    if (basename(resourcesParent) === 'current') return resolve(resourcesParent, '..');
    if (basename(resolve(resourcesParent, '..')) === 'versions') {
      return resolve(resourcesParent, '..', '..');
    }
    return resourcesParent;
  }
  return process.cwd();
}

export function readInstallMeta(): InstallMetaShape | null {
  const metaPath = resolve(resolveInstallDir(), 'install-meta.json');
  try {
    if (!existsSync(metaPath)) return null;
    return JSON.parse(readFileSync(metaPath, 'utf8')) as InstallMetaShape;
  } catch {
    return null;
  }
}

const INSTALL_SOURCES: readonly InstallSource[] = ['install-script', 'npx', 'cli', 'manual'];

/** install-meta 里没记来源的老安装一律按 `cli`：有 meta 就说明是 CLI 落的盘。 */
export function installSourceFromMeta(meta: InstallMetaShape | null): InstallSource {
  if (!meta) return 'manual';
  const recorded = meta.installSource;
  return INSTALL_SOURCES.find((source) => source === recorded) ?? 'cli';
}

function deploymentFromPlatform(platform: string | undefined): GatewayDeployment {
  if (platform === 'darwin') return 'launchd';
  if (platform === 'linux') return 'systemd';
  return 'none';
}

function deploymentFromServiceManager(manager: string): GatewayDeployment | undefined {
  switch (manager) {
    case 'systemd-user':
      return 'systemd';
    case 'launchd':
      return 'launchd';
    case 'openrc':
      return 'openrc';
    case 'none':
      return 'none';
    default:
      return undefined;
  }
}

/** launchd / systemd / openrc 视为托管部署；未知值按托管处理，避免旧客户端对新增枚举崩溃。 */
export function isManagedDeployment(deployment: string): boolean {
  switch (deployment) {
    case 'launchd':
    case 'systemd':
    case 'openrc':
      return true;
    case 'none':
      return false;
    default:
      return true;
  }
}

/**
 * 从 install-meta 推导部署方式。`serviceMode=none` 优先；有 `serviceManager` 时按它映射，
 * 缺省（老 meta）才回退平台启发式。
 */
export function deploymentFromMeta(
  meta: Pick<InstallMetaShape, 'serviceManager' | 'serviceMode' | 'platform'>,
  fallbackPlatform: string = process.platform
): GatewayDeployment {
  if (meta.serviceMode === 'none') return 'none';
  if (meta.serviceManager) {
    const mapped = deploymentFromServiceManager(meta.serviceManager);
    if (mapped) return mapped;
  }
  return deploymentFromPlatform(meta.platform ?? fallbackPlatform);
}

/**
 * 判定安装方式。仅 production 才可能存在 CLI 安装产物（install-meta.json）；
 * dev/test 一律视为非 CLI（自更新本就在非 production 禁用）。
 * production 下无 install-meta（手动部署）→ 非 CLI 安装。
 */
export function getInstallInfo(): InstallInfo {
  if (!config.isProd) {
    return {
      installedViaCli: false,
      installSource: 'manual',
      deployment: 'none',
      installDir: null,
      serviceName: null,
      cliVersion: null,
      bunPath: null,
    };
  }

  const meta = readInstallMeta();
  if (!meta) {
    return {
      installedViaCli: false,
      installSource: 'manual',
      deployment: 'none',
      installDir: resolveInstallDir(),
      serviceName: null,
      cliVersion: null,
      bunPath: null,
    };
  }

  return {
    installedViaCli: true,
    installSource: installSourceFromMeta(meta),
    deployment: deploymentFromMeta(meta),
    installDir: meta.installDir ?? resolveInstallDir(),
    serviceName: meta.serviceName ?? null,
    cliVersion: meta.cliVersion ?? null,
    bunPath: meta.bunPath ?? null,
    openrcSudoers: meta.openrcSudoers === true,
  };
}
