import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  DEFAULT_RTC_PORT_RANGE,
  DEFAULT_TURN_PORT,
  DEFAULT_TURN_RELAY_PORT_RANGE,
  type PortRange,
} from '../../../shared/src/net/port-plan';
import { t } from '../i18n';
import { readEnvFile, writeEnvFile } from './env-file';
import { ensureDir, pathExists, writeText } from './fs-utils';
import { createInstallLayout } from './install-layout';

const PORT_ENV_WRITE_ORDER = [
  'VIBETERM_RTC_PORT_RANGE',
  'VIBETERM_TURN_PORT',
  'VIBETERM_TURN_RELAY_PORT_RANGE',
] as const;

export type MigratePortEnvResult = {
  written: string[];
  /** 相对安装目录的可读备份名（`backups/app.env.<ISO>.ports`），日志用 */
  backupPath?: string;
};

let lastWrittenKeys: string[] = [];

export function formatPortRangeValue(range: PortRange): string {
  return `${range.begin}-${range.end}`;
}

export function clearWrittenPortEnvKeys(): void {
  lastWrittenKeys = [];
}

export function takeWrittenPortEnvKeys(): string[] {
  const keys = lastWrittenKeys;
  lastWrittenKeys = [];
  return keys;
}

export function printRtcPortRangeFixedNotice(
  writtenKeys: string[],
  log: (message: string) => void
): boolean {
  if (!writtenKeys.includes('VIBETERM_RTC_PORT_RANGE')) return false;
  log(
    t('upgrade.rtcPortRangeFixed', {
      range: formatPortRangeValue(DEFAULT_RTC_PORT_RANGE),
    })
  );
  return true;
}

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim() === '';
}

function rolesIncludeRelay(values: Record<string, string>): boolean {
  return (values.VIBETERM_ROLES ?? '').split(',').some((part) => part.trim() === 'relay');
}

function plannedPortEnvWrites(values: Record<string, string>): Record<string, string> {
  const planned: Record<string, string> = {};
  if (isBlank(values.VIBETERM_RTC_PORT_RANGE)) {
    planned.VIBETERM_RTC_PORT_RANGE = formatPortRangeValue(DEFAULT_RTC_PORT_RANGE);
  }
  if (!rolesIncludeRelay(values)) return planned;
  if (isBlank(values.VIBETERM_TURN_PORT)) {
    planned.VIBETERM_TURN_PORT = String(DEFAULT_TURN_PORT);
  }
  if (isBlank(values.VIBETERM_TURN_RELAY_PORT_RANGE)) {
    planned.VIBETERM_TURN_RELAY_PORT_RANGE = formatPortRangeValue(DEFAULT_TURN_RELAY_PORT_RANGE);
  }
  return planned;
}

function writtenKeysOf(planned: Record<string, string>): string[] {
  return PORT_ENV_WRITE_ORDER.filter((key) => key in planned);
}

/**
 * 升级时把统一 RTC/TURN 默认写入 app.env：缺键（RTC 含空值）才写，已有值不动。
 * 可读备份只记相对名；事务级还原走 `backups/<txnId>/app.env`。
 */
export async function migratePortEnv(envPath: string): Promise<MigratePortEnvResult> {
  if (!(await pathExists(envPath))) return { written: [] };

  const values = await readEnvFile(envPath);
  const planned = plannedPortEnvWrites(values);
  const written = writtenKeysOf(planned);
  if (written.length === 0) return { written };

  const backupRel = join('backups', `app.env.${new Date().toISOString()}.ports`);
  const backupAbs = join(dirname(envPath), backupRel);
  await ensureDir(dirname(backupAbs));
  await writeText(backupAbs, await readFile(envPath, 'utf8'), 0o600);
  await writeEnvFile(envPath, { ...values, ...planned });
  return { written, backupPath: backupRel };
}

/** 目录迁移备份 app.env 之后、切 current / 拉起新服务之前调用。 */
export async function applyPortPlanEnvMigration(
  installDir: string,
  log: (message: string) => void
): Promise<MigratePortEnvResult> {
  const result = await migratePortEnv(createInstallLayout(installDir).envPath);
  lastWrittenKeys = [...result.written];
  if (result.written.length > 0 && result.backupPath) {
    log(
      t('upgrade.portEnvMigrated', { keys: result.written.join(', '), backup: result.backupPath })
    );
  }
  return result;
}
