import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_RTC_PORT_RANGE,
  DEFAULT_TURN_PORT,
  DEFAULT_TURN_RELAY_PORT_RANGE,
} from '../../../shared/src/net/port-plan';
import { setLang, t } from '../i18n';
import { readEnvFile } from './env-file';
import { pathExists } from './fs-utils';
import {
  applyPortPlanEnvMigration,
  clearWrittenPortEnvKeys,
  formatPortRangeValue,
  migratePortEnv,
  printRtcPortRangeFixedNotice,
  takeWrittenPortEnvKeys,
} from './upgrade-port-env';
import { backupEnvFile, restoreEnvFile } from './upgrade-stun-env';

const tempDirs: string[] = [];
const RTC_DEFAULT = formatPortRangeValue(DEFAULT_RTC_PORT_RANGE);
const TURN_RELAY_DEFAULT = formatPortRangeValue(DEFAULT_TURN_RELAY_PORT_RANGE);

afterEach(async () => {
  clearWrittenPortEnvKeys();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempEnv(content: string): Promise<{ dir: string; envPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'vibeterm-port-env-'));
  tempDirs.push(dir);
  const envPath = join(dir, 'app.env');
  await writeFile(envPath, content, { encoding: 'utf8', mode: 0o600 });
  return { dir, envPath };
}

async function portBackups(dir: string): Promise<string[]> {
  const backupDir = join(dir, 'backups');
  if (!(await pathExists(backupDir))) return [];
  return (await readdir(backupDir)).filter(
    (name) => name.startsWith('app.env.') && name.endsWith('.ports')
  );
}

