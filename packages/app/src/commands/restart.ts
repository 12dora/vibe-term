import { DEFAULT_SERVICE_NAME } from '../constants';
import { pathExists } from '../lib/fs-utils';
import { createInstallLayout } from '../lib/install-layout';
import { readJsonFile } from '../lib/json-file';
import { type ServiceManagerKind, detectServiceManager } from '../lib/platform';
import { restartService } from '../lib/service';
import { asString } from '../lib/validate';
import type { InstallMeta, ParsedArgs } from '../types';
import type { CliIo } from './cli-io';

export async function resolveServiceName(parsed: ParsedArgs, installDir: string): Promise<string> {
  let serviceName = asString(parsed.flags['service-name']) || DEFAULT_SERVICE_NAME;
  if (!installDir) return serviceName;
  const layout = createInstallLayout(installDir);
  if (await pathExists(layout.metaPath)) {
    const meta = await readJsonFile<InstallMeta>(layout.metaPath);
    serviceName = meta.serviceName;
  }
  return serviceName;
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
  const manager: ServiceManagerKind = io?.serviceManager ?? (await detectServiceManager());
  if (manager === 'none') return 'manual';
  const serviceName = await resolveServiceName(parsed, installDir);
  await restartService(serviceName, installDir);
  return 'restarted';
}
