import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { t } from '../i18n';
import { readEnvFile } from './env-file';
import { pathExists } from './fs-utils';
import { applyHubEnvMigration, migrateHubEnv } from './upgrade-hub-env';
import { backupEnvFile, restoreEnvFile } from './upgrade-stun-env';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempEnv(content: string): Promise<{ dir: string; envPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'vibeterm-hub-env-'));
  tempDirs.push(dir);
  const envPath = join(dir, 'app.env');
  await writeFile(envPath, content, { encoding: 'utf8', mode: 0o600 });
  return { dir, envPath };
}

async function hubBackups(dir: string): Promise<string[]> {
  const backupDir = join(dir, 'backups');
  if (!(await pathExists(backupDir))) return [];
  return (await readdir(backupDir)).filter(
    (name) => name.startsWith('app.env.') && name.endsWith('.hub')
  );
}

const LEGACY_HUB_ENV = [
  'VIBETERM_ROLES=hub,node',
  'VIBETERM_HUB_URL=https://hub.example',
  'VIBETERM_HUB_PUBLIC_URL=https://pub.example',
  'VIBETERM_HUB_MODE=active',
  'VIBETERM_PEER_PORT=39001',
  'OTHER=keep',
  '',
].join('\n');

describe('migrateHubEnv', () => {
  test('rewrites hub,node, strips HUB keys, and writes a backup of the original', async () => {
    const { dir, envPath } = await tempEnv(LEGACY_HUB_ENV);
    const result = await migrateHubEnv(envPath);
    expect(result.migrated).toBe(true);
    expect(result.roleRewritten).toBe(true);
    expect(result.hubKeysDeleted).toBe(3);
    expect(result.backupPath).toMatch(/^backups\/app\.env\..+\.hub$/);
    const backupAbs = join(dir, result.backupPath as string);
    expect(await pathExists(backupAbs)).toBe(true);
    expect(await readFile(backupAbs, 'utf8')).toContain('VIBETERM_ROLES=hub,node');
    expect(await readFile(backupAbs, 'utf8')).toContain('VIBETERM_HUB_URL=https://hub.example');
    const env = await readEnvFile(envPath);
    expect(env.VIBETERM_ROLES).toBe('node');
    expect(env.VIBETERM_HUB_URL).toBeUndefined();
    expect(env.VIBETERM_HUB_PUBLIC_URL).toBeUndefined();
    expect(env.VIBETERM_HUB_MODE).toBeUndefined();
    expect(env.VIBETERM_PEER_PORT).toBe('39001');
    expect(env.OTHER).toBe('keep');
    expect(await hubBackups(dir)).toHaveLength(1);
  });

  test('maps hub, node with internal spaces', async () => {
    const { envPath } = await tempEnv('VIBETERM_ROLES=hub, node\nVIBETERM_PEER_PORT=39001\n');
    const result = await migrateHubEnv(envPath);
    expect(result.migrated).toBe(true);
    expect(result.roleRewritten).toBe(true);
    expect((await readEnvFile(envPath)).VIBETERM_ROLES).toBe('node');
  });

  test('is a no-op when there is nothing to rewrite', async () => {
    const { dir, envPath } = await tempEnv('VIBETERM_ROLES=node\nVIBETERM_PEER_PORT=39001\n');
    const result = await migrateHubEnv(envPath);
    expect(result).toEqual({ migrated: false, roleRewritten: false, hubKeysDeleted: 0 });
    expect(await hubBackups(dir)).toEqual([]);
    expect((await readEnvFile(envPath)).VIBETERM_ROLES).toBe('node');
  });

  test('missing file is a no-op', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vibeterm-hub-env-missing-'));
    tempDirs.push(dir);
    expect(await migrateHubEnv(join(dir, 'app.env'))).toEqual({
      migrated: false,
      roleRewritten: false,
      hubKeysDeleted: 0,
    });
  });

  test('is idempotent: a second run does not rewrite or add another backup', async () => {
    const { dir, envPath } = await tempEnv(LEGACY_HUB_ENV);
    const first = await migrateHubEnv(envPath);
    expect(first.migrated).toBe(true);
    const afterFirst = await readFile(envPath, 'utf8');
    const second = await migrateHubEnv(envPath);
    expect(second).toEqual({ migrated: false, roleRewritten: false, hubKeysDeleted: 0 });
    expect(await readFile(envPath, 'utf8')).toBe(afterFirst);
    expect(await hubBackups(dir)).toHaveLength(1);
  });
});

describe('txn app.env backup vs hub rewrite', () => {
  test('rollback restores the original hub,node env after migrateHubEnv', async () => {
    const { dir, envPath } = await tempEnv(LEGACY_HUB_ENV);
    expect(await backupEnvFile(dir, 'txn-hub')).toBe(true);
    await migrateHubEnv(envPath);
    expect((await readEnvFile(envPath)).VIBETERM_ROLES).toBe('node');
    expect((await readEnvFile(envPath)).VIBETERM_HUB_URL).toBeUndefined();

    expect(await restoreEnvFile(dir, 'txn-hub')).toBe(true);
    const restored = await readEnvFile(envPath);
    expect(restored.VIBETERM_ROLES).toBe('hub,node');
    expect(restored.VIBETERM_HUB_URL).toBe('https://hub.example');
    expect(restored.VIBETERM_HUB_PUBLIC_URL).toBe('https://pub.example');
    expect(restored.VIBETERM_HUB_MODE).toBe('active');
  });
});

describe('applyHubEnvMigration notice', () => {
  test('prints the i18n notice with the backup path when it rewrote anything', async () => {
    const { dir } = await tempEnv(LEGACY_HUB_ENV);
    const logs: string[] = [];
    await applyHubEnvMigration(dir, (line) => logs.push(line));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toBe(
      t('upgrade.hubEnvMigrated', {
        count: 3,
        backup: (await hubBackups(dir))[0] ? `backups/${(await hubBackups(dir))[0]}` : '',
      })
    );
    expect(logs[0]).toContain('hub,node');
    expect(logs[0]).toContain('vibeterm relay join');
    expect(logs[0]).toContain('3');
  });

  test('prints nothing when there is nothing to rewrite', async () => {
    const { dir } = await tempEnv('VIBETERM_ROLES=node\n');
    const logs: string[] = [];
    await applyHubEnvMigration(dir, (line) => logs.push(line));
    expect(logs).toEqual([]);
  });
});
