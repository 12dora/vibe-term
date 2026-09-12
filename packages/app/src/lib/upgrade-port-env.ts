import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  DEFAULT_RTC_PORT_RANGE,
  DEFAULT_TURN_PORT,
  DEFAULT_TURN_RELAY_PORT_RANGE,
  LEGACY_TURN_PORT,
  LEGACY_TURN_RELAY_PORT_RANGE,
  type PortRange,
  type PortRole,
  defaultRtcPortRange,
  rolesIncludeRelay,
} from '../../../shared/src/net/port-plan';
import { isVibeTermRoleName } from '../../../shared/src/roles';
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

export function printUdpSegmentUnifiedNotice(
  writtenKeys: string[],
  log: (message: string) => void
): boolean {
  if (writtenKeys.length === 0) return false;
  log(t('upgrade.udpSegmentUnified'));
  return true;
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

function trimmed(value: string | undefined): string {
  return value?.trim() ?? '';
}

function isOffOrZero(value: string | undefined): boolean {
  const text = trimmed(value).toLowerCase();
  return text === '0' || text === 'off';
}

function portRoleOf(values: Record<string, string>): PortRole {
  const raw = trimmed(values.VIBETERM_ROLES);
  return isVibeTermRoleName(raw) ? raw : 'standalone';
}

function equalsLegacy(value: string | undefined, legacy: string): boolean {
  return trimmed(value) === legacy;
}

function plannedRtcRange(values: Record<string, string>, role: PortRole): string | undefined {
  const next = formatPortRangeValue(defaultRtcPortRange(role));
  const current = trimmed(values.VIBETERM_RTC_PORT_RANGE);
  if (current === '') return next;
  if (
    rolesIncludeRelay(values.VIBETERM_ROLES ?? '') &&
    current === formatPortRangeValue(DEFAULT_RTC_PORT_RANGE)
  ) {
    return next;
  }
  return undefined;
}

function plannedTurnPort(values: Record<string, string>): string | undefined {
  if (!rolesIncludeRelay(values.VIBETERM_ROLES ?? '')) return undefined;
  if (isOffOrZero(values.VIBETERM_TURN_PORT)) return undefined;
  if (
    isBlank(values.VIBETERM_TURN_PORT) ||
    equalsLegacy(values.VIBETERM_TURN_PORT, String(LEGACY_TURN_PORT))
  ) {
    return String(DEFAULT_TURN_PORT);
  }
  return undefined;
}

function plannedTurnRelayRange(values: Record<string, string>): string | undefined {
  if (!rolesIncludeRelay(values.VIBETERM_ROLES ?? '')) return undefined;
  if (isOffOrZero(values.VIBETERM_TURN_RELAY_PORT_RANGE)) return undefined;
  const legacy = formatPortRangeValue(LEGACY_TURN_RELAY_PORT_RANGE);
  if (
    isBlank(values.VIBETERM_TURN_RELAY_PORT_RANGE) ||
    equalsLegacy(values.VIBETERM_TURN_RELAY_PORT_RANGE, legacy)
  ) {
    return formatPortRangeValue(DEFAULT_TURN_RELAY_PORT_RANGE);
  }
  return undefined;
}

function plannedPortEnvWrites(values: Record<string, string>): Record<string, string> {
  const planned: Record<string, string> = {};
  const role = portRoleOf(values);
  const rtc = plannedRtcRange(values, role);
  if (rtc !== undefined) planned.VIBETERM_RTC_PORT_RANGE = rtc;
  const turnPort = plannedTurnPort(values);
  if (turnPort !== undefined) planned.VIBETERM_TURN_PORT = turnPort;
  const turnRelay = plannedTurnRelayRange(values);
  if (turnRelay !== undefined) planned.VIBETERM_TURN_RELAY_PORT_RANGE = turnRelay;
  return planned;
}

function writtenKeysOf(planned: Record<string, string>): string[] {
  return PORT_ENV_WRITE_ORDER.filter((key) => key in planned);
}

/**
 * 升级时把统一 UDP 段写入 app.env：空值与恰好等于旧默认才改，自定义 / 0 / off 不动。
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
