import type { InstallMeta } from '../types';
import { type ServiceManagerKind, detectServiceManager } from './platform';
import { openrcControlReady } from './service-openrc';

/**
 * 升级 / 修复落盘 install-meta 时补齐服务管理器：--no-service 安装记 none；已记录的托管管理器
 * 原样保留（换个会话探测可能失真，如没有 user bus 的 su 会话）；老 meta 缺这一项时才探测。
 */
export async function refreshServiceManager(
  meta: Pick<InstallMeta, 'serviceMode' | 'serviceManager'>,
  detect: () => Promise<ServiceManagerKind> = detectServiceManager
): Promise<ServiceManagerKind | undefined> {
  if (meta.serviceMode === 'none') return 'none';
  if (meta.serviceManager && meta.serviceManager !== 'none') return meta.serviceManager;
  const detected = await detect().catch((): ServiceManagerKind => 'none');
  return detected !== 'none' ? detected : meta.serviceManager;
}

export interface ServiceMetaDeps {
  detect?: () => Promise<ServiceManagerKind>;
  controlReady?: (serviceName: string) => Promise<boolean>;
}

/** 同时刷新 `openrcSudoers`：网关据此判断非 root 的 OpenRC 节点能否无 TTY 自更新。 */
export async function refreshServiceMeta(
  meta: Pick<InstallMeta, 'serviceMode' | 'serviceManager' | 'serviceName'>,
  deps: ServiceMetaDeps = {}
): Promise<Pick<InstallMeta, 'serviceManager' | 'openrcSudoers'>> {
  const serviceManager = await refreshServiceManager(meta, deps.detect);
  if (serviceManager !== 'openrc') return { serviceManager, openrcSudoers: undefined };
  const ready = deps.controlReady ?? ((name: string) => openrcControlReady(name));
  const openrcSudoers = await ready(meta.serviceName).catch(() => false);
  return { serviceManager, openrcSudoers };
}

/** install-meta 记录的托管管理器优先于现场探测；`none` / 缺省交给探测。 */
export function recordedManagerDeps(manager: ServiceManagerKind | undefined): {
  manager?: ServiceManagerKind;
} {
  return manager && manager !== 'none' ? { manager } : {};
}