describe('migratePortEnv', () => {
  test('writes the unified RTC range when the key is missing', async () => {
    const { dir, envPath } = await tempEnv('GATEWAY_PORT=9883\nVIBETERM_PEER_PORT=39001\n');
    const result = await migratePortEnv(envPath);
    expect(result.written).toEqual(['VIBETERM_RTC_PORT_RANGE']);
    expect(result.backupPath).toMatch(/^backups\/app\.env\..+\.ports$/);
    expect(result.backupPath).not.toContain(dir);
    const backupAbs = join(dir, result.backupPath as string);
    expect(await pathExists(backupAbs)).toBe(true);
    expect(await readFile(backupAbs, 'utf8')).not.toContain('VIBETERM_RTC_PORT_RANGE');
    const env = await readEnvFile(envPath);
    expect(env.VIBETERM_RTC_PORT_RANGE).toBe(RTC_DEFAULT);
    expect(env.GATEWAY_PORT).toBe('9883');
    expect(env.VIBETERM_PEER_PORT).toBe('39001');
    expect(env.VIBETERM_TURN_PORT).toBeUndefined();
    expect(await portBackups(dir)).toHaveLength(1);
  });

  test('writes the unified RTC range when the key is empty', async () => {
    const { envPath } = await tempEnv('GATEWAY_PORT=9883\nVIBETERM_RTC_PORT_RANGE=\n');
    const result = await migratePortEnv(envPath);
    expect(result.written).toEqual(['VIBETERM_RTC_PORT_RANGE']);
    expect((await readEnvFile(envPath)).VIBETERM_RTC_PORT_RANGE).toBe(RTC_DEFAULT);
  });

  test('keeps a custom RTC range and does not write a backup', async () => {
    const { dir, envPath } = await tempEnv(
      'GATEWAY_PORT=9883\nVIBETERM_RTC_PORT_RANGE=31000-31099\n'
    );
    const result = await migratePortEnv(envPath);
    expect(result).toEqual({ written: [] });
    expect(await portBackups(dir)).toEqual([]);
    expect((await readEnvFile(envPath)).VIBETERM_RTC_PORT_RANGE).toBe('31000-31099');
  });

  test('relay role missing TURN keys writes 3478 and the relay range', async () => {
    const { dir, envPath } = await tempEnv(
      'GATEWAY_PORT=9883\nVIBETERM_ROLES=relay\nVIBETERM_RTC_PORT_RANGE=31000-31099\n'
    );
    const result = await migratePortEnv(envPath);
    expect(result.written).toEqual(['VIBETERM_TURN_PORT', 'VIBETERM_TURN_RELAY_PORT_RANGE']);
    const env = await readEnvFile(envPath);
    expect(env.VIBETERM_TURN_PORT).toBe(String(DEFAULT_TURN_PORT));
    expect(env.VIBETERM_TURN_RELAY_PORT_RANGE).toBe(TURN_RELAY_DEFAULT);
    expect(env.VIBETERM_RTC_PORT_RANGE).toBe('31000-31099');
    expect(await portBackups(dir)).toHaveLength(1);
  });

  test('relay,node missing RTC and TURN writes all three keys', async () => {
    const { envPath } = await tempEnv('VIBETERM_ROLES=relay,node\nGATEWAY_PORT=9883\n');
    const result = await migratePortEnv(envPath);
    expect(result.written).toEqual([
      'VIBETERM_RTC_PORT_RANGE',
      'VIBETERM_TURN_PORT',
      'VIBETERM_TURN_RELAY_PORT_RANGE',
    ]);
    const env = await readEnvFile(envPath);
    expect(env.VIBETERM_RTC_PORT_RANGE).toBe(RTC_DEFAULT);
    expect(env.VIBETERM_TURN_PORT).toBe(String(DEFAULT_TURN_PORT));
    expect(env.VIBETERM_TURN_RELAY_PORT_RANGE).toBe(TURN_RELAY_DEFAULT);
  });

  test('keeps custom TURN keys on a relay and does not rewrite them', async () => {
    const { dir, envPath } = await tempEnv(
      [
        'VIBETERM_ROLES=relay,node',
        'VIBETERM_RTC_PORT_RANGE=31000-31099',
        'VIBETERM_TURN_PORT=53478',
        'VIBETERM_TURN_RELAY_PORT_RANGE=50000-50099',
        '',
      ].join('\n')
    );
    expect(await migratePortEnv(envPath)).toEqual({ written: [] });
    expect(await portBackups(dir)).toEqual([]);
    const env = await readEnvFile(envPath);
    expect(env.VIBETERM_TURN_PORT).toBe('53478');
    expect(env.VIBETERM_TURN_RELAY_PORT_RANGE).toBe('50000-50099');
    expect(env.VIBETERM_RTC_PORT_RANGE).toBe('31000-31099');
  });

  test('non-relay roles do not receive TURN keys', async () => {
    for (const roles of ['standalone', 'node', 'hub,node']) {
      const { dir, envPath } = await tempEnv(`GATEWAY_PORT=9883\nVIBETERM_ROLES=${roles}\n`);
      const result = await migratePortEnv(envPath);
      expect(result.written).toEqual(['VIBETERM_RTC_PORT_RANGE']);
      const env = await readEnvFile(envPath);
      expect(env.VIBETERM_TURN_PORT).toBeUndefined();
      expect(env.VIBETERM_TURN_RELAY_PORT_RANGE).toBeUndefined();
      expect(await portBackups(dir)).toHaveLength(1);
    }
  });

  test('writes only the missing TURN key when the other is already set', async () => {
    const { envPath } = await tempEnv(
      [
        'VIBETERM_ROLES=relay',
        'VIBETERM_RTC_PORT_RANGE=31000-31099',
        'VIBETERM_TURN_PORT=3478',
        '',
      ].join('\n')
    );
    const result = await migratePortEnv(envPath);
    expect(result.written).toEqual(['VIBETERM_TURN_RELAY_PORT_RANGE']);
    const env = await readEnvFile(envPath);
    expect(env.VIBETERM_TURN_PORT).toBe('3478');
    expect(env.VIBETERM_TURN_RELAY_PORT_RANGE).toBe(TURN_RELAY_DEFAULT);
  });

  test('missing file is a no-op', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vibeterm-port-env-missing-'));
    tempDirs.push(dir);
    expect(await migratePortEnv(join(dir, 'app.env'))).toEqual({ written: [] });
    expect(await portBackups(dir)).toEqual([]);
  });

  test('is idempotent: a second run does not rewrite or add another backup', async () => {
    const { dir, envPath } = await tempEnv('GATEWAY_PORT=9883\nVIBETERM_ROLES=node\n');
    const first = await migratePortEnv(envPath);
    expect(first.written).toEqual(['VIBETERM_RTC_PORT_RANGE']);
    const afterFirst = await readFile(envPath, 'utf8');
    const second = await migratePortEnv(envPath);
    expect(second).toEqual({ written: [] });
    expect(await readFile(envPath, 'utf8')).toBe(afterFirst);
    expect(await portBackups(dir)).toHaveLength(1);
  });

  test('never overwrites GATEWAY_PORT or a custom peer port', async () => {
    const { envPath } = await tempEnv(
      'GATEWAY_PORT=19999\nVIBETERM_PEER_PORT=41001\nVIBETERM_ROLES=node\n'
    );
    await migratePortEnv(envPath);
    const env = await readEnvFile(envPath);
    expect(env.GATEWAY_PORT).toBe('19999');
    expect(env.VIBETERM_PEER_PORT).toBe('41001');
    expect(env.VIBETERM_RTC_PORT_RANGE).toBe(RTC_DEFAULT);
  });
});

