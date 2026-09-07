import type { InstallMeta } from '../types';
import { writeInstallMeta } from './install';
import { createInstallLayout } from './install-layout';
import { readJsonFile } from './json-file';
import { readRepairInstallMeta } from './upgrade-legacy';

export type RepairMetaOptions = {
  repairServiceName?: string;
  repairNoService?: boolean;
};

export async function resolveRepairMeta(
  installDir: string,
  options: RepairMetaOptions = {},
  bunPath?: string
): Promise<{ meta: InstallMeta; rebuilt: boolean } | null> {
  const recovered = await readRepairInstallMeta(installDir, bunPath);
  if (!recovered?.rebuilt) return recovered;
  const raw = await readJsonFile<Partial<InstallMeta> | null>(
    createInstallLayout(installDir).metaPath
  ).catch(() => null);
  const serviceName =
    typeof raw?.serviceName === 'string' && raw.serviceName.trim()
      ? raw.serviceName
      : options.repairServiceName?.trim();
  const serviceMode =
    raw?.serviceMode === 'none' || raw?.serviceMode === 'managed'
      ? raw.serviceMode
      : options.repairNoService
        ? 'none'
        : serviceName
          ? 'managed'
          : null;
  if (!serviceMode || (serviceMode === 'managed' && !serviceName)) {
    throw new Error(
      'install-meta.json service identity is unavailable. Retry upgrade --repair with ' +
        '--service-name <existing-service-name> for a managed service, or --no-service ' +
        'for an installation originally created without a service.'
    );
  }
  return {
    rebuilt: true,
    meta: {
      ...recovered.meta,
      serviceName: serviceName ?? recovered.meta.serviceName,
      serviceMode,
    },
  };
}

export async function readInstallMeta(
  installDir: string,
  bunPath: string,
  deps: RepairMetaOptions,
  serviceName?: string
): Promise<InstallMeta | null> {
  const recovered = await resolveRepairMeta(installDir, deps, bunPath);
  if (!recovered) return null;
  return { ...recovered.meta, serviceName: serviceName ?? recovered.meta.serviceName };
}

export async function persistRepairMeta(
  installDir: string,
  bunPath: string,
  deps: RepairMetaOptions,
  log: (message: string) => void,
  serviceName?: string
): Promise<void> {
  const recovered = await resolveRepairMeta(installDir, deps, bunPath);
  if (!recovered?.rebuilt) return;
  await writeInstallMeta(createInstallLayout(installDir), {
    ...recovered.meta,
    serviceName: serviceName ?? recovered.meta.serviceName,
  });
  log(`install-meta.json rebuilt from current: ${recovered.meta.cliVersion}`);
}
