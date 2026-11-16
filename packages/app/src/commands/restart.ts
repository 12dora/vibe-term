import { DEFAULT_SERVICE_NAME } from '../constants';
import { pathExists } from '../lib/fs-utils';
import { createInstallLayout } from '../lib/install-layout';
import { readJsonFile } from '../lib/json-file';
import { type ServiceManagerKind, detectServiceManager } from '../lib/platform';
import { restartService } from '../lib/service';
import { recordedManagerDeps } from '../lib/service-manager-meta';
import { asString } from '../lib/validate';
import type { InstallMeta, ParsedArgs } from '../types';
import type { CliIo } from './cli-io';

async function readMeta(installDir: string): Promise<InstallMeta | null> {
  if (!installDir) return null;
  const layout = createInstallLayout(installDir);
  if (!(await pathExists(layout.metaPath))) return null;
  return await readJsonFile<InstallMeta>(layout.metaPath);
}

export async function resolveServiceName(parsed: ParsedArgs, installDir: string): Promise<string> {
  const meta = await readMeta(installDir);
  return meta?.serviceName ?? (asString(parsed.flags['service-name']) || DEFAULT_SERVICE_NAME);
}

/**
 * --no-service 安装由用户自己托管进程，不能顺手去重启宿主机服务管理器里的别的实例；
 * 否则 install-meta 记录的管理器优先于现场探测。
 */
export async function resolveRestartManager(
  injected: ServiceManagerKind | undefined,
  meta: Pick<InstallMeta, 'serviceMode' | 'serviceManager'> | null,
  detect: () => Promise<ServiceManagerKind> = detectServiceManager
): Promise<ServiceManagerKind> {
  if (meta?.serviceMode === 'none') return 'none';
  return injected ?? recordedManagerDeps(meta?.serviceManager).manager ?? (await detect());
}

/** `restarted` 已重启；`manual` 需要用户手动重启（旗标或平台没有服务管理器）；`skipped` 由调用方自己处理。 */
export type RestartOutcome = 'restarted' | 'manual' | 'skipped';

/** 只执行重启并报告结果，不打印提示——调用方在最后一行统一告诉用户要不要手动重启。 */
export async function maybeRestart(
  parsed: ParsedArgs,
  io: CliIo | undefined,
  installDir: string
): Promise<RestartOutcome> {
  if (parsed.flags['no-restart'] === true) return 'manual';
  if (io?.restart) {
    const serviceName = await resolveServiceName(parsed, installDir);
    await io.restart(serviceName, installDir);
    return 'restarted';
  }
  if (io?.skipRestart) return 'skipped';
  const meta = await readMeta(installDir).catch(() => null);
  const manager = await resolveRestartManager(io?.serviceManager, meta);
  if (manager === 'none') return 'manual';
  const serviceName = await resolveServiceName(parsed, installDir);
  await restartService(serviceName, installDir, { manager });
  return 'restarted';
}
