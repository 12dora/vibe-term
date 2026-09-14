import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { t } from '../i18n';
import { mergeMissingKeys, readEnvFile, writeEnvFile } from './env-file';
import { ensureDir, pathExists, writeText } from './fs-utils';
import { peerEnvDefaults, rewriteLegacyHubInstallEnv } from './install';
import { createInstallLayout } from './install-layout';

export type MigrateHubEnvResult = {
  migrated: boolean;
  roleRewritten: boolean;
  hubKeysDeleted: number;
  /** 相对安装目录的可读备份名（`backups/app.env.<ISO>.hub`），日志用 */
  backupPath?: string;
};

function isHubEnvKey(key: string): boolean {
  return key.startsWith('VIBETERM_HUB_') || key.startsWith('TMEX_HUB_');
}

function hubRewriteDelta(existing: Record<string, string>, rewritten: Record<string, string>) {
  const hubKeysDeleted = Object.keys(existing).filter(isHubEnvKey).length;
  const roleRewritten =
    existing.VIBETERM_ROLES !== rewritten.VIBETERM_ROLES ||
    existing.TMEX_ROLES !== rewritten.TMEX_ROLES;
  return { hubKeysDeleted, roleRewritten, migrated: hubKeysDeleted > 0 || roleRewritten };
}

/**
 * 升级时把残留 `hub,node` 写成 `node`，并丢掉全部 `VIBETERM_HUB_*` / `TMEX_HUB_*`。
 * 可读备份只记相对名；事务级还原走 `backups/<txnId>/app.env`（见 backupEnvFile）。
 */
export async function migrateHubEnv(envPath: string): Promise<MigrateHubEnvResult> {
  if (!(await pathExists(envPath))) {
    return { migrated: false, roleRewritten: false, hubKeysDeleted: 0 };
  }

  const existing = await readEnvFile(envPath);
  const rewritten = rewriteLegacyHubInstallEnv(existing);
  const delta = hubRewriteDelta(existing, rewritten);
  const { next, added } = mergeMissingKeys(rewritten, peerEnvDefaults());
  const changed =
    added.length > 0 ||
    Object.keys(next).length !== Object.keys(existing).length ||
    Object.entries(next).some(([key, value]) => existing[key] !== value);
  if (!changed) {
    return { migrated: false, roleRewritten: false, hubKeysDeleted: 0 };
  }

  let backupPath: string | undefined;
  if (delta.migrated) {
    backupPath = join('backups', `app.env.${new Date().toISOString()}.hub`);
    const backupAbs = join(dirname(envPath), backupPath);
    await ensureDir(dirname(backupAbs));
    await writeText(backupAbs, await readFile(envPath, 'utf8'), 0o600);
  }

  await writeEnvFile(envPath, next);
  return { ...delta, backupPath };
}

/** 事务级 env 备份之后、停服务之前调用，使回滚还原的是 2.4.4 原文。 */
export async function applyHubEnvMigration(
  installDir: string,
  log: (message: string) => void
): Promise<void> {
  const result = await migrateHubEnv(createInstallLayout(installDir).envPath);
  if (!result.migrated || !result.backupPath) return;
  log(
    t(result.roleRewritten ? 'upgrade.hubEnvMigrated' : 'upgrade.hubEnvKeysDeleted', {
      count: result.hubKeysDeleted,
      backup: result.backupPath,
    })
  );
}
