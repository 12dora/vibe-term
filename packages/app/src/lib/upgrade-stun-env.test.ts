import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LEGACY_DEFAULT_STUN_LISTS } from '../../../shared/src/net/stun-defaults';
import { readEnvFile } from './env-file';
import { pathExists } from './fs-utils';
import { migrateStunEnv } from './upgrade-stun-env';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempEnv(content: string): Promise<{ dir: string; envPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'vibeterm-stun-env-'));
  tempDirs.push(dir);
  const envPath = join(dir, 'app.env');
  await writeFile(envPath, content, { encoding: 'utf8', mode: 0o600 });
  return { dir, envPath };
}

async function stunBackups(dir: string): Promise<string[]> {
  const backupDir = join(dir, 'backups');
  if (!(await pathExists(backupDir))) return [];
  return (await readdir(backupDir)).filter(
    (name) => name.startsWith('app.env.') && name.endsWith('.stun')
  );
}

describe('migrateStunEnv', () => {
  test.each([...LEGACY_DEFAULT_STUN_LISTS])(
    'removes a legacy built-in default and writes a backup: %s',
    async (legacy) => {
      const { dir, envPath } = await tempEnv(
        `GATEWAY_PORT=9883\nVIBETERM_STUN_SERVERS=${legacy}\n`
      );
      const result = await migrateStunEnv(envPath);
      expect(result.migrated).toBe(true);
      expect(result.backupPath).toBeTruthy();
      expect(await pathExists(result.backupPath as string)).toBe(true);
      expect(await readFile(result.backupPath as string, 'utf8')).toContain(
        `VIBETERM_STUN_SERVERS=${legacy}`
      );
      const env = await readEnvFile(envPath);
      expect(env.VIBETERM_STUN_SERVERS).toBeUndefined();
      expect(env.TMEX_STUN_SERVERS).toBeUndefined();
      expect(env.GATEWAY_PORT).toBe('9883');
      expect(await stunBackups(dir)).toHaveLength(1);
    }
  );

  test('keeps a custom STUN list and does not write a backup', async () => {
    const { dir, envPath } = await tempEnv(
      'GATEWAY_PORT=9883\nVIBETERM_STUN_SERVERS=stun:custom.example:3478\n'
    );
    const result = await migrateStunEnv(envPath);
    expect(result).toEqual({ migrated: false });
    expect(await stunBackups(dir)).toEqual([]);
    expect((await readEnvFile(envPath)).VIBETERM_STUN_SERVERS).toBe('stun:custom.example:3478');
  });

  test('keeps none/off (explicit disable)', async () => {
    const { envPath } = await tempEnv('VIBETERM_STUN_SERVERS=none\n');
    expect(await migrateStunEnv(envPath)).toEqual({ migrated: false });
    expect((await readEnvFile(envPath)).VIBETERM_STUN_SERVERS).toBe('none');
  });

  test('missing key is a no-op', async () => {
    const { dir, envPath } = await tempEnv('GATEWAY_PORT=9883\n');
    expect(await migrateStunEnv(envPath)).toEqual({ migrated: false });
    expect(await stunBackups(dir)).toEqual([]);
    expect((await readEnvFile(envPath)).GATEWAY_PORT).toBe('9883');
  });

  test('missing file is a no-op', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vibeterm-stun-env-missing-'));
    tempDirs.push(dir);
    expect(await migrateStunEnv(join(dir, 'app.env'))).toEqual({ migrated: false });
    expect(await stunBackups(dir)).toEqual([]);
  });

  test('removes the legacy TMEX_STUN_SERVERS spelling', async () => {
    const { dir, envPath } = await tempEnv(
      'GATEWAY_PORT=9883\nTMEX_STUN_SERVERS=stun:stun.l.google.com:19302\n'
    );
    const result = await migrateStunEnv(envPath);
    expect(result.migrated).toBe(true);
    const text = await readFile(envPath, 'utf8');
    expect(text).not.toContain('STUN_SERVERS');
    expect(text).toContain('GATEWAY_PORT=9883');
    expect(await readFile(result.backupPath as string, 'utf8')).toContain('TMEX_STUN_SERVERS=');
    expect(await stunBackups(dir)).toHaveLength(1);
  });

  test('is idempotent: a second run does not rewrite or add another backup', async () => {
    const { dir, envPath } = await tempEnv(
      'VIBETERM_STUN_SERVERS=stun:stun.l.google.com:19302,stun:stun.cloudflare.com:3478\n'
    );
    const first = await migrateStunEnv(envPath);
    expect(first.migrated).toBe(true);
    const afterFirst = await readFile(envPath, 'utf8');
    const second = await migrateStunEnv(envPath);
    expect(second).toEqual({ migrated: false });
    expect(await readFile(envPath, 'utf8')).toBe(afterFirst);
    expect(await stunBackups(dir)).toHaveLength(1);
  });
});