describe('txn app.env backup', () => {
  test('backupEnvFile copies into backups/<txnId>/app.env and restoreEnvFile puts it back', async () => {
    const { dir, envPath } = await tempEnv('GATEWAY_PORT=9883\nVIBETERM_ROLES=node\n');
    expect(await backupEnvFile(dir, 'txn-ports')).toBe(true);
    await migratePortEnv(envPath);
    expect((await readEnvFile(envPath)).VIBETERM_RTC_PORT_RANGE).toBe(RTC_DEFAULT);

    expect(await restoreEnvFile(dir, 'txn-ports')).toBe(true);
    const env = await readEnvFile(envPath);
    expect(env.VIBETERM_RTC_PORT_RANGE).toBeUndefined();
    expect(env.GATEWAY_PORT).toBe('9883');
  });
});

describe('applyPortPlanEnvMigration', () => {
  test('logs the keys written and records them for the end-of-upgrade notice', async () => {
    setLang('en');
    const { dir } = await tempEnv('GATEWAY_PORT=9883\nVIBETERM_ROLES=node\n');
    const logs: string[] = [];
    const result = await applyPortPlanEnvMigration(dir, (line) => logs.push(line));
    expect(result.written).toEqual(['VIBETERM_RTC_PORT_RANGE']);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toBe(
      t('upgrade.portEnvMigrated', {
        keys: 'VIBETERM_RTC_PORT_RANGE',
        backup: result.backupPath,
      })
    );
    const notices: string[] = [];
    expect(
      printRtcPortRangeFixedNotice(takeWrittenPortEnvKeys(), (line) => notices.push(line))
    ).toBe(true);
    expect(notices).toEqual([t('upgrade.rtcPortRangeFixed', { range: RTC_DEFAULT })]);
    expect(takeWrittenPortEnvKeys()).toEqual([]);
  });

  test('skips the log when nothing is written', async () => {
    const { dir } = await tempEnv(`GATEWAY_PORT=9883\nVIBETERM_RTC_PORT_RANGE=${RTC_DEFAULT}\n`);
    const logs: string[] = [];
    expect(await applyPortPlanEnvMigration(dir, (line) => logs.push(line))).toEqual({
      written: [],
    });
    expect(logs).toEqual([]);
    expect(takeWrittenPortEnvKeys()).toEqual([]);
  });

  test('does not print the RTC notice when only TURN keys were written', async () => {
    setLang('en');
    const { dir } = await tempEnv('VIBETERM_ROLES=relay\nVIBETERM_RTC_PORT_RANGE=31000-31099\n');
    const logs: string[] = [];
    const result = await applyPortPlanEnvMigration(dir, (line) => logs.push(line));
    expect(result.written).toEqual(['VIBETERM_TURN_PORT', 'VIBETERM_TURN_RELAY_PORT_RANGE']);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('VIBETERM_TURN_PORT');
    const notices: string[] = [];
    expect(
      printRtcPortRangeFixedNotice(takeWrittenPortEnvKeys(), (line) => notices.push(line))
    ).toBe(false);
    expect(notices).toEqual([]);
  });

  test('zh-CN notice is terse and avoids 你/您', () => {
    setLang('zh-CN');
    expect(t('upgrade.rtcPortRangeFixed', { range: RTC_DEFAULT })).toBe(
      `已固定 P2P 端口段 ${RTC_DEFAULT}/udp，请在防火墙放行`
    );
    expect(t('upgrade.rtcPortRangeFixed', { range: RTC_DEFAULT })).not.toContain('你');
    expect(t('upgrade.rtcPortRangeFixed', { range: RTC_DEFAULT })).not.toContain('您');
    expect(
      t('upgrade.portEnvMigrated', { keys: 'VIBETERM_RTC_PORT_RANGE', backup: 'x' })
    ).not.toContain('你');
    setLang('en');
    expect(t('upgrade.rtcPortRangeFixed', { range: RTC_DEFAULT })).toBe(
      `P2P port range fixed to ${RTC_DEFAULT}/udp — allow it in the firewall`
    );
  });
});
