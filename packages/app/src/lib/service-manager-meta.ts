import type { InstallMeta } from '../types';
import { type ServiceManagerKind, detectServiceManager } from './platform';

/**
 * 升级落盘 install-meta 时刷新服务管理器：--no-service 安装记 none；托管安装重新探测，
 * 探测不到（如 SSH 会话没有 user bus）时保留旧值，不把已知的管理器抹成 none。
 */
export async function refreshServiceManager(
  meta: Pick<InstallMeta, 'serviceMode' | 'serviceManager'>,
  detect: () => Promise<ServiceManagerKind> = detectServiceManager
): Promise<ServiceManagerKind | undefined> {
  if (meta.serviceMode === 'none') return 'none';
  const detected = await detect().catch((): ServiceManagerKind => 'none');
  if (detected !== 'none') return detected;
  return meta.serviceManager;
}
