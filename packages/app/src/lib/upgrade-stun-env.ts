import { copyFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isLegacyDefaultStunList } from '../../../shared/src/net/stun-defaults';
import { t } from '../i18n';
import { readEnvFile, writeEnvFile } from './env-file';
import { ensureDir, pathExists, writeText } from './fs-utils';
import { createInstallLayout } from './install-layout';

const STUN_KEYS = ['VIBETERM_STUN_SERVERS', 'TMEX_STUN_SERVERS'] as const;

export type MigrateStunEnvResult = {
  migrated: boolean;
  /** 相对安装目录的可读备份名（`backups/app.env.<ISO>.stun`），日志用，避免目录搬家后绝对路径失效 */
  backupPath?: string;
};

export function envFileBackupPath(installDir: string, txnId: string): string {
  return join(installDir, 'backups', txnId, 'app.env');
}

/** 已有备份不覆盖：目录迁移随后会改写 app.env，第一份（真正的旧文件）才是要还原的那份。 */
export async function backupEnvFile(installDir: string, txnId: string): Promise<boolean> {
  const source = createInstallLayout(installDir).envPath;
  if (!(await pathExists(source))) return false;
  const target = envFileBackupPath(installDir, txnId);
  if (await pathExists(target)) return true;
  await ensureDir(join(installDir, 'backups', txnId));
  await copyFile(source, target);
  return true;
}

export async function restoreEnvFile(installDir: string, txnId: string): Promise<boolean> {
  const layout = createInstallLayout(installDir);
  const backup = envFileBackupPath(installDir, txnId);
  if (!(await pathExists(backup))) return false;
  await copyFile(backup, layout.envPath);
  return true;
}

/**
 * 升级时去掉 app.env 里冻结的旧内置 STUN 默认，让发行版内置列表生效。
 * 自定义值（不在历史默认串里）原样保留。幂等。
 * 可读备份只记相对名；事务级还原走 `backups/<txnId>/app.env`（见 backupEnvFile）。
 */
export async function migrateStunEnv(envPath: string): Promise<MigrateStunEnvResult> {
  if (!(await pathExists(envPath))) return { migrated: false };

  const values = await readEnvFile(envPath);
  const raw = values.VIBETERM_STUN_SERVERS ?? values.TMEX_STUN_SERVERS;
  if (raw === undefined || !isLegacyDefaultStunList(raw)) {
    return { migrated: false };
  }

  const backupRel = join('backups', `app.env.${new Date().toISOString()}.stun`);
  const backupAbs = join(dirname(envPath), backupRel);
  await ensureDir(dirname(backupAbs));
  await writeText(backupAbs, await readFile(envPath, 'utf8'), 0o600);

  const next = { ...values };
  for (const key of STUN_KEYS) delete next[key];
  await writeEnvFile(envPath, next);
  return { migrated: true, backupPath: backupRel };
}

/** 目录迁移备份 app.env 之后、切 current / 拉起新服务之前调用。 */
export async function applyStunEnvMigration(
  installDir: string,
  log: (message: string) => void
): Promise<void> {
  const result = await migrateStunEnv(createInstallLayout(installDir).envPath);
  if (result.migrated && result.backupPath) {
    log(t('upgrade.stunEnvMigrated', { backup: result.backupPath }));
  }
}
