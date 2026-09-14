import { DEFAULT_SERVICE_NAME } from '../constants';
import { pathExists } from '../lib/fs-utils';
import { createInstallLayout } from '../lib/install-layout';
import { readJsonFile } from '../lib/json-file';
import { type ServiceManagerKind, detectServiceManager } from '../lib/platform';
import { restartService, startService, stopService } from '../lib/service';
import { asString } from '../lib/validate';
import type { InstallMeta, ParsedArgs } from '../types';
import type { CliIo } from './cli-io';

export const MANUAL_RESTART_HINT =
  'skipped service restart; restart VibeTerm manually to apply the change';

function log(io: CliIo | undefined, message: string): void {
  (io?.log ?? console.log)(message);
}

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

export async function maybeRestart(
  parsed: ParsedArgs,
  io: CliIo | undefined,
  installDir: string
): Promise<void> {
  if (parsed.flags['no-restart'] === true) {
    log(io, MANUAL_RESTART_HINT);
    return;
  }
  if (io?.restart) {
    const serviceName = await resolveServiceName(parsed, installDir);
    await io.restart(serviceName, installDir);
    return;
  }
  if (io?.skipRestart) return;
  const manager: ServiceManagerKind = io?.serviceManager ?? (await detectServiceManager());
  if (manager === 'none') {
    log(io, MANUAL_RESTART_HINT);
    return;
  }
  const serviceName = await resolveServiceName(parsed, installDir);
  await restartService(serviceName, installDir);
}

export async function maybeStop(
  parsed: ParsedArgs,
  io: CliIo | undefined,
  installDir: string,
  skipIfAuth = false
): Promise<void> {
  const stop = io?.stop ?? (io?.skipRestart || (skipIfAuth && io?.auth) ? undefined : stopService);
  if (!stop) return;
  await stop(await resolveServiceName(parsed, installDir), installDir);
}

export async function maybeStart(
  parsed: ParsedArgs,
  io: CliIo | undefined,
  installDir: string
): Promise<void> {
  const start = io?.start ?? (io?.skipRestart || io?.auth ? undefined : startService);
  if (!start) return;
  await start(await resolveServiceName(parsed, installDir), installDir);
}
