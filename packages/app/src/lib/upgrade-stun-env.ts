import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isLegacyDefaultStunList } from '../../../shared/src/net/stun-defaults';
import { readEnvFile, writeEnvFile } from './env-file';
import { ensureDir, pathExists, writeText } from './fs-utils';

const STUN_KEYS = ['VIBETERM_STUN_SERVERS', 'TMEX_STUN_SERVERS'] as const;

export type MigrateStunEnvResult = {
  migrated: boolean;
  backupPath?: string;
};

/**
 * 升级时去掉 app.env 里冻结的旧内置 STUN 默认，让发行版内置列表生效。
 * 自定义值（不在历史默认串里）原样保留。幂等。
 */
export async function migrateStunEnv(envPath: string): Promise<MigrateStunEnvResult> {
  if (!(await pathExists(envPath))) return { migrated: false };

  const values = await readEnvFile(envPath);
  const raw = values.VIBETERM_STUN_SERVERS ?? values.TMEX_STUN_SERVERS;
  if (raw === undefined || !isLegacyDefaultStunList(raw)) {
    return { migrated: false };
  }

  const backupPath = join(dirname(envPath), 'backups', `app.env.${new Date().toISOString()}.stun`);
  await ensureDir(dirname(backupPath));
  await writeText(backupPath, await readFile(envPath, 'utf8'), 0o600);

  const next = { ...values };
  for (const key of STUN_KEYS) delete next[key];
  await writeEnvFile(envPath, next);
  return { migrated: true, backupPath };
}
