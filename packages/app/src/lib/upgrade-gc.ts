import { readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathExists } from './fs-utils';
import { currentLinkPath, readCurrentVersion, versionDirPath } from './upgrade-switch';

async function resolvedCurrentDir(installDir: string): Promise<string | null> {
  const version = await readCurrentVersion(installDir);
  if (!version) return null;
  return resolve(versionDirPath(installDir, version));
}

export async function safeRemoveDir(installDir: string, target: string): Promise<void> {
  const resolved = resolve(target);
  const current = await resolvedCurrentDir(installDir);
  if (current && resolved === current) {
    throw new Error(`refusing to delete current version directory: ${target}`);
  }
  const link = resolve(currentLinkPath(installDir));
  if (resolved === link) {
    throw new Error(`refusing to delete current symlink: ${target}`);
  }
  await rm(target, { recursive: true, force: true });
}

export async function pruneVersions(
  installDir: string,
  keep: { current: string; previous?: string | null }
): Promise<void> {
  const versionsDir = join(installDir, 'versions');
  if (!(await pathExists(versionsDir))) return;
  const keepSet = new Set([keep.current]);
  if (keep.previous) keepSet.add(keep.previous);
  const entries = await readdir(versionsDir);
  for (const name of entries) {
    if (keepSet.has(name)) continue;
    await safeRemoveDir(installDir, join(versionsDir, name));
  }
}

export async function removeTxnDirs(installDir: string, txnId: string): Promise<void> {
  await rm(join(installDir, 'staging', txnId), { recursive: true, force: true }).catch(() => null);
  await rm(join(installDir, 'backups', txnId), { recursive: true, force: true }).catch(() => null);
}

const LEGACY_TOP_LEVEL = ['cli', 'runtime', 'resources', 'native'] as const;

export async function removeLegacyTopLevelDirs(installDir: string): Promise<void> {
  const current = await readCurrentVersion(installDir);
  if (!current) return;
  const currentResolved = resolve(versionDirPath(installDir, current));
  for (const name of LEGACY_TOP_LEVEL) {
    const path = join(installDir, name);
    if (!(await pathExists(path))) continue;
    if (resolve(path) === currentResolved) continue;
    await rm(path, { recursive: true, force: true });
  }
}

const PROTECTED_NAMES = new Set(['data', 'current', 'app.env', 'install-meta.json', 'run.sh']);

function isInstallTmpLeftover(name: string): boolean {
  if (PROTECTED_NAMES.has(name)) return false;
  if (!name.endsWith('.tmp')) return false;
  return (
    name.startsWith('upgrade-state.json.') ||
    name.startsWith('current.') ||
    name.startsWith('run.sh.') ||
    name.startsWith('tmex.')
  );
}

export async function sweepTmpLeftovers(dir: string): Promise<void> {
  if (!(await pathExists(dir))) return;
  const entries = await readdir(dir);
  for (const name of entries) {
    if (!isInstallTmpLeftover(name)) continue;
    await rm(join(dir, name), { recursive: true, force: true }).catch(() => null);
  }
}

export async function sweepOrphanStaging(
  installDir: string,
  keepTxnId?: string | null
): Promise<void> {
  const staging = join(installDir, 'staging');
  if (!(await pathExists(staging))) return;
  const current = await resolvedCurrentDir(installDir);
  const dataDir = resolve(join(installDir, 'data'));
  for (const name of await readdir(staging)) {
    if (keepTxnId && name === keepTxnId) continue;
    const target = join(staging, name);
    const resolved = resolve(target);
    if (current && resolved === current) continue;
    if (resolved === dataDir) continue;
    await rm(target, { recursive: true, force: true }).catch(() => null);
  }
}

export async function sweepUpgradeGarbage(
  installDir: string,
  opts?: { keepTxnId?: string | null; shimDirs?: string[] }
): Promise<void> {
  await sweepOrphanStaging(installDir, opts?.keepTxnId);
  await sweepTmpLeftovers(installDir);
  for (const dir of opts?.shimDirs ?? []) {
    await sweepTmpLeftovers(dir);
  }
}

export async function finishCommittedCleanup(
  installDir: string,
  keep: { current: string; previous?: string | null }
): Promise<void> {
  await pruneVersions(installDir, keep);
  await removeLegacyTopLevelDirs(installDir);
}
